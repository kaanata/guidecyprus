import { STRUCTURAL_HEADERS } from "./assemble";

type LooseBlock = { _type?: unknown; style?: unknown; listItem?: unknown; children?: unknown };

function isBlock(value: unknown): value is LooseBlock {
  return !!value && typeof value === "object" && (value as LooseBlock)._type === "block";
}

export function blockText(block: unknown): string {
  if (!isBlock(block) || !Array.isArray(block.children)) return "";
  return block.children
    .map((child) =>
      child && typeof child === "object" && typeof (child as { text?: unknown }).text === "string"
        ? (child as { text: string }).text
        : "",
    )
    .join("")
    .trim();
}

export function headingsOf(content: unknown, style: "h2" | "h3"): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is LooseBlock => isBlock(b) && b.style === style && !b.listItem)
    .map(blockText)
    .filter((text) => text.length > 0);
}

// Case- and accent-insensitive key, so "SONUÇ", "Sonuç" and "sonuc" compare equal.
const headerKey = (text: string) =>
  text
    .replace(/[ıİ]/g, "i")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();

// Headers the assembler adds itself, in every locale; they are not sections of the article.
const STRUCTURAL_KEYS = new Set(
  [
    ...Object.values(STRUCTURAL_HEADERS).flatMap((h) => [h.tocHeader, h.faqHeader, h.outroHeader]),
    "Frequently Asked Questions",
    "SSS",
  ].map(headerKey),
);

// Section headings for a rewrite: the post's h2 sections, or its h3 headings
// when it has fewer than two h2 sections.
export function rewriteOutline(content: unknown): string[] {
  const sections = (style: "h2" | "h3") =>
    headingsOf(content, style).filter((h) => !STRUCTURAL_KEYS.has(headerKey(h)));
  const h2 = sections("h2");
  if (h2.length >= 2) return h2;
  const h3 = sections("h3");
  return h3.length >= 2 ? h3 : h2;
}
