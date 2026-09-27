import { describe, expect, it } from "vitest";
import { unwrapEnvelope } from "../src/admin/envelope";

describe("unwrapEnvelope", () => {
  it("returns data for a successful plugin response", () => {
    expect(unwrapEnvelope(200, { success: true, data: { x: 1 } })).toEqual({ ok: true, data: { x: 1 } });
  });

  it("surfaces a handler failure hidden inside an outer 200", () => {
    expect(
      unwrapEnvelope(200, { success: true, data: { success: false, error: { code: "step_failed", message: "boom" } } }),
    ).toEqual({ ok: false, error: { code: "step_failed", message: "boom" } });
  });

  it("surfaces an outer failure (e.g. CSRF)", () => {
    expect(
      unwrapEnvelope(403, { success: false, error: { code: "CSRF_REJECTED", message: "Missing required header" } }),
    ).toEqual({ ok: false, error: { code: "CSRF_REJECTED", message: "Missing required header" } });
  });

  it("falls back to the HTTP status when the body is unreadable", () => {
    expect(unwrapEnvelope(500, null)).toEqual({ ok: false, error: { code: "error", message: "HTTP 500" } });
  });

  it("passes array data through untouched", () => {
    expect(unwrapEnvelope(200, { success: true, data: [1, 2] })).toEqual({ ok: true, data: [1, 2] });
  });
});
