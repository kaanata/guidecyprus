/**
 * Native plugin entrypoint for the companion `emailPasswordAccount()`
 * descriptor. Its only job is to register the admin page that lets a
 * signed-in user set or change their password; all server logic lives in
 * the auth provider's `routes/password.ts`.
 */

import { definePlugin } from "emdash";

import { emailPasswordAccount } from "./index.js";

export function createPlugin(): ReturnType<typeof definePlugin> {
  const descriptor = emailPasswordAccount();
  return definePlugin({
    id: descriptor.id,
    version: descriptor.version,
    // Native plugins drop the descriptor's top-level admin fields; repeat them here.
    admin: { entry: descriptor.adminEntry, pages: descriptor.adminPages },
  });
}

export default createPlugin;
