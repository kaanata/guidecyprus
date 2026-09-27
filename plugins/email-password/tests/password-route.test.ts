import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashPassword, verifyPassword } from "../src/crypto";

// ---------------------------------------------------------------------------
// In-memory stand-ins for EmDash's route utils and the D1 rate-limit table.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  data: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  rateCounts: new Map<string, number>(),
  storageArgs: [] as unknown[],
}));

vi.mock("emdash/api/route-utils", () => {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  return {
    apiError: (code: string, message: string, status: number) =>
      json({ success: false, error: { code, message } }, status),
    apiSuccess: (data: unknown, status = 200) => json({ success: true, data }, status),
    getAuthProviderStorage: (...args: unknown[]) => {
      state.storageArgs.push(args);
      return {
        credentials: {
          async query({ where = {}, limit = 50 }: { where?: Record<string, unknown>; limit?: number }) {
            const items: Row[] = [];
            for (const [id, data] of state.rows) {
              if (Object.entries(where).every(([k, v]) => data[k] === v)) items.push({ id, data });
            }
            return { items: items.slice(0, limit), hasMore: false };
          },
          async put(id: string, data: Record<string, unknown>) {
            state.rows.set(id, structuredClone(data));
          },
          async get(id: string) {
            return state.rows.get(id) ?? null;
          },
        },
      };
    },
  };
});

vi.mock("../src/rate-limit", () => ({
  rateLimit: async (_db: unknown, ip: string | null, endpoint: string, opts: { max: number }) => {
    if (!ip) return { allowed: true, count: 0, limit: opts.max };
    const key = `${ip}:${endpoint}`;
    const count = (state.rateCounts.get(key) ?? 0) + 1;
    state.rateCounts.set(key, count);
    return { allowed: count <= opts.max, count, limit: opts.max };
  },
}));

const { GET, POST } = await import("../src/routes/password");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENDPOINT = "https://example.com/_emdash/api/auth/email-password/password";
const alice = { id: "user_alice", email: "Alice@Example.com", disabled: false };
const bob = { id: "user_bob", email: "bob@example.com", disabled: false };

interface CallOptions {
  user?: Record<string, unknown> | undefined;
  body?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
  ip?: string;
  locals?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function context(request: Request, opts: CallOptions): any {
  return {
    request,
    locals: { emdash: { db: {} }, user: "user" in opts ? opts.user : alice, ...opts.locals },
  };
}

async function post(opts: CallOptions = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": opts.ip ?? "203.0.113.7",
    ...(opts.csrf === false ? {} : { "X-EmDash-Request": "1" }),
    ...opts.headers,
  };
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers,
    body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {}),
  });
  const res = await POST(context(request, opts));
  return { status: res.status, body: await res.json() };
}

async function get(opts: CallOptions = {}): Promise<{ status: number; body: any }> {
  const res = await GET(context(new Request(ENDPOINT), opts));
  return { status: res.status, body: await res.json() };
}

async function seedCredential(id: string, userId: string, email: string, password: string) {
  state.rows.set(id, {
    userId,
    email,
    passwordHash: await hashPassword(password),
    createdAt: "2026-08-25T12:49:49.113Z",
  });
}

const STRONG = "correct horse battery 9";
const STRONG_2 = "another-strong-passphrase-42";

