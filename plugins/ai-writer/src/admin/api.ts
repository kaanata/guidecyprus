import { apiFetch } from "emdash/plugin-utils";
import { unwrapEnvelope, type ApiResult } from "./envelope";

export type { ApiError, ApiResult } from "./envelope";

export const API = "/_emdash/api/plugins/ai-writer";

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function networkError(err: unknown): ApiResult<never> {
  return {
    ok: false,
    error: { code: "network_error", message: err instanceof Error ? err.message : "Network request failed" },
  };
}

// apiFetch is a thin wrapper over fetch with no try/catch, so a network-level
// failure (offline, DNS, aborted) rejects instead of resolving. Every caller
// treats a failure as { ok: false }, never a rejection, so that translation
// happens once here rather than at each call site.
export async function apiGet<T>(route: string): Promise<ApiResult<T>> {
  try {
    const res = await apiFetch(`${API}/${route}`);
    return unwrapEnvelope<T>(res.status, await readJson(res));
  } catch (err) {
    return networkError(err);
  }
}

// apiFetch adds the X-EmDash-Request CSRF header; the init object must carry
// method + body (passing the body as the second argument sends a GET).
export async function apiPost<T>(route: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await apiFetch(`${API}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return unwrapEnvelope<T>(res.status, await readJson(res));
  } catch (err) {
    return networkError(err);
  }
}
