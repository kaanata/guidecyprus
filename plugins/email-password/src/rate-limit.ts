/**
 * Minimal fixed-window rate limiter.
 *
 * Uses EmDash's `_emdash_rate_limits` table (provisioned by EmDash's
 * migration). Composite primary key on (`key`, `window`) gives us a
 * natural upsert via `ON CONFLICT DO UPDATE`.
 *
 * Window is anchored to `Math.floor(now / windowMs) * windowMs` — every
 * caller in the same window hits the same `window_start` row.
 *
 * No IP → no rate limit (there is no key to rate-limit on; allow the
 * request).
 *
 * Returns `{ allowed, count, limit }`.
 *
 * Not exported from EmDash's public API, so this duplicates the SQL
 * inline. If EmDash ever exports `checkRateLimit`, swap the body.
 */

import { sql } from "kysely";

import type { Kysely } from "kysely";

export interface RateLimitOptions {
  windowSeconds: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Run an INSERT…ON CONFLICT…RETURNING on `_emdash_rate_limits`.
 *
 * The `db` parameter accepts any `Kysely<T>` — we narrow to `Kysely<unknown>`
 * internally because the table is fixed and not part of any plugin's
 * generated schema.
 */
// Kysely's generics don't tolerate arbitrary generic substitutions across
// the .execute() call site, so we narrow at the boundary and cast through
// unknown.
type AnyKysely = Kysely<unknown> | Kysely<any> | { executeQuery: (q: unknown) => Promise<unknown> };

export async function rateLimit(
  db: AnyKysely,
  ip: string | null,
  endpoint: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!ip) return { allowed: true, count: 0, limit: opts.max };

  const windowStart = new Date(
    Math.floor(Date.now() / (opts.windowSeconds * 1000)) * opts.windowSeconds * 1000,
  ).toISOString();

  const result = await sql<{ count: number }>`
    INSERT INTO _emdash_rate_limits (key, "window", count)
    VALUES (${`${ip}:${endpoint}`}, ${windowStart}, 1)
    ON CONFLICT (key, "window")
    DO UPDATE SET count = _emdash_rate_limits.count + 1
    RETURNING count
  `.execute(db as Kysely<unknown>);

  const count = Number(result.rows[0]?.count ?? 1);
  return { allowed: count <= opts.max, count, limit: opts.max };
}