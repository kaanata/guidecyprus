/**
 * Password hashing for the email-password auth provider.
 *
 * Uses PBKDF2 via the Web Crypto API. We use PBKDF2 instead of argon2 / scrypt
 * because Cloudflare's workerd runtime disallows `WebAssembly.compile()` —
 * every wasm-based KDF (argon2, scrypt, bcrypt) fails to load. PBKDF2 over
 * Web Crypto is the only KDF that runs unchanged in both Vitest-pool-workers
 * tests and the production Cloudflare Worker runtime.
 *
 * Parameters chosen to match the philately-app project (same KDF, same shape):
 *   - algorithm: SHA-256
 *   - iterations: 600,000 (OWASP 2023 minimum for PBKDF2-SHA-256)
 *   - salt: 16 random bytes (per password, never reused)
 *   - derived key length: 32 bytes
 *
 * Storage format (single ASCII string):
 *
 *     $pbkdf2-sha256$600000$<salt-b64url>$<hash-b64url>
 *
 * The leading `$pbkdf2-sha256$` prefix lets us migrate to argon2 or scrypt in
 * the future by switching the prefix; old hashes are still verifiable.
 */

const ALGO = "PBKDF2";
const HASH = "SHA-256";
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = "$pbkdf2-sha256$600000$";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Uint8Array {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveBits(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: ALGO },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: ALGO, hash: HASH, salt: salt as BufferSource, iterations: ITERATIONS },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a plaintext password for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(password, salt);
  return `${PREFIX}${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns `true` on match, `false` otherwise. Does NOT throw on malformed
 * stored hashes — that's indistinguishable from a wrong password from the
 * caller's perspective and avoids leaking format details via timing.
 *
 * Constant-time comparison defends against timing side-channels on the hash
 * bytes. The early return on a malformed hash is fine: the user would have
 * triggered the same code path with a wrong password anyway.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(PREFIX)) return false;
  const body = stored.slice(PREFIX.length);
  const parts = body.split("$");
  if (parts.length !== 2) return false;
  const [saltB64, hashB64] = parts as [string, string];

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(saltB64);
    expected = fromBase64Url(hashB64);
  } catch {
    return false;
  }

  if (expected.length !== KEY_BYTES) return false;

  const derived = await deriveBits(password, salt);
  return constantTimeEqual(derived, expected);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Validate a password against minimum policy. */
export function validatePasswordStrength(password: string): { ok: true } | { ok: false; reason: string } {
  if (password.length < 12) return { ok: false, reason: "Password must be at least 12 characters." };
  if (password.length > 256) return { ok: false, reason: "Password is too long." };
  // Soft character-class requirement: encourage non-trivial entropy.
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigitOrSymbol = /[\d\W_]/.test(password);
  if (!hasLetter || !hasDigitOrSymbol) {
    return { ok: false, reason: "Password must include both letters and at least one digit or symbol." };
  }
  return { ok: true };
}
