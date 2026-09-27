import { describe, expect, it } from "vitest";
import { contentEditorPanels } from "../src/admin/index";

describe("editor panel registration", () => {
  it("shows the AI Writer panel on posts and pages to Editors", () => {
    expect(contentEditorPanels).toHaveLength(1);
    expect(contentEditorPanels[0]).toMatchObject({ id: "ai-writer", collections: ["posts", "pages"], minRole: 40 });
  });
});
