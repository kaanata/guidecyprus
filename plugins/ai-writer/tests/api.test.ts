import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/plugin-utils", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "emdash/plugin-utils";
import { apiGet, apiPost } from "../src/admin/api";

describe("apiGet / apiPost network failures", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("apiGet resolves to a network_error instead of rejecting", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("offline"));
    await expect(apiGet("models")).resolves.toEqual({
      ok: false,
      error: { code: "network_error", message: "offline" },
    });
  });

  it("apiPost resolves to a network_error instead of rejecting", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("offline"));
    await expect(apiPost("settings", { a: 1 })).resolves.toEqual({
      ok: false,
      error: { code: "network_error", message: "offline" },
    });
  });

  it("apiPost sends method, headers, and JSON body, and unwraps a successful response", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { x: 1 } }), { status: 200 }),
    );

    const result = await apiPost("settings", { a: 1 });

    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("settings"),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    expect(result).toEqual({ ok: true, data: { x: 1 } });
  });
});
