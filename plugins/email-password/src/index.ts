/**
 * Email & password auth provider for EmDash.
 *
 * Implements the `AuthProviderDescriptor` shape so the provider can be
 * registered with `emdash({ authProviders: [emailPassword()] })` in
 * `astro.config.mjs`. Routes are injected at build time by the EmDash
 * Astro integration via the `routes` array — each entry's `entrypoint`
 * is resolved by Vite.
 *
 * Storage: credentials are kept in the plugin's own storage collection
 * (`auth:email-password:credentials`) in the shared `_plugin_storage`
 * table. The collection is indexed by `userId` and `email`; the latter
 * is a unique index to prevent duplicates. Email is lower-cased before
 * being stored and indexed so login is case-insensitive.
 *
 * Security notes:
 *   - Password hashes use PBKDF2-SHA-256 / 600,000 iters / 16-byte salt /
 *     32-byte derived key. See `./crypto.ts` for the migration path to
 *     argon2 once Cloudflare workerd supports WASM.
 *   - Login rate-limits per (email + IP) and per IP via the in-memory
 *     rate limiter used by built-in providers. Cloudflare KV / D1 is
 *     overkill for a single-site install and not available in tests.
 *   - Setup is gated on `emdash:setup_complete !== true`, matching the
 *     check in the built-in OAuth callback. After the first admin is
 *     created the setup route returns 404.
 */

import type { AuthProviderDescriptor } from "emdash";

export interface EmailPasswordOptions {
  /**
   * Override the default label shown on the login form.
   * Defaults to "Email & password".
   */
  label?: string;
}

export function emailPassword(options: EmailPasswordOptions = {}): AuthProviderDescriptor {
  return {
    id: "email-password",
    label: options.label ?? "Email & password",
    config: { label: options.label ?? "Email & password" },
    adminEntry: "@main-aff/plugin-email-password/admin",
    routes: [
      {
        pattern: "/_emdash/api/auth/email-password/login",
        entrypoint: "@main-aff/plugin-email-password/routes/login",
      },
      {
        pattern: "/_emdash/api/auth/email-password/setup",
        entrypoint: "@main-aff/plugin-email-password/routes/setup",
      },
    ],
    publicRoutes: [
      "/_emdash/api/auth/email-password/",
    ],
    storage: {
      credentials: {
        indexes: ["userId"],
        uniqueIndexes: ["email"],
      },
    },
  };
}

export default emailPassword;
