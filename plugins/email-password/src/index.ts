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
 *   - A signed-in user can set or change their own password through the
 *     private `PASSWORD_ENDPOINT` route (session required, CSRF header
 *     required, current password required when one already exists). The
 *     UI for it is the "Password" admin page contributed by the companion
 *     `emailPasswordAccount()` plugin descriptor below.
 */

import type { AuthProviderDescriptor, PluginDescriptor } from "emdash";

/** Private route where a signed-in user sets or changes their password. */
export const PASSWORD_ENDPOINT = "/_emdash/api/auth/email-password/password";

/** Plugin id of the companion account plugin (admin page host). */
export const ACCOUNT_PLUGIN_ID = "email-password";

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
      {
        pattern: PASSWORD_ENDPOINT,
        entrypoint: "@main-aff/plugin-email-password/routes/password",
      },
    ],
    // Exact paths, not the `/_emdash/api/auth/email-password/` prefix: the
    // password route must stay private so EmDash's auth middleware resolves
    // the session user and enforces the `X-EmDash-Request` CSRF header.
    publicRoutes: [
      "/_emdash/api/auth/email-password/login",
      "/_emdash/api/auth/email-password/setup",
    ],
    storage: {
      credentials: {
        indexes: ["userId"],
        uniqueIndexes: ["email"],
      },
    },
  };
}

/**
 * Companion native plugin that adds the "Password" admin page.
 *
 * `AuthProviderDescriptor.adminEntry` can only contribute `LoginButton`,
 * `LoginForm` and `SetupStep`, and the built-in Security settings page has
 * no extension slot. Plugin admin pages are the one place EmDash 0.40 lets
 * third-party UI render for a signed-in user, so this descriptor exists only
 * to host that page. It has no storage, hooks or routes of its own; the page
 * talks to the auth provider's `PASSWORD_ENDPOINT`.
 *
 * Register it next to the provider:
 *
 *     emdash({
 *       plugins: [emailPasswordAccount()],
 *       authProviders: [emailPassword()],
 *     })
 */
export function emailPasswordAccount(): PluginDescriptor {
  return {
    id: ACCOUNT_PLUGIN_ID,
    version: "0.1.0",
    format: "native",
    entrypoint: "@main-aff/plugin-email-password/plugin",
    adminEntry: "@main-aff/plugin-email-password/admin",
    adminPages: [{ path: "/password", label: "Password", icon: "lock" }],
  };
}

export default emailPassword;
