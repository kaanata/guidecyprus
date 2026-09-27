# `@main-aff/plugin-email-password`

Email-and-password authentication provider for the EmDash admin panel. Ships
as a self-contained EmDash plugin so the wiring, routes, and UI stay in one
folder — the rest of the project only needs to import the descriptor factory.

## What it does

- Adds a **Sign in with email & password** button to the EmDash admin login
  page (alongside passkey and magic-link).
- Adds an email-password option to the first-admin setup wizard.
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
| Rate limiting  | 5 attempts per IP per 60 s on login; 10 per IP per hour on setup                                  |
| Storage        | EmDash `_plugin_storage` (D1) under namespace `auth:email-password`, collection `credentials`      |
| Sessions       | Reuse EmDash's session (`session.set("user", { id })`) — no custom cookie surface                 |

> **Why PBKDF2 and not argon2id?** Cloudflare `workerd` (both locally and
> in production) disallows `WebAssembly.compile()`, which blocks every
> WASM-based KDF (argon2, scrypt, @oslojs/crypto variants). PBKDF2 via the
> Web Crypto `subtle.deriveBits` API works in both runtimes with the same
> code path. Re-evaluate argon2 once `workerd` exposes a WASM hook.

## Routes

The plugin injects two `AuthRouteDescriptor`s:

| Method | Path                                            | Purpose                |
| ------ | ----------------------------------------------- | ---------------------- |
| POST   | `/_emdash/api/auth/email-password/login`        | Authenticate + session |
| POST   | `/_emdash/api/auth/email-password/setup`        | First-admin creation   |

Both endpoints return JSON errors with `{ success: false, error: { code, message } }`.
On success, the login/setup endpoints respond with `302 Location: /_emdash/admin`.

## Installation

The plugin lives at `plugins/email-password/` and is already wired into
the workspace.

1. **Workspace package** — `pnpm-workspace.yaml` lists `plugins/*`; the
   plugin is referenced from the root `package.json` as
   `"@main-aff/plugin-email-password": "workspace:*"`.
2. **Astro config** — register the provider:
   ```js
   // astro.config.mjs
   import { emailPassword } from "@main-aff/plugin-email-password";
   export default defineConfig({
     integrations: [
       emdash({
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
  "createdAt": "2026-08-25T12:49:49.113Z"
}
```

`email` is the secondary unique index; `userId` is the secondary
non-unique index. EmDash creates the indexes automatically when the
plugin descriptor lists them in `storage`.

## Plugin layout

```
plugins/email-password/
├── README.md
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # emailPassword() factory → AuthProviderDescriptor
    ├── admin.tsx         # LoginButton, LoginForm, SetupStep React components
    ├── crypto.ts         # PBKDF2 hash/verify, password strength check
    ├── rate-limit.ts     # _emdash_rate_limits helper
    └── routes/
        ├── login.ts      # POST /_emdash/api/auth/email-password/login
        └── setup.ts      # POST /_emdash/api/auth/email-password/setup
```

`index.ts` is the only file the host project imports. Everything else
is shipped as the `adminEntry` and `routes[].entrypoint` virtual-module
imports that EmDash resolves at build time.
