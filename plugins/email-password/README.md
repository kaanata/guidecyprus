# `@main-aff/plugin-email-password`

Email-and-password authentication provider for the EmDash admin panel. Ships
as a self-contained EmDash plugin so the wiring, routes, and UI stay in one
folder — the rest of the project only needs to import the descriptor factory.

## What it does

- Adds a **Sign in with email & password** button to the EmDash admin login
  page (alongside passkey and magic-link).
- Adds an email-password option to the first-admin setup wizard.
- Adds a **Password** admin page where any signed-in user can set a
  password (if they signed up with a passkey or magic link) or change it.
- Stores PBKDF2-hashed credentials in the plugin-scoped
  `_plugin_storage` table.
- Issues the standard EmDash `astro-session` cookie on success — no new
  auth surface in the admin middleware.

## Security model

| Concern        | Choice                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------- |
| KDF            | PBKDF2-HMAC-SHA-256, **600 000 iterations**, 16-byte random salt, 32-byte derived key              |
| Hash format    | `$pbkdf2-sha256$600000$<salt-b64url>$<hash-b64url>`                                                |
| Password rules | Min 12 chars, at least one letter and one digit/symbol                                            |
| Timing attacks | Constant-time hash comparison; on user-not-found a dummy verify still runs to mask the timing gap |
| Rate limiting  | 5 attempts per IP per 60 s on login; 10 per IP per hour on setup; 5 per user and 20 per IP per 15 min on set/change password |
| Storage        | EmDash `_plugin_storage` (D1) under namespace `auth:email-password`, collection `credentials`      |
| Sessions       | Reuse EmDash's session (`session.set("user", { id })`) — no custom cookie surface                 |

> **Why PBKDF2 and not argon2id?** Cloudflare `workerd` (both locally and
> in production) disallows `WebAssembly.compile()`, which blocks every
> WASM-based KDF (argon2, scrypt, @oslojs/crypto variants). PBKDF2 via the
> Web Crypto `subtle.deriveBits` API works in both runtimes with the same
> code path. Re-evaluate argon2 once `workerd` exposes a WASM hook.

## Routes

The plugin injects three `AuthRouteDescriptor`s:

| Method | Path                                            | Access                  | Purpose                              |
| ------ | ----------------------------------------------- | ----------------------- | ------------------------------------ |
| POST   | `/_emdash/api/auth/email-password/login`        | public                  | Authenticate + session               |
| POST   | `/_emdash/api/auth/email-password/setup`        | public                  | First-admin creation                 |
| GET    | `/_emdash/api/auth/email-password/password`     | signed-in session       | `{ hasPassword, email }` for the current user |
| POST   | `/_emdash/api/auth/email-password/password`     | signed-in session + CSRF | Set or change the current user's password |

All endpoints return JSON errors with `{ success: false, error: { code, message } }`.
On success, the login/setup endpoints respond with `302 Location: /_emdash/admin`;
the password endpoint responds with `{ success: true, data: { hasPassword: true, changed } }`.

Only `login` and `setup` are listed in the descriptor's `publicRoutes` (as
exact paths). The password route is private, so EmDash's auth middleware
handles it like its own authenticated API routes: it resolves the session
into `locals.user` (401 without one, 403 for a disabled user) and rejects
state-changing requests that lack the `X-EmDash-Request: 1` header.

## Setting a password after passkey setup

Setup only offers a password to the *first* admin, and only when they pick
email & password in the wizard. Anyone who signed up with a passkey or a
magic link (including that first admin) sets a password afterwards:

1. Sign in as usual.
2. Open **Plugins → Password** in the admin sidebar
   (`/_emdash/admin/plugins/email-password/password`).
3. The page shows **Set password** when the account has none, or
   **Change password** (asking for the current one) when it does.

After that, the account can also sign in with its account email and the
password. Rules enforced by `POST …/password`:

- The credential is always the caller's own: it is keyed by the session
  user's id and account email (lower-cased). Nothing in the request body
  can name another user. If a credential row already holds that email for a
  different user id, the request fails with `409 EMAIL_IN_USE` and the row
  is left alone.
- If a credential exists, `currentPassword` must verify (`401` otherwise);
  the new password must differ from it.
- If none exists, no current password is needed; the session already
  proves who the user is.
- The new password must pass the same strength rule as setup.
- Bearer-token (API / OAuth token) requests are refused; a password can
  only be set from an interactive session.
- Existing sessions are not revoked when the password changes.

### Why a companion plugin?

`AuthProviderDescriptor.adminEntry` can only contribute `LoginButton`,
`LoginForm` and `SetupStep`, and EmDash 0.40's built-in Security settings
page (`/settings/security`) has no extension slot. Plugin admin pages are
the supported way to render custom UI for a signed-in user, so the package
also exports `emailPasswordAccount()`, a native `PluginDescriptor` that only
registers that page (no storage, hooks or routes). Plugin pages have no
role gate, so every user sees it, not just admins.

## Installation

The plugin lives at `plugins/email-password/` and is already wired into
the workspace.

1. **Workspace package** — `pnpm-workspace.yaml` lists `plugins/*`; the
   plugin is referenced from the root `package.json` as
   `"@main-aff/plugin-email-password": "workspace:*"`.
2. **Astro config** — register the provider:
   ```js
   // astro.config.mjs
   import { emailPassword, emailPasswordAccount } from "@main-aff/plugin-email-password";
   export default defineConfig({
     integrations: [
       emdash({
         plugins: [emailPasswordAccount()], // the "Password" admin page
         authProviders: [emailPassword()],
         // ...
       }),
     ],
   });
   ```
3. **Restart** the dev server. Adding a new provider is a Vite module
   change; HMR doesn't pick up `virtual:emdash/auth-providers`.

## Storage shape

The plugin's storage collection (`credentials`) is keyed by ULID and
holds one row per (user, email):

```jsonc
{
  "userId":   "01M0WFGGBNB32PSASVWN8QKVS0",
  "email":    "admin@example.com",
  "passwordHash": "$pbkdf2-sha256$600000$...$...",
  "createdAt": "2026-08-25T12:49:49.113Z",
  "updatedAt": "2026-09-27T09:00:00.000Z" // only after a password change
}
```

Rows are written with id `cred_<userId>` by both setup and the password
route; a change rewrites the existing row in place.

`email` is the secondary unique index; `userId` is the secondary
non-unique index. EmDash creates the indexes automatically when the
plugin descriptor lists them in `storage`.

## Plugin layout

```
plugins/email-password/
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── tests/
│   ├── crypto.test.ts
│   └── password-route.test.ts
└── src/
    ├── index.ts          # emailPassword() → AuthProviderDescriptor, emailPasswordAccount() → PluginDescriptor
    ├── plugin.ts         # native createPlugin() for emailPasswordAccount()
    ├── admin.tsx         # LoginButton, LoginForm, SetupStep, PasswordPage (+ `pages`)
    ├── crypto.ts         # PBKDF2 hash/verify, password strength check
    ├── rate-limit.ts     # _emdash_rate_limits helper
    └── routes/
        ├── login.ts      # POST /_emdash/api/auth/email-password/login
        ├── setup.ts      # POST /_emdash/api/auth/email-password/setup
        └── password.ts   # GET/POST /_emdash/api/auth/email-password/password
```

Run the tests with `pnpm --filter @main-aff/plugin-email-password test`.

`index.ts` is the only file the host project imports. Everything else
is shipped as the `adminEntry` and `routes[].entrypoint` virtual-module
imports that EmDash resolves at build time.