beforeEach(() => {
  state.rows.clear();
  state.rateCounts.clear();
  state.storageArgs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authentication and CSRF", () => {
  it("rejects an unauthenticated POST", async () => {
    const res = await post({ user: undefined, body: { newPassword: STRONG } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NOT_AUTHENTICATED");
    expect(state.rows.size).toBe(0);
  });

  it("rejects an unauthenticated GET", async () => {
    const res = await get({ user: undefined });
    expect(res.status).toBe(401);
  });

  it("rejects a disabled user", async () => {
    const res = await post({ user: { ...alice, disabled: true }, body: { newPassword: STRONG } });
    expect(res.status).toBe(403);
    expect(state.rows.size).toBe(0);
  });

  it("rejects bearer-token callers", async () => {
    const res = await post({ locals: { tokenId: "tok_1", tokenScopes: ["admin"] }, body: { newPassword: STRONG } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(state.rows.size).toBe(0);
  });

  it("rejects a POST without the X-EmDash-Request header", async () => {
    const res = await post({ csrf: false, body: { newPassword: STRONG } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_REJECTED");
    expect(state.rows.size).toBe(0);
  });

  it("rejects a malformed body", async () => {
    const res = await post({ body: "not json" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("GET status", () => {
  it("reports no password for a passkey-only user", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hasPassword: false, email: "alice@example.com" });
  });

  it("reports a password once one exists", async () => {
    await seedCredential("cred_user_alice", alice.id, "alice@example.com", STRONG);
    const res = await get();
    expect(res.body.data.hasPassword).toBe(true);
  });

  it("uses the same storage namespace and indexes as login/setup", async () => {
    await get();
    expect(state.storageArgs[0]).toEqual([
      {},
      "email-password",
      { credentials: { indexes: ["userId"], uniqueIndexes: ["email"] } },
    ]);
  });
});

describe("setting a password when none exists", () => {
  it("stores a row login.ts can verify, keyed by the session user", async () => {
    const res = await post({ body: { newPassword: STRONG } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hasPassword: true, changed: false });

    const row = state.rows.get("cred_user_alice");
    expect(row).toBeDefined();
    expect(row?.userId).toBe("user_alice");
    // Lower-cased, like setup.ts, so login's email lookup matches.
    expect(row?.email).toBe("alice@example.com");
    expect(typeof row?.createdAt).toBe("string");
    expect(await verifyPassword(STRONG, row?.passwordHash as string)).toBe(true);
  });

  it("ignores a currentPassword field when there is nothing to check it against", async () => {
    const res = await post({ body: { currentPassword: "whatever", newPassword: STRONG } });
    expect(res.status).toBe(200);
  });

  it("ignores userId / email in the body", async () => {
    const res = await post({ body: { newPassword: STRONG, userId: bob.id, email: bob.email } });
    expect(res.status).toBe(200);
    expect([...state.rows.values()].map((r) => r.userId)).toEqual(["user_alice"]);
  });
});

describe("changing an existing password", () => {
  beforeEach(async () => {
    await seedCredential("cred_user_alice", alice.id, "alice@example.com", STRONG);
  });

  it("requires the current password", async () => {
    const res = await post({ body: { newPassword: STRONG_2 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CURRENT_PASSWORD_REQUIRED");
    expect(await verifyPassword(STRONG, state.rows.get("cred_user_alice")?.passwordHash as string)).toBe(true);
  });

  it("rejects a wrong current password", async () => {
    const res = await post({ body: { currentPassword: "wrong password 123", newPassword: STRONG_2 } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(await verifyPassword(STRONG, state.rows.get("cred_user_alice")?.passwordHash as string)).toBe(true);
  });

  it("changes it with the correct current password, keeping the row id and createdAt", async () => {
    const res = await post({ body: { currentPassword: STRONG, newPassword: STRONG_2 } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hasPassword: true, changed: true });
    expect(state.rows.size).toBe(1);
    const row = state.rows.get("cred_user_alice");
    expect(row?.createdAt).toBe("2026-08-25T12:49:49.113Z");
    expect(typeof row?.updatedAt).toBe("string");
    expect(await verifyPassword(STRONG_2, row?.passwordHash as string)).toBe(true);
    expect(await verifyPassword(STRONG, row?.passwordHash as string)).toBe(false);
  });

  it("rejects reusing the current password", async () => {
    const res = await post({ body: { currentPassword: STRONG, newPassword: STRONG } });
    expect(res.status).toBe(400);
  });
});

describe("password strength", () => {
  it.each([
    ["too short", "short1!"],
    ["letters only", "onlylettershere"],
    ["digits only", "123456789012345"],
    ["too long", `a1${"x".repeat(300)}`],
  ])("rejects a weak password (%s)", async (_label, password) => {
    const res = await post({ body: { newPassword: password } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WEAK_PASSWORD");
    expect(state.rows.size).toBe(0);
  });

  it("rejects a missing new password", async () => {
    const res = await post({ body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WEAK_PASSWORD");
  });
});

describe("other users' credentials", () => {
  it("never reads or overwrites another user's credential", async () => {
    await seedCredential("cred_user_bob", bob.id, bob.email, STRONG);
    // Alice has no credential; Bob's row must not be treated as hers.
    const status = await get();
    expect(status.body.data.hasPassword).toBe(false);

    const res = await post({ body: { newPassword: STRONG_2, currentPassword: STRONG } });
    expect(res.status).toBe(200);
    expect(await verifyPassword(STRONG, state.rows.get("cred_user_bob")?.passwordHash as string)).toBe(true);
    expect(state.rows.get("cred_user_alice")?.userId).toBe("user_alice");
  });

  it("refuses to take over a credential row holding the user's email but another user id", async () => {
    await seedCredential("cred_user_bob", bob.id, "alice@example.com", STRONG);
    const res = await post({ body: { newPassword: STRONG_2 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_IN_USE");
    const bobRow = state.rows.get("cred_user_bob");
    expect(bobRow?.userId).toBe("user_bob");
    expect(await verifyPassword(STRONG, bobRow?.passwordHash as string)).toBe(true);
    expect(state.rows.has("cred_user_alice")).toBe(false);
  });
});

describe("rate limiting", () => {
  it("blocks the sixth attempt for the same user, even from different IPs", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post({ ip: `198.51.100.${i}`, body: { newPassword: "weak" } });
      expect(res.status).toBe(400);
    }
    const res = await post({ ip: "198.51.100.99", body: { newPassword: STRONG } });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(state.rows.size).toBe(0);
  });

  it("does not let one user's attempts lock out another", async () => {
    for (let i = 0; i < 5; i++) await post({ body: { newPassword: "weak" } });
    const res = await post({ user: bob, body: { newPassword: STRONG } });
    expect(res.status).toBe(200);
  });

  it("caps attempts per IP across users", async () => {
    for (let i = 0; i < 20; i++) {
      await post({ user: { id: `user_${i}`, email: `u${i}@example.com` }, body: { newPassword: "weak" } });
    }
    const res = await post({ user: { id: "user_new", email: "new@example.com" }, body: { newPassword: STRONG } });
    expect(res.status).toBe(429);
  });
});
