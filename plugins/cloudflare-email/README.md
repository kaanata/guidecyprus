# `@main-aff/plugin-cloudflare-email`

Cloudflare Email Sending provider for EmDash — delivered through the
`send_email` Worker binding. Local fork of the upstream
`@emdash-cms/cloudflare/plugins` `cloudflareEmail` plugin, packaged as a
first-party workspace plugin so the email transport stays in our repo.

## What it does

- Registers an `email:deliver` exclusive hook on the EmDash plugin bus.
- Reads a `send_email` Worker binding (default name `EMAIL`) and forwards
  EmDash-generated messages (magic links, invites, comment notifications,
  etc.) to Cloudflare Email Sending.
- Validates the configured sender address at config-load time so missing
  or unverified `from` values fail loudly instead of silently dropping mail.

## Plugin shape

| Property      | Value                                  |
| ------------- | -------------------------------------- |
| `id`          | `cloudflare-email`                     |
| `format`      | `native`                               |
| `entrypoint`  | `@main-aff/plugin-cloudflare-email`    |
| `capabilities`| `hooks.email-transport:register`       |
| `hook`        | `email:deliver` (exclusive)            |

## Configuration

```ts
// astro.config.mjs
import { cloudflareEmail } from "@main-aff/plugin-cloudflare-email";

cloudflareEmail({
  from: { email: "noreply@mainaffservice.online", name: "EmDash CMS" },
  replyTo: "hello@mainaffservice.online", // optional
  binding: "EMAIL",                        // optional, default "EMAIL"
});
```

## Worker binding

```jsonc
// wrangler.jsonc
{
  "send_email": [{ "name": "EMAIL" }]
}
```

The sender domain (`mainaffservice.online` in the example) must be
onboarded via `wrangler email sending enable <domain>` before the first
send, or via the Cloudflare dashboard → Email Service.

## Layout

```
plugins/cloudflare-email/
├── README.md
├── package.json
├── tsconfig.json
└── src/
    └── index.ts        # cloudflareEmail() descriptor factory + createPlugin()
```

`index.ts` is the entrypoint AND the descriptor module. The EmDash Astro
integration calls `createPlugin(config)` on the entrypoint at build time,
using `options` from the descriptor.

## Why a local plugin instead of `@emdash-cms/cloudflare/plugins`?

- Keeps the email transport code under our control / in the same repo as
  the rest of the workspace plugins (`plugins/email-password/`).
- No coupling to `@emdash-cms/cloudflare` for this one feature.
- Easier to fork behaviour (e.g. swap to REST API, add a fallback
  transport) without monkey-patching the upstream package.
