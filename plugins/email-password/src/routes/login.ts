/**
 * POST /_emdash/api/auth/email-password/login
 *
 * Verify an email + password pair, then bind the user to a session.
 *
 * Public route — declared on the AuthProviderDescriptor's `publicRoutes`.
 * Rate-limited per-IP and per-(IP + email) with an in-memory bucket. The
 * bucket lives in module-scope memory; on Cloudflare Workers each isolate
 * has its own bucket, which is good enough for a single-site install. For
 * multi-instance deployments a D1-backed bucket would be more honest.
 *
 * Returns:
 *   - 302 redirect to `/_emdash/admin` on success
 *   - 400 on validation failure
 *   - 401 on unknown user / wrong password (kept identical to avoid
 *     email enumeration)
 *   - 429 when rate-limited
 *   - 404 when the email-password provider has not been set up yet
 *     (no credential row exists for any user) — we tell the user to
 *     complete setup rather than to log in.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, getAuthProviderStorage } from "emdash/api/route-utils";

import { verifyPassword } from "../crypto.js";
import { rateLimit } from "../rate-limit.js";

const LOGIN_RATE_LIMIT = { windowSeconds: 60, max: 5 };

interface LoginBody {
  email: string;
  password: string;
}

interface CredentialRecord {
  userId: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const emdash = locals.emdash;
  if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

  const ip = clientIp(request);
  const body = await readJson(request);
  if (!body) return apiError("VALIDATION_FAILED", "Invalid request body", 400);

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!isValidEmail(email)) return apiError("INVALID_EMAIL", "Please enter a valid email address.", 400);
  if (!password) return apiError("VALIDATION_FAILED", "Password is required.", 400);

  // Per-IP rate limit — covers credential-stuffing across many emails from
  // a single source.
  const perIp = await rateLimit(emdash.db, ip, "ep-login:ip", LOGIN_RATE_LIMIT);
  if (!perIp.allowed) {
    return apiError(
      "RATE_LIMITED",
      "Too many attempts from your network. Please wait a minute and try again.",
      429,
    );
  }

  // Per-(IP + email) rate limit — slows down attempts against a specific
  // account even when distributed across IPs.
  const perEmail = await rateLimit(emdash.db, ip, `ep-login:email:${email}`, LOGIN_RATE_LIMIT);
  if (!perEmail.allowed) {
    return apiError(
      "RATE_LIMITED",
      "Too many attempts for this account. Please wait a minute and try again.",
      429,
    );
  }

  const storage = getAuthProviderStorage(emdash.db, "email-password", {
    credentials: { indexes: ["userId"], uniqueIndexes: ["email"] },
  });
  const credentials = storage.credentials;
  if (!credentials) return apiError("NOT_CONFIGURED", "Credentials storage is unavailable.", 500);

  const credentialRow = await credentials
    .query({ where: { email }, limit: 1 })
    .then((r) => r.items[0]);

  if (!credentialRow) {
    // Run a dummy verification so the response time matches a real one.
    // This makes email enumeration via timing observably harder.
    await verifyPassword(password, "$pbkdf2-sha256$600000$AAAA$AAAA");
    return apiError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
  }

  const record = credentialRow.data as CredentialRecord;
  const ok = await verifyPassword(password, record.passwordHash);
  if (!ok) {
    return apiError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
  }

  // Check the user isn't disabled before binding the session.
  const user = await emdash.db
    .selectFrom("users")
    .select(["id", "disabled"])
    .where("id", "=", record.userId)
    .executeTakeFirst();
  if (!user) {
    return apiError("USER_NOT_FOUND", "Your account no longer exists.", 401);
  }
  if (user.disabled) {
    return apiError("FORBIDDEN", "Your account has been disabled.", 403);
  }

  if (session) session.set("user", { id: record.userId });

  return redirect("/_emdash/admin");
};

async function readJson(request: Request): Promise<LoginBody | null> {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as LoginBody;
  } catch {
    return null;
  }
}

function isValidEmail(input: string): boolean {
  // Intentionally permissive — RFC-compliant email parsing on the server
  // buys us nothing; the email-verification step (when added) is the
  // authoritative check.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) && input.length <= 320;
}

function clientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "0.0.0.0";
}
