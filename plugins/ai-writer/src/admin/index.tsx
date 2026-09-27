import type { PluginAdminExports } from "emdash";
import { BulkEditPage } from "./BulkEditPage";
import { EditorPanel } from "./EditorPanel";
import { ExpressPage } from "./ExpressPage";
import { RecentRunsWidget } from "./RecentRunsWidget";
import { RulesPage } from "./RulesPage";
import { SettingsPage } from "./SettingsPage";

export const pages: PluginAdminExports["pages"] = {
  "/express": ExpressPage,
  "/rules": RulesPage,
  "/bulk-edit": BulkEditPage,
  "/settings": SettingsPage,
};

export const widgets: PluginAdminExports["widgets"] = {
  "recent-runs": RecentRunsWidget,
};

// Editor sidebar panel for posts and pages; it hides fields a collection
// cannot hold (pages have no image, tags or SEO). minRole 40 = Editor; its
// routes require content:edit_any, which Editors have.
export const EDITOR_PANEL_COLLECTIONS = ["posts", "pages"] as const;

export const contentEditorPanels = [
  {
    id: "ai-writer",
    title: "AI Writer",
    component: EditorPanel,
    collections: EDITOR_PANEL_COLLECTIONS,
    minRole: 40,
    order: 20,
  },
];

export { BulkEditPage, EditorPanel, ExpressPage, RecentRunsWidget, RulesPage, SettingsPage };
