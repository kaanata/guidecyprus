export const TEXT_SLOTS = [
  "title",
  "outline",
  "section",
  "intro",
  "outro",
  "faq",
  "excerpt",
  "tags",
  "seo",
  "rewrite",
  "imagePrompt",
] as const;
export type TextSlot = (typeof TEXT_SLOTS)[number];
export type Slot = TextSlot | "image";
export type ModelOverrides = Partial<Record<Slot, string>>;

// Slice 4 adds "listicle".
export const MODES = ["article"] as const;
export type Mode = (typeof MODES)[number];

export type PortableTextSpan = { _type: "span"; _key: string; text: string; marks: string[] };
export type PortableTextBlock = {
  _type: "block";
  _key: string;
  style: "normal" | "h2" | "h3";
  listItem?: "bullet";
  level?: number;
  markDefs: never[];
  children: PortableTextSpan[];
};

export type FaqItem = { q: string; a: string };
export type Section = { heading: string; paragraphs: string[] };
export type ArticleParts = {
  title: string;
  intro: string[];
  sections: Section[];
  outro: string[];
  faq: FaqItem[];
};

export type TermRef = { slug: string; label: string };
export type FeaturedImage = { provider: "local"; id: string; src: string; alt: string };
export type ContentParams = { style?: string; tone?: string };
