import { useEffect, useRef, useState } from "react";
import type { CollectionFeatures } from "../lib/collections";
import { languageFor, localeOf } from "../lib/locale";
import { PANEL_FIELDS, type PanelField, type PanelGenerateResult, type PanelPreview } from "../lib/panel";
import { formatCost } from "../lib/usage";
import { apiPost } from "./api";
import { Checkbox } from "./Checkbox";
import { Field } from "./Field";
import { ModelSelect } from "./ModelSelect";
import {
  availableFields,
  FIELD_LABELS,
  hasKeptValues,
  initialPanelState,
  keptValues,
  previewFields,
  selectedFields,
  type PanelState,
} from "./panel-state";
import {
  buttonPrimaryClasses,
  chipClasses,
  helperClasses,
  labelClasses,
  rowStyle,
  stackStyle,
  statusErrorClasses,
  statusIdleClasses,
  textareaClasses,
} from "./ui";

// Structural subset of @emdash-cms/admin's ContentEditorPanelContext. The host
// passes the saved entry (not live form state) and the editor's locale.
export type EditorPanelProps = {
  collection: string;
  entry: { id: string; status?: string; locale?: string | null; data?: Record<string, unknown> };
  locale?: string;
};

type Busy = "idle" | "generating" | "applying";

const rowGap = { ...stackStyle, gap: "0.25rem" } as const;

function PreviewValue(props: { field: PanelField; preview: PanelPreview }) {
  const { field, preview } = props;
  if (field === "title") return <p className={labelClasses}>{preview.title}</p>;
  if (field === "excerpt") return <p className={helperClasses}>{preview.excerpt}</p>;
  if (field === "tags") {
    return (
      <div style={rowStyle}>
        {(preview.tags ?? []).map((t) => (
          <span key={t.slug} className={chipClasses}>
            {t.label}
          </span>
        ))}
      </div>
    );
  }
  if (field === "image") {
    return preview.featuredImage ? (
      <img
        src={preview.featuredImage.src}
        alt={preview.featuredImage.alt}
        style={{ width: "100%", borderRadius: "0.5rem", border: "1px solid var(--color-kumo-line)" }}
      />
    ) : null;
  }
  if (field === "seo") {
    return (
      <div>
        <p className={labelClasses}>{preview.seo?.metaTitle}</p>
        <p className={helperClasses}>{preview.seo?.metaDescription}</p>
      </div>
    );
  }
  const blocks = preview.content ?? [];
  const sections = blocks
    .filter((b) => b.style === "h2")
    .map((b) => b.children.map((c) => c.text).join(""));
  return (
    <p className={helperClasses}>
      {blocks.length} blocks · {sections.join(" · ")}
    </p>
  );
}

