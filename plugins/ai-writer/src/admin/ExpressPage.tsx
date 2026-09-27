import { useEffect, useRef, useState } from "react";
import { LOCALE_LABELS, LOCALES, localeOf } from "../lib/locale";
import type { ExpressCreateResult, StepResult, TermsResponse } from "../lib/routes";
import type { Settings } from "../lib/settings";
import type { FeaturedImage, TextSlot } from "../lib/types";
import { formatCost, roundCost } from "../lib/usage";
import { apiGet, apiPost } from "./api";
import {
  alignSections,
  canCreate,
  contentParams,
  headingsFromText,
  initialExpressState,
  loadDraft,
  paragraphsToText,
  pendingParts,
  saveDraft,
  toCreatePayload,
  type DraftSection,
  type ExpressModelSlot,
  type ExpressState,
  type PendingPart,
} from "./express-state";
import { Field } from "./Field";
import { ModelSelect } from "./ModelSelect";
import { Checkbox } from "./Checkbox";
import {
  buttonPrimaryClasses,
  buttonSecondaryClasses,
  cardClasses,
  cardTitleClasses,
  helperClasses,
  inputClasses,
  listBoxStyle,
  rowStyle,
  selectClasses,
  stackStyle,
  statusErrorClasses,
  statusIdleClasses,
  textareaClasses,
  twoColumnStyle,
} from "./ui";

type PartStatus = { busy: boolean; error: string };

const SECTION_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const PARAGRAPH_COUNTS = [1, 2, 3, 4, 5, 6];
const COLLECTIONS = ["posts", "pages"];

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// Runs fn over items with at most `limit` in flight. fn must not throw.
async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// Section text is keyed by heading and never dropped while typing, so
// editing a heading doesn't erase its generated body.
function withSectionText(sections: DraftSection[], heading: string, text: string): DraftSection[] {
  return sections.some((s) => s.heading === heading)
    ? sections.map((s) => (s.heading === heading ? { ...s, text } : s))
    : [...sections, { heading, text }];
}

function toggle(list: string[], slug: string): string[] {
  return list.includes(slug) ? list.filter((x) => x !== slug) : [...list, slug];
}

async function callStep(body: Record<string, unknown>): Promise<StepResult> {
  const r = await apiPost<StepResult>("step", body);
  if (r.ok === false) throw new Error(r.error.message);
  return r.data;
}

function GenerateControl(props: {
  label: string;
  kind?: "text" | "image";
  status?: PartStatus;
  disabled?: boolean;
  model: string;
  modelPlaceholder: string;
  onModel: (id: string) => void;
  onRun: () => void;
}) {
  const busy = props.status?.busy ?? false;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <div style={rowStyle}>
        <button
          type="button"
          className={buttonSecondaryClasses}
          disabled={props.disabled || busy}
          onClick={props.onRun}
        >
          {busy ? "Generating…" : props.label}
        </button>
        <ModelSelect
          compact
          kind={props.kind ?? "text"}
          ariaLabel={`${props.label} model`}
          value={props.model}
          onChange={props.onModel}
          placeholder={props.modelPlaceholder}
        />
      </div>
      {props.status?.error ? (
        <p role="alert" className={statusErrorClasses}>
          {props.status.error}
        </p>
      ) : null}
    </div>
  );
}

