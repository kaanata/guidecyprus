import { useEffect, useState } from "react";
import { STRUCTURAL_HEADERS } from "../lib/assemble";
import { LOCALE_LABELS, LOCALES, localeOf } from "../lib/locale";
import { modelBelongsTo, PROVIDER_LABELS } from "../lib/providers";
import { MAX_FEEDS, type Rule, type TopicSource } from "../lib/rules";
import type { TermsResponse } from "../lib/routes";
import type { Settings } from "../lib/settings";
import type { TextSlot } from "../lib/types";
import { apiGet, apiPost } from "./api";
import { Checkbox } from "./Checkbox";
import { Field } from "./Field";
import { ModelSelect } from "./ModelSelect";
import { ruleInputFromForm, topicCount, type RuleForm } from "./rules-state";
import {
  buttonPrimaryClasses,
  buttonSecondaryClasses,
  cardClasses,
  cardTitleClasses,
  helperClasses,
  inputClasses,
  labelClasses,
  listBoxStyle,
  rowStyle,
  selectClasses,
  stackStyle,
  statusErrorClasses,
  textareaClasses,
} from "./ui";

// The steps a rule run actually calls (rewrite belongs to the editor panel).
const RULE_SLOTS = [
  "title",
  "outline",
  "section",
  "intro",
  "outro",
  "faq",
  "excerpt",
  "tags",
  "seo",
  "imagePrompt",
  "image",
] as const;
type RuleSlot = (typeof RULE_SLOTS)[number];
const SLOT_LABELS: Record<RuleSlot, string> = {
  title: "Title",
  outline: "Section headings",
  section: "Section content",
  intro: "Introduction",
  outro: "Conclusion",
  faq: "FAQ",
  excerpt: "Excerpt",
  tags: "Tags",
  seo: "SEO meta (collections with SEO)",
  imagePrompt: "Image prompt",
  image: "Featured image",
};

function defaultModel(slot: RuleSlot, settings: Settings | null): string {
  if (!settings) return "Settings default";
  if (slot === "image") return `Default (${settings.models.defaultImage})`;
  return `Default (${settings.models.steps[slot as TextSlot] || settings.models.defaultText})`;
}

// Collections the site writes to; a rule saved with another one keeps it.
const COLLECTIONS = ["posts", "pages"];

const NO_TERMS: TermsResponse = {
  category: [],
  tag: [],
  features: { featuredImage: true, excerpt: true, seo: false, categories: true, tags: true },
};