export function EditorPanel(props: EditorPanelProps) {
  const { collection, entry } = props;
  // The saved entry's locale wins; the editor's locale covers entries saved without one.
  const locale = localeOf(entry.locale ?? props.locale);
  const [state, setState] = useState<PanelState>(initialPanelState);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState("");
  const [lastCost, setLastCost] = useState<number | null>(null);
  // What the collection can hold (pages have no image, tags or SEO); null while loading.
  const [features, setFeatures] = useState<CollectionFeatures | null>(null);
  const applying = useRef(false);
  const patch = (next: Partial<PanelState>) => setState((s) => ({ ...s, ...next }));
  const offered = availableFields(features);
  const fields = selectedFields(state, features);
  const shown = previewFields(state.preview);

  useEffect(() => {
    let live = true;
    void apiPost<CollectionFeatures>("panel/features", { collection }).then((r) => {
      if (live && r.ok === true) setFeatures(r.data);
    });
    return () => {
      live = false;
    };
  }, [collection]);

  const generate = async () => {
    setBusy("generating");
    setError("");
    setState((s) => ({ ...s, preview: null, errors: {}, warnings: [] }));
    const r = await apiPost<PanelGenerateResult>("panel/generate", {
      collection,
      id: entry.id,
      locale,
      fields,
      models: state.models,
      instructions: state.instructions,
    });
    setBusy("idle");
    if (r.ok === true) {
      setLastCost(r.data.cost);
      setState((s) => ({
        ...s,
        preview: r.data.values,
        errors: r.data.errors,
        warnings: r.data.warnings,
        keep: initialPanelState().keep,
      }));
    } else {
      setError(r.error.message);
    }
  };

  const apply = async () => {
    if (applying.current) return;
    applying.current = true;
    setBusy("applying");
    if (!window.confirm("Apply the kept changes? The editor will reload; unsaved changes will be lost.")) {
      applying.current = false;
      setBusy("idle");
      return;
    }
    setError("");
    const r = await apiPost<{ ok: true; status: string }>("panel/apply", {
      collection,
      id: entry.id,
      locale,
      values: keptValues(state.preview, state.keep),
    });
    if (r.ok === true) {
      window.location.reload();
      return;
    }
    applying.current = false;
    setBusy("idle");
    setError(r.error.message);
  };

  return (
    <div style={stackStyle}>
      {entry.status === "published" ? (
        <p className={helperClasses}>
          Published entry: title, excerpt, body and image changes are saved as a draft — publish them from the editor.
          Tags and SEO meta apply immediately.
        </p>
      ) : null}

      <p className={helperClasses}>Writes in {languageFor(locale)}, the language of this entry.</p>

      {offered.map((field) => (
        <div key={field} style={rowGap}>
          <Checkbox
            label={FIELD_LABELS[field]}
            checked={state.selected[field]}
            onChange={(v) => patch({ selected: { ...state.selected, [field]: v } })}
          />
          <ModelSelect
            compact
            kind={field === "image" ? "image" : "text"}
            ariaLabel={`${FIELD_LABELS[field]} model`}
            value={state.models[field] ?? ""}
            onChange={(id) => patch({ models: { ...state.models, [field]: id } })}
            placeholder="Default"
          />
        </div>
      ))}

      <Field label="Instructions (optional)" htmlFor="aiw-panel-instructions">
        <textarea
          id="aiw-panel-instructions"
          className={textareaClasses}
          maxLength={500}
          value={state.instructions}
          onChange={(e) => patch({ instructions: e.target.value })}
        />
      </Field>

      <div style={rowStyle}>
        <button
          type="button"
          className={buttonPrimaryClasses}
          disabled={busy !== "idle" || fields.length === 0}
          onClick={() => void generate()}
        >
          {busy === "generating" ? "Generating…" : "Generate"}
        </button>
      </div>
      {lastCost !== null && busy === "idle" ? <p className={helperClasses}>Last generation cost {formatCost(lastCost)}</p> : null}
      {busy === "generating" ? (
        <p role="status" className={statusIdleClasses}>
          Writing… a body rewrite can take a minute.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={statusErrorClasses}>
          {error}
        </p>
      ) : null}

      {state.preview ? (
        <div style={stackStyle}>
          {PANEL_FIELDS.filter((field) => state.errors[field]).map((field) => (
            <p key={field} role="alert" className={statusErrorClasses}>
              {FIELD_LABELS[field]}: {state.errors[field]}
            </p>
          ))}
          {state.warnings.map((w) => (
            <p key={w} className={helperClasses}>
              {w}
            </p>
          ))}
          {shown.map((field) => (
            <div key={field} style={rowGap}>
              <Checkbox
                label={`Keep: ${FIELD_LABELS[field]}`}
                checked={state.keep[field]}
                onChange={(v) => patch({ keep: { ...state.keep, [field]: v } })}
              />
              <PreviewValue field={field} preview={state.preview as PanelPreview} />
            </div>
          ))}
          <div style={rowStyle}>
            <button
              type="button"
              className={buttonPrimaryClasses}
              disabled={busy !== "idle" || !hasKeptValues(state.preview, state.keep)}
              onClick={() => void apply()}
            >
              {busy === "applying" ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
