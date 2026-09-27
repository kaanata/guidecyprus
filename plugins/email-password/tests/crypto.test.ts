import { describe, expect, it } from "vitest";

import { hashPassword, validatePasswordStrength, verifyPassword } from "../src/crypto";

describe("hashPassword / verifyPassword", () => {
  it("round-trips and uses the documented format", async () => {
    const hash = await hashPassword("correct horse battery 9");
    expect(hash).toMatch(/^\$pbkdf2-sha256\$600000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword("correct horse battery 9", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery 8", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password 1"), hashPassword("same password 1")]);
    expect(a).not.toBe(b);
  });

  it("returns false for malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "$argon2id$v=19$abc")).toBe(false);
    expect(await verifyPassword("x", "$pbkdf2-sha256$600000$AAAA")).toBe(false);
    expect(await verifyPassword("x", "$pbkdf2-sha256$600000$AAAA$AAAA")).toBe(false);
    expect(await verifyPassword("x", "$pbkdf2-sha256$600000$!!!$@@@")).toBe(false);
  });
});

describe("validatePasswordStrength", () => {
  it("accepts 12+ characters with a letter and a digit or symbol", () => {
    expect(validatePasswordStrength("abcdefghijk1")).toEqual({ ok: true });
    expect(validatePasswordStrength("abcdefghijk!")).toEqual({ ok: true });
  });

  it("rejects short, single-class and overlong passwords", () => {
    expect(validatePasswordStrength("abc1").ok).toBe(false);
    expect(validatePasswordStrength("abcdefghijklmnop").ok).toBe(false);
    expect(validatePasswordStrength("1234567890123").ok).toBe(false);
    expect(validatePasswordStrength(`a1${"b".repeat(255)}`).ok).toBe(false);
  });
});