export function RuleDialog(props: {
  initial: RuleForm;
  settings: Settings | null;
  onCancel: () => void;
  onSaved: (rule: Rule, warnings: string[]) => void;
}) {
  const { settings } = props;
  const [form, setForm] = useState<RuleForm>(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Term pickers show only the rule locale's terms, and only taxonomies the collection uses.
  const [terms, setTerms] = useState<TermsResponse>(NO_TERMS);
  const { collection, locale } = form.options;
  useEffect(() => {
    let live = true;
    void apiGet<TermsResponse>(`terms?${new URLSearchParams({ collection, locale })}`).then((r) => {
      if (live && r.ok === true) setTerms(r.data);
    });
    return () => {
      live = false;
    };
  }, [collection, locale]);
  const { features } = terms;

  const set = (patch: Partial<RuleForm>) => setForm((f) => ({ ...f, ...patch }));
  const setOpt = (patch: Partial<RuleForm["options"]>) => setForm((f) => ({ ...f, options: { ...f.options, ...patch } }));
  const toggleTerm = (key: "categories" | "tags", slug: string) =>
    setForm((f) => {
      const list = f.options[key];
      const next = list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
      return { ...f, options: { ...f.options, [key]: next } };
    });
  const setSource = (topicSource: TopicSource) => setForm((f) => ({ ...f, topicSource }));
  const setModel = (slot: RuleSlot, id: string) =>
    setForm((f) => ({ ...f, options: { ...f.options, models: { ...f.options.models, [slot]: id } } }));

  const save = async () => {
    setSaving(true);
    setError("");
    const r = await apiPost<{ rule: Rule; warnings: string[] }>("rules/save", ruleInputFromForm(form));
    setSaving(false);
    if (r.ok === true) props.onSaved(r.data.rule, r.data.warnings);
    else setError(r.error.message);
  };

  const o = form.options;
  return (
    <section className={cardClasses}>
      <div style={stackStyle}>
        <h3 className={cardTitleClasses}>{form.id ? `Edit rule — ${props.initial.name}` : "New rule"}</h3>

        <Field label="Name" htmlFor="aiw-rule-name">
          <input id="aiw-rule-name" className={inputClasses} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field
          label="Topic source"
          htmlFor="aiw-rule-source"
          helper={
            form.topicSource === "list"
              ? "You type the topics; the rule stops when the queue is empty."
              : "Each run queues new headlines from the feeds below; items already used are skipped."
          }
        >
          <select
            id="aiw-rule-source"
            className={selectClasses}
            value={form.topicSource}
            onChange={(e) => setSource(e.target.value as TopicSource)}
          >
            <option value="list">Topics I type</option>
            <option value="rss">RSS / Atom feeds</option>
          </select>
        </Field>
        {form.topicSource === "rss" ? (
          <Field label={`Feed URLs (one per line, up to ${MAX_FEEDS})`} htmlFor="aiw-rule-feeds">
            <textarea
              id="aiw-rule-feeds"
              className={textareaClasses}
              placeholder="https://example.com/feed.xml"
              value={form.feedsText}
              onChange={(e) => set({ feedsText: e.target.value })}
            />
          </Field>
        ) : null}
        <Field
          label={form.topicSource === "list" ? "Topics (one per line)" : "Queued topics (filled automatically)"}
          htmlFor="aiw-rule-topics"
          helper={`${topicCount(form.topicsText)} queued. Each post uses the first topic; duplicates of existing posts are skipped. Start a line with a past date ("2026-08-03 | topic") to publish that post with that date.`}
        >
          <textarea
            id="aiw-rule-topics"
            className={textareaClasses}
            value={form.topicsText}
            onChange={(e) => set({ topicsText: e.target.value })}
          />
        </Field>
        <div style={rowStyle}>
          <Field label="Each line is" htmlFor="aiw-rule-topic-mode">
            <select
              id="aiw-rule-topic-mode"
              className={selectClasses}
              value={form.topicMode}
              onChange={(e) => set({ topicMode: e.target.value === "title" ? "title" : "topic" })}
            >
              <option value="topic">A topic or keyword (AI writes the title)</option>
              <option value="title">The exact post title</option>
            </select>
          </Field>
          <Field label="Every (hours)" htmlFor="aiw-rule-interval">
            <input
              id="aiw-rule-interval"
              type="number"
              min={1}
              max={168}
              className={inputClasses}
              value={form.intervalHours}
              onChange={(e) => set({ intervalHours: Number(e.target.value) })}
            />
          </Field>
          <Field label="Posts per run" htmlFor="aiw-rule-posts">
            <input
              id="aiw-rule-posts"
              type="number"
              min={1}
              max={5}
              className={inputClasses}
              value={form.postsPerRun}
              onChange={(e) => set({ postsPerRun: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Checkbox label="Active" checked={form.active} onChange={(v) => set({ active: v })} />

        <h4 className={labelClasses}>Structure</h4>
        <div style={rowStyle}>
          <Field label="Sections" htmlFor="aiw-rule-sections">
            <input
              id="aiw-rule-sections"
              type="number"
              min={2}
              max={12}
              className={inputClasses}
              value={o.sections}
              onChange={(e) => setOpt({ sections: Number(e.target.value) })}
            />
          </Field>
          <Field label="Paragraphs per section" htmlFor="aiw-rule-paragraphs">
            <input
              id="aiw-rule-paragraphs"
              type="number"
              min={1}
              max={6}
              className={inputClasses}
              value={o.paragraphsPerSection}
              onChange={(e) => setOpt({ paragraphsPerSection: Number(e.target.value) })}
            />
          </Field>
          <Field label="Heading level" htmlFor="aiw-rule-level">
            <select
              id="aiw-rule-level"
              className={selectClasses}
              value={o.headingLevel}
              onChange={(e) => setOpt({ headingLevel: e.target.value === "h3" ? "h3" : "h2" })}
            >
              <option value="h2">H2</option>
              <option value="h3">H3</option>
            </select>
          </Field>
        </div>
        <div style={rowStyle}>
          <Checkbox label="Introduction" checked={o.intro} onChange={(v) => setOpt({ intro: v })} />
          <Checkbox label="Conclusion" checked={o.outro} onChange={(v) => setOpt({ outro: v })} />
          <Checkbox label="Table of contents" checked={o.toc} onChange={(v) => setOpt({ toc: v })} />
          <Checkbox label="FAQ" checked={o.faq} onChange={(v) => setOpt({ faq: v })} />
        </div>
        {o.outro ? (
          <Field label="Conclusion heading" htmlFor="aiw-rule-outro-header">
            <input
              id="aiw-rule-outro-header"
              className={inputClasses}
              placeholder={STRUCTURAL_HEADERS[o.locale].outroHeader}
              value={o.outroHeader}
              onChange={(e) => setOpt({ outroHeader: e.target.value })}
            />
          </Field>
        ) : null}

        <h4 className={labelClasses}>Content parameters</h4>
        <div style={rowStyle}>
          <Field label="Language" htmlFor="aiw-rule-locale" helper="Posts are created in this locale and written in its language.">
            <select
              id="aiw-rule-locale"
              className={selectClasses}
              value={o.locale}
              onChange={(e) => setOpt({ locale: localeOf(e.target.value) })}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_LABELS[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Writing style" htmlFor="aiw-rule-style">
            <input
              id="aiw-rule-style"
              className={inputClasses}
              placeholder={settings?.style ?? "Settings default"}
              value={o.style}
              onChange={(e) => setOpt({ style: e.target.value })}
            />
          </Field>
          <Field label="Writing tone" htmlFor="aiw-rule-tone">
            <input
              id="aiw-rule-tone"
              className={inputClasses}
              placeholder={settings?.tone ?? "Settings default"}
              value={o.tone}
              onChange={(e) => setOpt({ tone: e.target.value })}
            />
          </Field>
        </div>

        <Field
          label="Instructions (optional)"
          htmlFor="aiw-rule-instructions"
          helper="Sent with every step of this rule's posts."
        >
          <textarea
            id="aiw-rule-instructions"
            className={textareaClasses}
            maxLength={500}
            value={o.instructions}
            onChange={(e) => setOpt({ instructions: e.target.value })}
          />
        </Field>

        <h4 className={labelClasses}>Image</h4>
        {features.featuredImage ? (
          <Checkbox
            label="Generate a featured image"
            checked={o.featuredImage}
            onChange={(v) => setOpt({ featuredImage: v })}
          />
        ) : (
          <p className={helperClasses}>The “{o.collection}” collection has no featured image.</p>
        )}

        <h4 className={labelClasses}>Posting</h4>
        <div style={rowStyle}>
          <Field
            label="Collection"
            htmlFor="aiw-rule-collection"
            helper={features.seo ? "SEO title and description are written for each post." : undefined}
          >
            <select
              id="aiw-rule-collection"
              className={selectClasses}
              value={o.collection}
              onChange={(e) => setOpt({ collection: e.target.value })}
            >
              {(COLLECTIONS.includes(o.collection) ? COLLECTIONS : [...COLLECTIONS, o.collection]).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status" htmlFor="aiw-rule-status">
            <select
              id="aiw-rule-status"
              className={selectClasses}
              value={o.status}
              onChange={(e) => setOpt({ status: e.target.value === "published" ? "published" : "draft" })}
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
            </select>
          </Field>
        </div>
        <Field label="Byline slug (optional)" htmlFor="aiw-rule-byline" helper="Credits posts to this byline, e.g. emdash-editorial.">
          <input
            id="aiw-rule-byline"
            className={inputClasses}
            value={o.byline}
            onChange={(e) => setOpt({ byline: e.target.value.trim() })}
          />
        </Field>
        {features.categories ? (
          <Field label="Categories" helper={`Terms of the ${LOCALE_LABELS[o.locale]} site.`}>
            <div style={listBoxStyle}>
              {terms.category.length === 0 ? <p className={helperClasses}>No categories yet.</p> : null}
              {terms.category.map((t) => (
                <Checkbox
                  key={t.slug}
                  label={t.label}
                  checked={o.categories.includes(t.slug)}
                  onChange={() => toggleTerm("categories", t.slug)}
                />
              ))}
            </div>
          </Field>
        ) : null}
        {features.tags ? (
          <>
            <Field label="Tags" helper="Only existing tags can be assigned.">
              <div style={listBoxStyle}>
                {terms.tag.length === 0 ? <p className={helperClasses}>No tags yet.</p> : null}
                {terms.tag.map((t) => (
                  <Checkbox
                    key={t.slug}
                    label={t.label}
                    checked={o.tags.includes(t.slug)}
                    onChange={() => toggleTerm("tags", t.slug)}
                  />
                ))}
              </div>
            </Field>
            <Checkbox
              label="Also add matching existing tags automatically"
              checked={o.autoTags}
              onChange={(v) => setOpt({ autoTags: v })}
            />
          </>
        ) : (
          <p className={helperClasses}>
            The “{o.collection}” collection has no {features.categories ? "tags" : "categories or tags"}.
          </p>
        )}

        <details>
          <summary className={labelClasses} style={{ cursor: "pointer" }}>
            Models (per step)
          </summary>
          <p className={helperClasses}>Leave a step blank to use the model chosen in AI Writer Settings.</p>
          <div style={{ ...stackStyle, marginTop: "1rem" }}>
            {RULE_SLOTS.map((slot) => {
              const kind = slot === "image" ? "image" : "text";
              const provider = settings ? settings.providers[kind] : undefined;
              const saved = o.models[slot] ?? "";
              // Overrides saved before a provider switch are skipped at run time.
              const stale = provider !== undefined && !modelBelongsTo(provider, saved);
              return (
                <Field
                  key={slot}
                  label={SLOT_LABELS[slot]}
                  helper={
                    stale ? `Not a ${PROVIDER_LABELS[provider]} model — the Settings default will be used.` : undefined
                  }
                >
                  <ModelSelect
                    kind={kind}
                    provider={provider}
                    ariaLabel={`${SLOT_LABELS[slot]} model for this rule`}
                    value={saved}
                    onChange={(id) => setModel(slot, id)}
                    placeholder={defaultModel(slot, settings)}
                  />
                </Field>
              );
            })}
          </div>
        </details>

        <div style={rowStyle}>
          <button type="button" className={buttonPrimaryClasses} disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save rule"}
          </button>
          <button type="button" className={buttonSecondaryClasses} disabled={saving} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
        {error ? (
          <p role="alert" className={statusErrorClasses}>
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