export function ExpressPage() {
  const [state, setState] = useState<ExpressState>(() => loadDraft(browserStorage()));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [parts, setParts] = useState<Partial<Record<PendingPart, PartStatus>>>({});
  // Terms of the chosen locale, and what the chosen collection can hold (null while loading).
  const [terms, setTerms] = useState<TermsResponse | null>(null);
  const features = terms?.features ?? null;
  const [defaults, setDefaults] = useState<Settings["models"] | null>(null);
  const [progress, setProgress] = useState("");
  const [runningAll, setRunningAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ExpressCreateResult | null>(null);
  const [createError, setCreateError] = useState("");
  // What this page's AI calls have cost since it was opened (USD).
  const [spent, setSpent] = useState(0);
  const spend = (cost: number | undefined) => {
    if (cost) setSpent((x) => roundCost(x + cost));
  };
  const trackedStep = async (body: Record<string, unknown>) => {
    const r = await callStep(body);
    spend(r.cost);
    return r;
  };

  useEffect(() => {
    saveDraft(browserStorage(), state);
  }, [state]);

  useEffect(() => {
    void apiGet<{ settings: Settings }>("settings").then((r) => {
      if (r.ok === true) setDefaults(r.data.settings.models);
    });
  }, []);

  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ collection: state.collection, locale: state.locale });
    void apiGet<TermsResponse>(`terms?${query}`).then((r) => {
      if (live && r.ok === true) setTerms(r.data);
    });
    return () => {
      live = false;
    };
  }, [state.collection, state.locale]);

  const patch = (p: Partial<ExpressState>) => setState((prev) => ({ ...prev, ...p }));
  const setPart = (part: PendingPart, status: PartStatus) => setParts((prev) => ({ ...prev, [part]: status }));
  const pickModel = (slot: ExpressModelSlot) => stateRef.current.models[slot] || undefined;
  const setModel = (slot: ExpressModelSlot, id: string) =>
    setState((prev) => ({ ...prev, models: { ...prev.models, [slot]: id } }));
  const defaultFor = (slot: ExpressModelSlot) => {
    if (!defaults) return "Default model";
    if (slot === "image") return `Default (${defaults.defaultImage})`;
    return `Default (${defaults.steps[slot as TextSlot] || defaults.defaultText})`;
  };

  async function runPart(part: PendingPart, s: ExpressState): Promise<Partial<ExpressState>> {
    const title = s.title.trim();
    const headings = headingsFromText(s.headingsText);
    const params = contentParams(s);
    const needTitle = () => {
      if (!title) throw new Error("Add a title first.");
    };
    const needHeadings = () => {
      needTitle();
      if (headings.length === 0) throw new Error("Add section headings first.");
    };

    switch (part) {
      case "title": {
        if (!s.topic.trim()) throw new Error("Enter a topic first.");
        const r = await trackedStep({ ...params, step: "title", topic: s.topic.trim(), model: pickModel("title") });
        if (!("title" in r)) throw new Error("Unexpected response");
        return { title: r.title };
      }
      case "outline": {
        needTitle();
        const r = await trackedStep({ ...params, step: "outline", title, count: s.sectionCount, model: pickModel("outline") });
        if (!("headings" in r)) throw new Error("Unexpected response");
        return { headingsText: r.headings.join("\n"), sections: alignSections(r.headings, s.sections) };
      }
      case "sections": {
        needHeadings();
        const todo = alignSections(headings, s.sections).filter((x) => !x.text.trim());
        const failures: string[] = [];
        let done = 0;
        setProgress(`Sections 0/${todo.length}`);
        await runLimited(todo, 3, async (section) => {
          try {
            const r = await trackedStep({
              ...params,
              step: "section",
              title,
              heading: section.heading,
              paragraphs: s.paragraphsPerSection,
              model: pickModel("section"),
            });
            if (!("paragraphs" in r)) throw new Error("Unexpected response");
            const text = paragraphsToText(r.paragraphs);
            setState((prev) => ({ ...prev, sections: withSectionText(prev.sections, section.heading, text) }));
          } catch (err) {
            failures.push(`${section.heading}: ${(err as Error).message}`);
          } finally {
            done += 1;
            setProgress(`Sections ${done}/${todo.length}`);
          }
        });
        setProgress("");
        if (failures.length > 0) throw new Error(failures.join(" · "));
        return {};
      }
      case "intro":
      case "outro": {
        needHeadings();
        const r = await trackedStep({ ...params, step: part, title, headings, model: pickModel(part) });
        if (!("paragraphs" in r)) throw new Error("Unexpected response");
        const text = paragraphsToText(r.paragraphs);
        return part === "intro" ? { intro: text } : { outro: text };
      }
      case "faq": {
        needTitle();
        const r = await trackedStep({ ...params, step: "faq", title, model: pickModel("faq") });
        if (!("items" in r)) throw new Error("Unexpected response");
        return { faq: r.items };
      }
      case "excerpt": {
        needHeadings();
        const r = await trackedStep({ ...params, step: "excerpt", title, headings, model: pickModel("excerpt") });
        if (!("excerpt" in r)) throw new Error("Unexpected response");
        return { excerpt: r.excerpt };
      }
      case "tags": {
        needTitle();
        const r = await trackedStep({ ...params, step: "tags", title, model: pickModel("tags") });
        if (!("tags" in r)) throw new Error("Unexpected response");
        return { tags: Array.from(new Set([...s.tags, ...r.tags])) };
      }
      case "image": {
        needTitle();
        const r = await apiPost<{ featuredImage: FeaturedImage; cost: number }>("image", {
          prompt: title,
          alt: title,
          model: pickModel("image"),
        });
        if (r.ok === false) throw new Error(r.error.message);
        spend(r.data.cost);
        return { featuredImage: r.data.featuredImage };
      }
      default:
        throw new Error(`Unknown part ${String(part)}`);
    }
  }

  async function run(part: PendingPart) {
    setPart(part, { busy: true, error: "" });
    try {
      patch(await runPart(part, stateRef.current));
      setPart(part, { busy: false, error: "" });
    } catch (err) {
      setPart(part, { busy: false, error: (err as Error).message });
    }
  }

  async function generateAll() {
    setRunningAll(true);
    let snapshot = stateRef.current;
    for (const part of pendingParts(snapshot, features)) {
      setPart(part, { busy: true, error: "" });
      try {
        const p = await runPart(part, snapshot);
        snapshot = { ...snapshot, ...p };
        patch(p);
        setPart(part, { busy: false, error: "" });
      } catch (err) {
        setPart(part, { busy: false, error: (err as Error).message });
        break;
      }
    }
    setRunningAll(false);
  }

  async function createPost() {
    setCreating(true);
    setCreateError("");
    setCreated(null);
    const r = await apiPost<ExpressCreateResult>("express/create", toCreatePayload(stateRef.current, features));
    setCreating(false);
    if (r.ok === true) {
      setCreated(r.data);
      spend(r.data.cost);
    }
    else setCreateError(r.error.message);
  }

  function clearDraft() {
    setState(initialExpressState);
    setParts({});
    setCreated(null);
    setCreateError("");
    setProgress("");
  }

  const control = (label: string, part: PendingPart, slot: ExpressModelSlot, kind: "text" | "image" = "text") => (
    <GenerateControl
      label={label}
      kind={kind}
      status={parts[part]}
      disabled={runningAll}
      model={state.models[slot] ?? ""}
      modelPlaceholder={defaultFor(slot)}
      onModel={(id) => setModel(slot, id)}
      onRun={() => void run(part)}
    />
  );

  const headings = headingsFromText(state.headingsText);
  const sections = alignSections(headings, state.sections);

  return (
    <div style={stackStyle}>
      <header style={stackStyle}>
        <h2 className={cardTitleClasses}>AI Writer — Express Mode</h2>
        <p className={helperClasses}>
          Build a post step by step. Every part stays editable; Generate all fills only what is still empty.
        </p>
        <p className={helperClasses}>AI cost on this page so far: {formatCost(spent)}</p>
      </header>

      <div style={twoColumnStyle}>
        <div style={stackStyle}>
          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>Topic & title</h3>
              <Field label="Topic" htmlFor="aiw-topic" helper="What the article is about, e.g. a keyword or question.">
                <input
                  id="aiw-topic"
                  className={inputClasses}
                  value={state.topic}
                  onChange={(e) => patch({ topic: e.target.value })}
                />
              </Field>
              {control("Generate title", "title", "title")}
              <Field label="Title" htmlFor="aiw-title">
                <input
                  id="aiw-title"
                  className={inputClasses}
                  value={state.title}
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </Field>
            </div>
          </section>

          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>Sections</h3>
              <div style={rowStyle}>
                <Field label="Sections" htmlFor="aiw-count">
                  <select
                    id="aiw-count"
                    className={selectClasses}
                    value={state.sectionCount}
                    onChange={(e) => patch({ sectionCount: Number(e.target.value) })}
                  >
                    {SECTION_COUNTS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Paragraphs per section" htmlFor="aiw-paras">
                  <select
                    id="aiw-paras"
                    className={selectClasses}
                    value={state.paragraphsPerSection}
                    onChange={(e) => patch({ paragraphsPerSection: Number(e.target.value) })}
                  >
                    {PARAGRAPH_COUNTS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Heading level" htmlFor="aiw-level">
                  <select
                    id="aiw-level"
                    className={selectClasses}
                    value={state.headingLevel}
                    onChange={(e) => patch({ headingLevel: e.target.value === "h3" ? "h3" : "h2" })}
                  >
                    <option value="h2">H2</option>
                    <option value="h3">H3</option>
                  </select>
                </Field>
              </div>
              <Checkbox label="Add a table of contents" checked={state.toc} onChange={(v) => patch({ toc: v })} />
              {control("Generate headings", "outline", "outline")}
              <Field label="Section headings (one per line)" htmlFor="aiw-headings">
                <textarea
                  id="aiw-headings"
                  className={textareaClasses}
                  value={state.headingsText}
                  onChange={(e) => patch({ headingsText: e.target.value })}
                />
              </Field>
              {control("Generate content", "sections", "section")}
              {progress ? (
                <p role="status" className={statusIdleClasses}>
                  {progress}
                </p>
              ) : null}
              {sections.map((section) => (
                <Field key={section.heading} label={section.heading}>
                  <textarea
                    aria-label={`Content for ${section.heading}`}
                    className={textareaClasses}
                    value={section.text}
                    placeholder="Paragraphs separated by a blank line"
                    onChange={(e) => {
                      const text = e.target.value;
                      setState((prev) => ({ ...prev, sections: withSectionText(prev.sections, section.heading, text) }));
                    }}
                  />
                </Field>
              ))}
            </div>
          </section>

          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>Introduction</h3>
              <Checkbox label="Include an introduction" checked={state.includeIntro} onChange={(v) => patch({ includeIntro: v })} />
              {state.includeIntro ? (
                <>
                  {control("Generate introduction", "intro", "intro")}
                  <textarea
                    aria-label="Introduction"
                    className={textareaClasses}
                    value={state.intro}
                    onChange={(e) => patch({ intro: e.target.value })}
                  />
                </>
              ) : null}
            </div>
          </section>

          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>Conclusion</h3>
              <Checkbox label="Include a conclusion" checked={state.includeOutro} onChange={(v) => patch({ includeOutro: v })} />
              {state.includeOutro ? (
                <>
                  {control("Generate conclusion", "outro", "outro")}
                  <textarea
                    aria-label="Conclusion"
                    className={textareaClasses}
                    value={state.outro}
                    onChange={(e) => patch({ outro: e.target.value })}
                  />
                </>
              ) : null}
            </div>
          </section>

          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>FAQ</h3>
              <Checkbox label="Include an FAQ" checked={state.includeFaq} onChange={(v) => patch({ includeFaq: v })} />
              {state.includeFaq ? (
                <>
                  {control("Generate FAQ", "faq", "faq")}
                  {state.faq.map((item, i) => (
                    <div key={i} style={stackStyle}>
                      <input
                        aria-label={`Question ${i + 1}`}
                        className={inputClasses}
                        value={item.q}
                        onChange={(e) =>
                          patch({ faq: state.faq.map((f, j) => (j === i ? { ...f, q: e.target.value } : f)) })
                        }
                      />
                      <textarea
                        aria-label={`Answer ${i + 1}`}
                        className={textareaClasses}
                        value={item.a}
                        onChange={(e) =>
                          patch({ faq: state.faq.map((f, j) => (j === i ? { ...f, a: e.target.value } : f)) })
                        }
                      />
                      <div style={rowStyle}>
                        <button
                          type="button"
                          className={buttonSecondaryClasses}
                          onClick={() => patch({ faq: state.faq.filter((_, j) => j !== i) })}
                        >
                          Remove question
                        </button>
                      </div>
                    </div>
                  ))}
                  <div style={rowStyle}>
                    <button
                      type="button"
                      className={buttonSecondaryClasses}
                      onClick={() => patch({ faq: [...state.faq, { q: "", a: "" }] })}
                    >
                      Add question
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </section>

          {features?.excerpt === false ? null : (
            <section className={cardClasses}>
              <div style={stackStyle}>
                <h3 className={cardTitleClasses}>Excerpt</h3>
                {control("Generate excerpt", "excerpt", "excerpt")}
                <textarea
                  aria-label="Excerpt"
                  className={textareaClasses}
                  value={state.excerpt}
                  onChange={(e) => patch({ excerpt: e.target.value })}
                />
              </div>
            </section>
          )}
        </div>

        <div style={stackStyle}>
          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>Create</h3>
              <button
                type="button"
                className={buttonPrimaryClasses}
                disabled={runningAll || creating}
                onClick={() => void generateAll()}
              >
                {runningAll ? "Generating…" : "Generate all"}
              </button>
              <button
                type="button"
                className={buttonPrimaryClasses}
                disabled={!canCreate(state) || creating || runningAll}
                onClick={() => void createPost()}
              >
                {creating ? "Creating…" : "Create post"}
              </button>
              <button type="button" className={buttonSecondaryClasses} disabled={runningAll || creating} onClick={clearDraft}>
                Clear draft
              </button>
              {created ? (
                <div role="status" style={stackStyle}>
                  <p className={statusIdleClasses}>
                    {created.status === "published" ? "Published" : "Created draft"} “{state.title}”.{" "}
                    <a href={created.editUrl}>Open in the editor</a>
                  </p>
                  {created.cost > 0 ? (
                    <p className={helperClasses}>No-AI-slop edit cost {formatCost(created.cost)}.</p>
                  ) : null}
                  {created.warnings.map((w) => (
                    <p key={w} className={helperClasses}>
                      {w}
                    </p>
                  ))}
                </div>
              ) : null}
              {createError ? (
                <p role="alert" className={statusErrorClasses}>
                  {createError}
                </p>
              ) : null}
            </div>
          </section>

          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>Post options</h3>
              <div style={rowStyle}>
                <Field label="Language" htmlFor="aiw-locale" helper="The post is created in this locale and written in its language.">
                  <select
                    id="aiw-locale"
                    className={selectClasses}
                    value={state.locale}
                    onChange={(e) => patch({ locale: localeOf(e.target.value) })}
                  >
                    {LOCALES.map((l) => (
                      <option key={l} value={l}>
                        {LOCALE_LABELS[l]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Collection" htmlFor="aiw-collection">
                  <select
                    id="aiw-collection"
                    className={selectClasses}
                    value={state.collection}
                    onChange={(e) => patch({ collection: e.target.value })}
                  >
                    {COLLECTIONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {features?.seo ? (
                <p className={helperClasses}>An SEO title and description are written when the post is created.</p>
              ) : null}
              <Field label="Status" htmlFor="aiw-status">
                <select
                  id="aiw-status"
                  className={selectClasses}
                  value={state.status}
                  onChange={(e) => patch({ status: e.target.value === "published" ? "published" : "draft" })}
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                </select>
              </Field>
              {features?.categories === false ? null : (
                <Field label="Categories" helper={`Terms of the ${LOCALE_LABELS[state.locale]} site.`}>
                  <div style={listBoxStyle}>
                    {(terms?.category.length ?? 0) === 0 ? <p className={helperClasses}>No categories yet.</p> : null}
                    {(terms?.category ?? []).map((t) => (
                      <Checkbox
                        key={t.slug}
                        label={t.label}
                        checked={state.categories.includes(t.slug)}
                        onChange={() => patch({ categories: toggle(state.categories, t.slug) })}
                      />
                    ))}
                  </div>
                </Field>
              )}
              {features?.tags === false ? null : (
                <>
                  <Field label="Tags" helper="Only existing tags can be assigned.">
                    <div style={listBoxStyle}>
                      {(terms?.tag.length ?? 0) === 0 ? <p className={helperClasses}>No tags yet.</p> : null}
                      {(terms?.tag ?? []).map((t) => (
                        <Checkbox
                          key={t.slug}
                          label={t.label}
                          checked={state.tags.includes(t.slug)}
                          onChange={() => patch({ tags: toggle(state.tags, t.slug) })}
                        />
                      ))}
                    </div>
                  </Field>
                  <Checkbox
                    label="Let AI pick tags from the existing list"
                    checked={state.autoTags}
                    onChange={(v) => patch({ autoTags: v })}
                  />
                  {state.autoTags ? control("Pick tags", "tags", "tags") : null}
                </>
              )}
            </div>
          </section>

          {features?.featuredImage === false ? null : (
            <section className={cardClasses}>
              <div style={stackStyle}>
                <h3 className={cardTitleClasses}>Featured image</h3>
                {control("Generate image", "image", "image", "image")}
                {state.featuredImage ? (
                  <>
                    <img
                      src={state.featuredImage.src}
                      alt={state.featuredImage.alt}
                      style={{ maxWidth: "100%", borderRadius: "0.5rem" }}
                    />
                    <div style={rowStyle}>
                      <button
                        type="button"
                        className={buttonSecondaryClasses}
                        onClick={() => patch({ featuredImage: null })}
                      >
                        Remove image
                      </button>
                    </div>
                  </>
                ) : (
                  <p className={helperClasses}>No image yet. Generated from the title.</p>
                )}
              </div>
            </section>
          )}

          <section className={cardClasses}>
            <div style={stackStyle}>
              <h3 className={cardTitleClasses}>Content parameters</h3>
              <Field label="Writing style" htmlFor="aiw-p-style">
                <input
                  id="aiw-p-style"
                  className={inputClasses}
                  placeholder="Settings default"
                  value={state.style}
                  onChange={(e) => patch({ style: e.target.value })}
                />
              </Field>
              <Field label="Writing tone" htmlFor="aiw-p-tone">
                <input
                  id="aiw-p-tone"
                  className={inputClasses}
                  placeholder="Settings default"
                  value={state.tone}
                  onChange={(e) => patch({ tone: e.target.value })}
                />
              </Field>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
