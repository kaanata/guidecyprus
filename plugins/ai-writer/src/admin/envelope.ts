export type ApiError = { code: string; message: string };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

type ErrorShape = { code?: unknown; message?: unknown } | undefined;

function toError(e: ErrorShape, fallback: string): ApiError {
  return {
    code: typeof e?.code === "string" ? e.code : "error",
    message: typeof e?.message === "string" ? e.message : fallback,
  };
}

// EmDash wraps every plugin route response as { success, data: <handler return> }.
// This plugin's handlers return { success: false, error } on failure, which
// arrives as HTTP 200 inside that wrapper. Unwrap both layers so a failure is
// never shown as success (e.g. an "Uploaded to …" notice for a failed upload).
export function unwrapEnvelope<T>(status: number, body: unknown): ApiResult<T> {
  const outer = (body && typeof body === "object" ? body : {}) as {
    success?: unknown;
    data?: unknown;
    error?: ErrorShape;
  };
  if (status < 200 || status >= 300 || outer.success === false) {
    return { ok: false, error: toError(outer.error, `HTTP ${status}`) };
  }
  const inner = outer.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const i = inner as { success?: unknown; error?: ErrorShape };
    if (i.success === false) return { ok: false, error: toError(i.error, "Request failed") };
  }
  return { ok: true, data: inner as T };
}
