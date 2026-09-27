/**
 * GET  /_emdash/api/auth/email-password/password
 * POST /_emdash/api/auth/email-password/password
 *
 * Let a signed-in user set (first time) or change their own password.
 * This is how a user who signed up with a passkey or magic link — which
 * includes the first admin once setup is complete — gets a password.
 *
 * This route is deliberately NOT listed in the descriptor's `publicRoutes`,
 * so EmDash's auth middleware treats it like its own private API routes
 * (e.g. `/_emdash/api/auth/passkey/register/options`):
 *   - the session is resolved and the full user is placed on `locals.user`;
 *     no session → 401 before this handler runs, disabled user → 403;
 *   - state-changing requests must carry `X-EmDash-Request: 1` (CSRF).
 * The handler re-checks both anyway so it stays safe if the route is ever
 * made public by mistake.
 *
 * GET returns `{ hasPassword, email }` for the current user so the admin
 * page can show "Set password" or "Change password".
 *
 * POST body: `{ newPassword, currentPassword? }`.
 *   - The credential is always the caller's own: it is keyed by
 *     `locals.user.id` and `locals.user.email`; nothing in the body can
 *     name another account.
 *   - If a credential already exists, `currentPassword` must verify.
 *   - If none exists, the password is set without one — the session
 *     already proves who the user is.
 *   - Bearer-token (API / OAuth token) callers are refused; changing a
 *     password needs an interactive session.
 *
 * Returns `{ success: true, data: { hasPassword: true, changed } }`, or the
 * usual `{ success: false, error: { code, message } }`.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess, getAuthProviderStorage } from "emdash/api/route-utils";

import { hashPassword, validatePasswordStrength, verifyPassword } from "../crypto.js";
import { rateLimit } from "../rate-limit.js";

// Per user, across all IPs: caps current-password guessing from a hijacked
// session. Per IP: caps one source cycling through many sessions.
const PASSWORD_USER_RATE_LIMIT = { windowSeconds: 900, max: 5 };
const PASSWORD_IP_RATE_LIMIT = { windowSeconds: 900, max: 20 };

interface PasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

interface CredentialRecord {
  userId: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt?: string;
}

interface SessionUser {
  id: string;
  email: string;
  disabled?: boolean;
}

export const GET: APIRoute = async ({ locals }) => {
  const emdash = locals.emdash;
  if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

  const denied = requireSessionUser(locals);
  if (denied) return denied;
  const user = locals.user as SessionUser;

  const credentials = credentialStore(emdash.db);
  if (!credentials) return apiError("NOT_CONFIGURED", "Credentials storage is unavailable.", 500);

  const own = await findOwnCredential(credentials, user.id);
  return apiSuccess({ hasPassword: own !== null, email: normaliseEmail(user.email) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const emdash = locals.emdash;
  if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

  const denied = requireSessionUser(locals);
  if (denied) return denied;
  const user = locals.user as SessionUser;

  // Same CSRF rule as EmDash's authenticated API routes: browsers cannot
  // send a custom header cross-origin without a CORS preflight we never allow.
  if (request.headers.get("X-EmDash-Request") !== "1") {
    return apiError("CSRF_REJECTED", "Missing required header", 403);
  }

  const perUser = await rateLimit(emdash.db, `user:${user.id}`, "ep-password", PASSWORD_USER_RATE_LIMIT);
  if (!perUser.allowed) {
    return apiError(
      "RATE_LIMITED",
      "Too many password attempts. Please wait a few minutes and try again.",
      429,
    );
  }
  const perIp = await rateLimit(emdash.db, clientIp(request), "ep-password:ip", PASSWORD_IP_RATE_LIMIT);
  if (!perIp.allowed) {
    return apiError(
      "RATE_LIMITED",
      "Too many attempts from your network. Please wait a few minutes and try again.",
      429,
    );
  }

  const body = await readJson(request);
  if (!body) return apiError("VALIDATION_FAILED", "Invalid request body", 400);

  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";

  const passwordCheck = validatePasswordStrength(newPassword);
  if (!passwordCheck.ok) return apiError("WEAK_PASSWORD", passwordCheck.reason, 400);

  const email = normaliseEmail(user.email);
  if (!email) return apiError("VALIDATION_FAILED", "Your account has no email address.", 400);

  const credentials = credentialStore(emdash.db);
  if (!credentials) return apiError("NOT_CONFIGURED", "Credentials storage is unavailable.", 500);

  const own = await findOwnCredential(credentials, user.id);

  if (own) {
    if (!currentPassword) {
      return apiError("CURRENT_PASSWORD_REQUIRED", "Enter your current password.", 400);
    }
    const ok = await verifyPassword(currentPassword, own.data.passwordHash);
    if (!ok) return apiError("INVALID_CREDENTIALS", "Current password is incorrect.", 401);
    if (currentPassword === newPassword) {
      return apiError("VALIDATION_FAILED", "The new password must differ from the current one.", 400);
    }
  }

  // The email index is unique. A row for this email that belongs to a
  // different user id must never be overwritten or re-pointed at us.
  const byEmail = await credentials
    .query({ where: { email }, limit: 1 })
    .then((r) => r.items[0]);
  if (byEmail && (byEmail.data as CredentialRecord).userId !== user.id) {
    return apiError(
      "EMAIL_IN_USE",
      "This email is already linked to another account's password.",
      409,
    );
  }

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(newPassword);
  const record: CredentialRecord = {
    userId: user.id,
    // Follow the user's current account email so login keeps working after
    // an email change.
    email,
    passwordHash,
    createdAt: own?.data.createdAt ?? now,
    ...(own ? { updatedAt: now } : {}),
  };
  await credentials.put(own?.id ?? `cred_${user.id}`, record);

  return apiSuccess({ hasPassword: true, changed: own !== null });
};

type Credentials = NonNullable<ReturnType<typeof getAuthProviderStorage>[string]>;

function credentialStore(db: Parameters<typeof getAuthProviderStorage>[0]): Credentials | undefined {
  const storage = getAuthProviderStorage(db, "email-password", {
    credentials: { indexes: ["userId"], uniqueIndexes: ["email"] },
  });
  return storage.credentials;
}

async function findOwnCredential(
  credentials: Credentials,
  userId: string,
): Promise<{ id: string; data: CredentialRecord } | null> {
  const row = await credentials.query({ where: { userId }, limit: 1 }).then((r) => r.items[0]);
  if (!row) return null;
  return { id: row.id, data: row.data as CredentialRecord };
}

function requireSessionUser(locals: App.Locals): Response | null {
  const user = locals.user as SessionUser | undefined;
  if (!user?.id) return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
  if (user.disabled) return apiError("ACCOUNT_DISABLED", "Account disabled", 403);
  // API and OAuth tokens are not an interactive login; they must not be
  // able to plant a password on the account they belong to.
  // `tokenId` / `tokenScopes` are set by EmDash's auth middleware for
  // bearer-token requests but are not in the public `emdash/locals` types.
  const token = locals as { tokenId?: string; tokenScopes?: string[] };
  if (token.tokenId || token.tokenScopes) {
    return apiError("FORBIDDEN", "Passwords can only be changed from a signed-in session.", 403);
  }
  return null;
}

function normaliseEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

async function readJson(request: Request): Promise<PasswordBody | null> {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as PasswordBody;
  } catch {
    return null;
  }
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
