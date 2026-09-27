import { KV_CODE_ADS } from "../constants";
import { settingsInputSchema } from "./schema";
import type { KV } from "./store";

export async function readCodeAdsEnabled(kv: KV): Promise<boolean> {
  return (await kv.get<boolean>(KV_CODE_ADS)) ?? true;
}

export async function saveSettings(
  kv: KV,
  raw: unknown,
): Promise<{ ok: true; codeAdsEnabled: boolean } | { ok: false; error: "INVALID_INPUT" }> {
  const parsed = settingsInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };
  await kv.set(KV_CODE_ADS, parsed.data.codeAdsEnabled);
  return { ok: true, codeAdsEnabled: parsed.data.codeAdsEnabled };
}
