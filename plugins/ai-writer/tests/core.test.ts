import * as core from "../src/lib/core";

describe("core barrel", () => {
  it("exports the primitives a sibling plugin needs to write a post", () => {
    expect(typeof core.createGenerationClient).toBe("function");
    expect(typeof core.deslopArticle).toBe("function");
    expect(typeof core.slopAskFor).toBe("function");
    expect(typeof core.assemble).toBe("function");
    expect(typeof core.createPost).toBe("function");
    expect(typeof core.readSettings).toBe("function");
  });

  it("exports the slop rule set as non-empty guidance", () => {
    expect(typeof core.SLOP_GUIDE).toBe("string");
    expect(core.SLOP_GUIDE.length).toBeGreaterThan(100);
  });
});
