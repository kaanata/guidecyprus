/**
 * POST /_emdash/api/auth/email-password/setup
 *
 * Create the first admin account via email + password. Gated on
 * `emdash:setup_complete` — once setup has been finalised (by any auth
 * provider) this route returns 404 to mirror the built-in OAuth flow's
 * behaviour.
 *
 * On success:
 *   1. Creates the user via the Kysely adapter (`createUser` is the
 *      adapter's contract; it lowercases email and assigns the role).
 *   2. Stores the password hash in the auth-provider credentials
 *      collection (unique-indexed by email).
 *   3. Calls `finalizeSetup` to write site title / tagline and mark
 *      setup_complete = true.
 *   4. Binds the new admin user to a session and redirects to admin.
 *
 * This is a public endpoint reached during the setup wizard, before any
 * admin session exists. CSRF does not apply (same-origin wizard) and
 * `X-EmDash-Request` is not required on public routes.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import {
  OptionsRepository,
  apiError,
  finalizeSetup,
  getAuthProviderStorage,
} from "emdash/api/route-utils";

import { hashPassword, validatePasswordStrength } from "../crypto.js";
import { rateLimit } from "../rate-limit.js";

const SETUP_RATE_LIMIT = { windowSeconds: 3600, max: 10 };

interface SetupBody {
  email: string;
  password: string;
  name: string;
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

  const setupComplete = await new OptionsRepository(emdash.db).get("emdash:setup_complete");
  if (setupComplete === true || setupComplete === "true") {
    return apiError("SETUP_ALREADY_COMPLETE", "Setup has already been completed.", 404);
  }

  const ip = clientIp(request);
  const perIp = await rateLimit(emdash.db, ip, "ep-setup:ip", SETUP_RATE_LIMIT);
  if (!perIp.allowed) {
    return apiError("RATE_LIMITED", "Too many setup attempts. Please try again later.", 429);
  }

  const body = await readJson(request);
  if (!body) return apiError("VALIDATION_FAILED", "Invalid request body", 400);

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!isValidEmail(email)) return apiError("INVALID_EMAIL", "Please enter a valid email address.", 400);
  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.ok) return apiError("WEAK_PASSWORD", passwordCheck.reason, 400);
  if (!name || name.length > 120) {
    return apiError("VALIDATION_FAILED", "Display name must be 1-120 characters.", 400);
  }

  const storage = getAuthProviderStorage(emdash.db, "email-password", {
    credentials: { indexes: ["userId"], uniqueIndexes: ["email"] },
  });
  const credentials = storage.credentials;
  if (!credentials) return apiError("NOT_CONFIGURED", "Credentials storage is unavailable.", 500);

  const existing = await credentials
    .query({ where: { email }, limit: 1 })
    .then((r) => r.items[0]);
  if (existing) {
    return apiError("SETUP_ALREADY_COMPLETE", "An account with this email already exists.", 409);
  }

  const adapter = createKyselyAdapter(emdash.db as unknown as Parameters<typeof createKyselyAdapter>[0]);
  const userCount = await adapter.countUsers();
  if (userCount > 0) {
    return apiError("SETUP_ALREADY_COMPLETE", "Setup has already been completed.", 404);
  }

  const user = await adapter.createUser({
    email,
    name,
    role: Role.ADMIN,
    emailVerified: true,
  });

  const passwordHash = await hashPassword(password);
  await credentials.put(`cred_${user.id}`, {
    userId: user.id,
    email,
    passwordHash,
    createdAt: new Date().toISOString(),
  } satisfies CredentialRecord);

  await finalizeSetup(emdash.db);

  if (session) session.set("user", { id: user.id });

  return redirect("/_emdash/admin");
};

async function readJson(request: Request): Promise<SetupBody | null> {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SetupBody;
  } catch {
    return null;
  }
}

function isValidEmail(input: string): boolean {
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