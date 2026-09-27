import type { Locale } from "./locale";
import type { ArticleParts, PortableTextBlock } from "./types";

export type StructureOptions = {
  headingLevel: "h2" | "h3";
  toc: boolean;
  tocHeader: string;
  faqHeader: string;
  outroHeader: string;
};

export const defaultStructure: StructureOptions = {
  headingLevel: "h2",
  toc: false,
  tocHeader: "Table of Contents",
  faqHeader: "FAQ",
  outroHeader: "Conclusion",
};

/** Headers the assembler adds itself (TOC, FAQ, conclusion), per locale. */
export const STRUCTURAL_HEADERS: Record<Locale, Pick<StructureOptions, "tocHeader" | "faqHeader" | "outroHeader">> = {
  en: { tocHeader: "Table of Contents", faqHeader: "FAQ", outroHeader: "Conclusion" },
  tr: { tocHeader: "İçindekiler", faqHeader: "Sıkça Sorulan Sorular", outroHeader: "Sonuç" },
};

/** The default structure with the locale's structural headers. */
export function structureFor(locale: Locale): StructureOptions {
  return { ...defaultStructure, ...STRUCTURAL_HEADERS[locale] };
}

// Deterministic: the LLM never produces Portable Text. Sections without a
// heading or without paragraphs are skipped (and left out of the TOC).
export function assemble(parts: ArticleParts, opts: StructureOptions): PortableTextBlock[] {
  const blocks: PortableTextBlock[] = [];
  const push = (style: PortableTextBlock["style"], text: string, listItem?: "bullet") => {
    const value = text.trim();
    if (!value) return;
    const key = `b${blocks.length}`;
    blocks.push({
      _type: "block",
      _key: key,
      style,
      markDefs: [],
      ...(listItem ? { listItem, level: 1 } : {}),
      children: [{ _type: "span", _key: `${key}s0`, text: value, marks: [] }],
    });
  };

  for (const p of parts.intro) push("normal", p);

  const sections = parts.sections.filter(
    (s) => s.heading.trim() && s.paragraphs.some((p) => p.trim()),
  );
  if (opts.toc && sections.length > 0) {
    push("h2", opts.tocHeader);
    for (const s of sections) push("normal", s.heading, "bullet");
  }
  for (const s of sections) {
    push(opts.headingLevel, s.heading);
    for (const p of s.paragraphs) push("normal", p);
  }

  if (parts.faq.length > 0) {
    push("h2", opts.faqHeader);
    for (const item of parts.faq) {
      push("h3", item.q);
      push("normal", item.a);
    }
  }

  if (parts.outro.some((p) => p.trim())) {
    push("h2", opts.outroHeader);
    for (const p of parts.outro) push("normal", p);
  }

  return blocks;
}
