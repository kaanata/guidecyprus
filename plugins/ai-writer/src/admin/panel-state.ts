import type { CollectionFeatures } from "../lib/collections";
import { PANEL_FIELDS, type PanelField, type PanelPreview, type PanelValues } from "../lib/panel";

export const FIELD_LABELS: Record<PanelField, string> = {
  title: "Title",
  excerpt: "Excerpt",
  tags: "Tags",
  seo: "SEO meta",
  image: "Featured image",
  rewrite: "Rewrite content (replaces the body)",
};

export type PanelState = {
  selected: Record<PanelField, boolean>;
  models: Partial<Record<PanelField, string>>;
  instructions: string;
  preview: PanelPreview | null;
  keep: Record<PanelField, boolean>;
  errors: Partial<Record<PanelField, string>>;
  warnings: string[];
};

const everyField = (value: boolean) =>
  Object.fromEntries(PANEL_FIELDS.map((field) => [field, value])) as Record<PanelField, boolean>;

// Rewrite replaces the whole body and an image costs a paid call plus an
// upload, so both start unchecked.
export function initialPanelState(): PanelState {
  return {
    selected: { ...everyField(true), image: false, rewrite: false },
    models: {},
    instructions: "",
    preview: null,
    keep: everyField(true),
    errors: {},
    warnings: [],
  };
}

/** Fields the collection can hold (all of them while its features are unknown). */
export function availableFields(features: CollectionFeatures | null): PanelField[] {
  if (!features) return [...PANEL_FIELDS];
  const supported: Record<PanelField, boolean> = {
    title: true,
    excerpt: features.excerpt,
    tags: features.tags,
    seo: features.seo,
    image: features.featuredImage,
    rewrite: true,
  };
  return PANEL_FIELDS.filter((field) => supported[field]);
}

export function selectedFields(state: PanelState, features: CollectionFeatures | null = null): PanelField[] {
  return availableFields(features).filter((field) => state.selected[field]);
}

// Fields with a generated value; the rewrite field's value is `content`.
export function previewFields(preview: PanelPreview | null): PanelField[] {
  if (!preview) return [];
  const present: Record<PanelField, boolean> = {
    title: preview.title !== undefined,
    excerpt: preview.excerpt !== undefined,
    tags: (preview.tags?.length ?? 0) > 0,
    seo: preview.seo !== undefined,
    image: preview.featuredImage !== undefined,
    rewrite: (preview.content?.length ?? 0) > 0,
  };
  return PANEL_FIELDS.filter((field) => present[field]);
}

export function keptValues(preview: PanelPreview | null, keep: Record<PanelField, boolean>): PanelValues {
  const values: PanelValues = {};
  if (!preview) return values;
  const kept = new Set(previewFields(preview).filter((field) => keep[field]));
  if (kept.has("title")) values.title = preview.title;
  if (kept.has("excerpt")) values.excerpt = preview.excerpt;
  if (kept.has("tags")) values.tags = (preview.tags ?? []).map((t) => t.slug);
  if (kept.has("seo")) values.seo = preview.seo;
  if (kept.has("image")) values.featuredImage = preview.featuredImage;
  if (kept.has("rewrite")) values.content = preview.content;
  return values;
}

export function hasKeptValues(preview: PanelPreview | null, keep: Record<PanelField, boolean>): boolean {
  return Object.keys(keptValues(preview, keep)).length > 0;
}
