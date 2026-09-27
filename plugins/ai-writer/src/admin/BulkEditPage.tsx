import { useCallback, useEffect, useState } from "react";
import {
  BULK_ACTIONS,
  MAX_BULK_IDS,
  type BulkAction,
  type BulkEditResult,
  type BulkEditRow,
  type BulkEntry,
} from "../lib/bulk-edit";
import { languageFor, LOCALE_LABELS, LOCALES, localeOf, otherLocale, type Locale } from "../lib/locale";
import { formatCost } from "../lib/usage";
import { apiGet, apiPost } from "./api";
import { Checkbox } from "./Checkbox";
import { Field } from "./Field";
import { ModelSelect } from "./ModelSelect";
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
  tableStyle,
  tableWrapStyle,
  tdStyle,
  textareaClasses,
  thStyle,
} from "./ui";

const ACTION_LABELS: Record<BulkAction, string> = {
  rewrite: "Rewrite (clearer, same facts)",
  summarize: "Summarize (~40% of the length)",
  paraphrase: "Paraphrase (same length, new wording)",
  translate: "Translate (creates a draft in the other language)",
};

// Posts per request: small enough to show progress, large enough to be quick.
const CHUNK = 3;

export function BulkEditPage() {
  const [collection, setCollection] = useState("posts");
  // Posts of one locale at a time, so a batch never mixes languages.
  const [locale, setLocale] = useState<Locale>("en");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<BulkEntry[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<BulkAction>("rewrite");
  const [targetLocale, setTargetLocale] = useState<Locale>("tr");
  const [model, setModel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<BulkEditRow[]>([]);
  const [notice, setNotice] = useState<{ kind: "idle" | "error"; text: string }>({ kind: "idle", text: "" });

  const load = useCallback(async (coll: string, loc: Locale, q: string) => {
    setEntries(null);
    const r = await apiGet<{ entries: BulkEntry[] }>(
      `bulk/entries?${new URLSearchParams({ collection: coll, locale: loc, q })}`,
    );
    if (r.ok === true) {
      setEntries(r.data.entries);
    } else {
      setEntries([]);
      setNotice({ kind: "error", text: `Posts could not be loaded: ${r.error.message}` });
    }
  }, []);

  useEffect(() => {
    void load("posts", "en", "");
  }, [load]);

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? (s.includes(id) || s.length >= MAX_BULK_IDS ? s : [...s, id]) : s.filter((x) => x !== id)));

  const run = async () => {
    if (action === "translate" && targetLocale === locale) {
      setNotice({ kind: "error", text: `These posts are already in ${languageFor(locale)}; choose the other language.` });
      return;
    }
    const question =
      action === "translate"
        ? `Translate ${selected.length} post(s) into ${languageFor(targetLocale)}? Each becomes a new draft linked to its original; the originals are not changed.`
        : `${ACTION_LABELS[action].split(" ")[0]} ${selected.length} post(s)? Their body text is replaced.`;
    if (!window.confirm(question)) return;
    setRunning(true);
    setRows([]);
    const done: BulkEditRow[] = [];
    for (let i = 0; i < selected.length; i += CHUNK) {
      const ids = selected.slice(i, i + CHUNK);
      setNotice({ kind: "idle", text: `Working… ${done.length}/${selected.length} done.` });
      const r = await apiPost<BulkEditResult>("bulk/edit", {
        collection,
        ids,
        action,
        ...(action === "translate" ? { targetLocale } : {}),
        model,
        instructions,
      });
      if (r.ok === true) done.push(...r.data.results);
      else done.push(...ids.map((id) => ({ id, title: "", status: "error" as const, error: r.error.message })));
      setRows([...done]);
    }
    setRunning(false);
    const failed = done.filter((d) => d.status === "error").length;
    const cost = done.reduce((sum, d) => sum + (d.cost ?? 0), 0);
    setNotice({
      kind: failed > 0 ? "error" : "idle",
      text: `Done: ${done.length - failed} ${action === "translate" ? "translated" : "updated"}${failed > 0 ? `, ${failed} failed` : ""}. AI cost ${formatCost(cost)}.`,
    });
    setSelected([]);
  };

  const queueSlop = async () => {
    const r = await apiPost<{ queued: number; alreadyQueued: number }>("slop/queue", { collection, ids: selected });
    if (r.ok === false) {
      setNotice({ kind: "error", text: r.error.message });
      return;
    }
    const waiting = r.data.alreadyQueued > 0 ? ` ${r.data.alreadyQueued} were already queued.` : "";
    setNotice({
      kind: "idle",
      text: `Queued ${r.data.queued} post(s) for the no-AI-slop edit. They are edited and republished on the next checks (every 15 minutes); links and headings are kept.${waiting}`,
    });
    setSelected([]);
  };

  const titleOf = (row: BulkEditRow) => row.title || entries?.find((e) => e.id === row.id)?.title || row.id;

  return (
    <div style={stackStyle}>
      <header style={stackStyle}>
        <h2 className={cardTitleClasses}>AI Writer — Bulk Edit</h2>
        <p className={helperClasses}>
          Rewrite, summarize or paraphrase up to {MAX_BULK_IDS} posts at once, or translate them into the other
          language as new drafts linked to the originals. Only text-only bodies are handled; posts with images or embeds
          in the body are skipped. Changes to a published post are saved as a draft until you publish them.
        </p>
      </header>

      <section className={cardClasses}>
        <div style={stackStyle}>
          <h3 className={cardTitleClasses}>1. Pick posts</h3>
          <div style={rowStyle}>
            <Field label="Collection" htmlFor="aiw-bulk-collection">
              <input
                id="aiw-bulk-collection"
                className={inputClasses}
                value={collection}
                onChange={(e) => setCollection(e.target.value.trim())}
              />
            </Field>
            <Field label="Language" htmlFor="aiw-bulk-locale">
              <select
                id="aiw-bulk-locale"
                className={selectClasses}
                value={locale}
                onChange={(e) => {
                  const next = localeOf(e.target.value);
                  setLocale(next);
                  setTargetLocale(otherLocale(next));
                  setSelected([]);
                  void load(collection, next, search);
                }}
              >
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_LABELS[l]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Search" htmlFor="aiw-bulk-search">
              <input
                id="aiw-bulk-search"
                className={inputClasses}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void load(collection, locale, search);
                }}
              />
            </Field>
            <button
              type="button"
              className={buttonSecondaryClasses}
              style={{ alignSelf: "flex-end" }}
              onClick={() => {
                setSelected([]);
                void load(collection, locale, search);
              }}
            >
              Load
            </button>
          </div>
          <p className={helperClasses}>
            {selected.length}/{MAX_BULK_IDS} selected
          </p>
          <div style={{ ...listBoxStyle, maxHeight: "18rem" }}>
            {entries === null ? <p className={statusIdleClasses}>Loading posts…</p> : null}
            {entries !== null && entries.length === 0 ? <p className={helperClasses}>No posts found.</p> : null}
            {(entries ?? []).map((entry) => (
              <Checkbox
                key={entry.id}
                label={`${entry.title} (${entry.status})`}
                checked={selected.includes(entry.id)}
                onChange={(on) => toggle(entry.id, on)}
              />
            ))}
          </div>
        </div>
      </section>

      <section className={cardClasses}>
        <div style={stackStyle}>
          <h3 className={cardTitleClasses}>2. Choose the edit</h3>
          <div style={rowStyle}>
            <Field label="Action" htmlFor="aiw-bulk-action">
              <select
                id="aiw-bulk-action"
                className={selectClasses}
                value={action}
                onChange={(e) => setAction(e.target.value as BulkAction)}
              >
                {BULK_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABELS[a]}
                  </option>
                ))}
              </select>
            </Field>
            {action === "translate" ? (
              <Field label="Translate into" htmlFor="aiw-bulk-target">
                <select
                  id="aiw-bulk-target"
                  className={selectClasses}
                  value={targetLocale}
                  onChange={(e) => setTargetLocale(localeOf(e.target.value))}
                >
                  {LOCALES.filter((l) => l !== locale).map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_LABELS[l]}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
          <Field label="Model" helper="Blank uses the rewrite model from AI Writer Settings.">
            <ModelSelect kind="text" ariaLabel="Bulk edit model" value={model} onChange={setModel} placeholder="Default" />
          </Field>
          <Field label="Instructions (optional)" htmlFor="aiw-bulk-instructions">
            <textarea
              id="aiw-bulk-instructions"
              className={textareaClasses}
              maxLength={500}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </Field>
          <div style={rowStyle}>
            <button
              type="button"
              className={buttonPrimaryClasses}
              disabled={running || selected.length === 0}
              onClick={() => void run()}
            >
              {running ? "Working…" : `Apply to ${selected.length} post(s)`}
            </button>
            <button
              type="button"
              className={buttonSecondaryClasses}
              disabled={running || selected.length === 0}
              onClick={() => void queueSlop()}
              title="Removes AI-writing patterns (no-ai-slop rules) while keeping meaning, headings and internal links"
            >
              Queue no-AI-slop edit
            </button>
          </div>
          {notice.text ? (
            <p role="status" className={notice.kind === "error" ? statusErrorClasses : statusIdleClasses}>
              {notice.text}
            </p>
          ) : null}
        </div>
      </section>

      {rows.length > 0 ? (
        <section className={cardClasses}>
          <div style={stackStyle}>
            <h3 className={cardTitleClasses}>Results</h3>
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    {["Post", "Status", "Cost", "Details"].map((h) => (
                      <th key={h} style={thStyle}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td style={tdStyle}>
                        <a href={`/_emdash/admin/content/${collection}/${row.id}`}>{titleOf(row)}</a>
                      </td>
                      <td style={tdStyle}>
                        {row.status === "error" ? (
                          "Failed"
                        ) : row.createdId ? (
                          <a href={`/_emdash/admin/content/${collection}/${row.createdId}`}>Translation created</a>
                        ) : (
                          "Updated"
                        )}
                      </td>
                      <td style={tdStyle}>{formatCost(row.cost)}</td>
                      <td style={tdStyle}>
                        {row.error ? <span className={statusErrorClasses}>{row.error}</span> : null}
                        {row.warnings?.length ? <span className={helperClasses}>{row.warnings.join("; ")}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
