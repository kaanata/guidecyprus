import { useCallback, useEffect, useState } from "react";
import { LOCALE_LABELS, localeOf } from "../lib/locale";
import { topicSourceOf, type Rule } from "../lib/rules";
import type { StoredRun } from "../lib/runs";
import { formatCost } from "../lib/usage";
import type { Settings } from "../lib/settings";
import { apiGet, apiPost } from "./api";
import { RuleDialog } from "./RuleDialog";
import { emptyRuleForm, formatWhen, formFromRule, ruleStatus, type RuleForm } from "./rules-state";
import {
  buttonPrimaryClasses,
  buttonSecondaryClasses,
  cardClasses,
  cardTitleClasses,
  checkboxAccentStyle,
  helperClasses,
  rowStyle,
  stackStyle,
  statusErrorClasses,
  statusIdleClasses,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./ui";

type Notice = { kind: "idle" | "error"; text: string };

const SOURCE_LABELS = { list: "Typed topics", rss: "RSS feeds" } as const;

export function RulesPage() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<RuleForm | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<Notice>({ kind: "idle", text: "" });
  const [now, setNow] = useState(() => new Date());

  const refresh = useCallback(async () => {
    const [r, h] = await Promise.all([
      apiGet<{ rules: Rule[] }>("rules"),
      apiGet<{ runs: StoredRun[] }>("runs?limit=20"),
    ]);
    const errors: string[] = [];
    if (r.ok === true) setRules(r.data.rules);
    else errors.push(`Rules could not be loaded: ${r.error.message}`);
    if (h.ok === true) setRuns(h.data.runs);
    else errors.push(`Recent runs could not be loaded: ${h.error.message}`);
    if (errors.length > 0) setNotice({ kind: "error", text: errors.join(" ") });
    setNow(new Date());
  }, []);

  useEffect(() => {
    void refresh();
    void apiGet<{ settings: Settings }>("settings").then((r) => {
      if (r.ok === true) setSettings(r.data.settings);
    });
  }, [refresh]);

  const setBusyFor = (id: string, value: boolean) => setBusy((b) => ({ ...b, [id]: value }));

  const toggleActive = async (rule: Rule) => {
    setBusyFor(rule.id, true);
    const r = await apiPost<{ rule: Rule; warnings: string[] }>("rules/toggle", {
      id: rule.id,
      active: !rule.active,
    });
    setBusyFor(rule.id, false);
    if (r.ok === false) setNotice({ kind: "error", text: r.error.message });
    else if (r.data.warnings.length > 0) setNotice({ kind: "error", text: r.data.warnings.join("; ") });
    await refresh();
  };

  const runNow = async (rule: Rule) => {
    setBusyFor(rule.id, true);
    setNotice({ kind: "idle", text: `Writing a post for “${rule.name}”… this can take a few minutes.` });
    const r = await apiPost<{ run: StoredRun }>("rules/run", { id: rule.id });
    setBusyFor(rule.id, false);
    if (r.ok === false) {
      setNotice({ kind: "error", text: r.error.message });
    } else if (r.data.run.status === "ok") {
      const warnings = r.data.run.warnings.length > 0 ? ` Warnings: ${r.data.run.warnings.join("; ")}` : "";
      const cost = r.data.run.cost !== undefined ? ` AI cost ${formatCost(r.data.run.cost)}.` : "";
      setNotice({ kind: "idle", text: `Created a post for “${r.data.run.topic}”.${cost}${warnings}` });
    } else if (r.data.run.status === "skipped") {
      setNotice({ kind: "idle", text: `Skipped “${r.data.run.topic}”: ${r.data.run.error ?? "duplicate"}` });
    } else {
      setNotice({ kind: "error", text: `Failed: ${r.data.run.error ?? "unknown error"}` });
    }
    await refresh();
  };

  const remove = async (rule: Rule) => {
    if (!window.confirm(`Delete the rule “${rule.name}”? Its remaining topics are discarded.`)) return;
    setBusyFor(rule.id, true);
    const r = await apiPost<{ ok: true }>("rules/delete", { id: rule.id });
    setBusyFor(rule.id, false);
    if (r.ok === false) setNotice({ kind: "error", text: r.error.message });
    await refresh();
  };

  const ruleName = (run: StoredRun) =>
    run.ruleName ?? rules?.find((x) => x.id === run.ruleId)?.name ?? (run.source === "express"
      ? "Express"
      : run.source === "bulk"
        ? "Bulk edit"
        : run.source === "panel"
          ? "Editor panel"
          : run.source === "links"
            ? "Internal links"
            : run.source === "slop"
              ? "No AI slop"
              : "—");

  return (
    <div style={stackStyle}>
      <header style={stackStyle}>
        <h2 className={cardTitleClasses}>AI Writer — Bulk Rules</h2>
        <p className={helperClasses}>
          Each active rule writes one post per check (every 15 minutes) until its run is done, then waits its interval.
          Rules pause themselves after 3 failures in a row.
        </p>
      </header>

      {editing ? (
        <RuleDialog
          key={editing.id ?? "new"}
          initial={editing}
          settings={settings}
          onCancel={() => setEditing(null)}
          onSaved={(rule, warnings) => {
            setEditing(null);
            setNotice({
              kind: warnings.length > 0 ? "error" : "idle",
              text: warnings.length > 0 ? warnings.join("; ") : `Saved “${rule.name}”.`,
            });
            void refresh();
          }}
        />
      ) : (
        <div style={rowStyle}>
          <button type="button" className={buttonPrimaryClasses} onClick={() => setEditing(emptyRuleForm())}>
            + New rule
          </button>
        </div>
      )}

      {notice.text ? (
        <p role="status" className={notice.kind === "error" ? statusErrorClasses : statusIdleClasses}>
          {notice.text}
        </p>
      ) : null}

      <section className={cardClasses}>
        <div style={stackStyle}>
          <h3 className={cardTitleClasses}>Rules</h3>
          {rules === null ? <p className={statusIdleClasses}>Loading rules…</p> : null}
          {rules !== null && rules.length === 0 ? <p className={helperClasses}>No rules yet.</p> : null}
          {rules !== null && rules.length > 0 ? (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    {["Name", "Source", "Language", "Topics left", "Every", "Posts/run", "Next run", "Status", "Active", "Actions"].map(
                      (h) => (
                        <th key={h} style={thStyle}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td style={tdStyle}>{rule.name}</td>
                      <td style={tdStyle}>{SOURCE_LABELS[topicSourceOf(rule)]}</td>
                      <td style={tdStyle}>{LOCALE_LABELS[localeOf(rule.options.locale)]}</td>
                      <td style={tdStyle}>{rule.topics.length}</td>
                      <td style={tdStyle}>{rule.intervalHours}h</td>
                      <td style={tdStyle}>{rule.postsPerRun}</td>
                      <td style={tdStyle}>{rule.active ? formatWhen(rule.nextRunAt, now) : "—"}</td>
                      <td style={tdStyle}>
                        {ruleStatus(rule)}
                        {rule.lastError ? <p className={statusErrorClasses}>{rule.lastError}</p> : null}
                        {rule.sourceError ? (
                          <p className={statusErrorClasses}>Topic source: {rule.sourceError}</p>
                        ) : null}
                      </td>
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          aria-label={`Active: ${rule.name}`}
                          style={checkboxAccentStyle}
                          checked={rule.active}
                          disabled={busy[rule.id]}
                          onChange={() => void toggleActive(rule)}
                        />
                      </td>
                      <td style={tdStyle}>
                        <div style={rowStyle}>
                          <button
                            type="button"
                            className={buttonSecondaryClasses}
                            disabled={busy[rule.id]}
                            onClick={() => setEditing(formFromRule(rule))}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={buttonSecondaryClasses}
                            disabled={busy[rule.id] || (rule.topics.length === 0 && topicSourceOf(rule) === "list")}
                            onClick={() => void runNow(rule)}
                          >
                            {busy[rule.id] ? "Working…" : "Run now"}
                          </button>
                          <button
                            type="button"
                            className={buttonSecondaryClasses}
                            disabled={busy[rule.id]}
                            onClick={() => void remove(rule)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      <section className={cardClasses}>
        <div style={stackStyle}>
          <div style={rowStyle}>
            <h3 className={cardTitleClasses}>Recent runs</h3>
            <button type="button" className={buttonSecondaryClasses} onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          {runs.length === 0 ? <p className={helperClasses}>No runs yet.</p> : null}
          {runs.length > 0 ? (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    {["When", "Rule", "Topic", "Status", "Cost", "Post", "Details"].map((h) => (
                      <th key={h} style={thStyle}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    // Every run that touched an entry records its edit URL (and so its collection).
                    const link = run.postId ? run.editUrl : undefined;
                    return (
                      <tr key={run.id}>
                        <td style={tdStyle} title={run.startedAt}>
                          {formatWhen(run.startedAt, now)}
                        </td>
                        <td style={tdStyle}>{ruleName(run)}</td>
                        <td style={tdStyle}>{run.topic ?? "—"}</td>
                        <td style={tdStyle}>{run.status}</td>
                        <td style={tdStyle} title={run.tokens ? `${run.tokens} tokens, ${run.calls} calls` : undefined}>
                          {formatCost(run.cost)}
                        </td>
                        <td style={tdStyle}>{link ? <a href={link}>Open</a> : "—"}</td>
                        <td style={tdStyle}>
                          {run.error ? <span className={statusErrorClasses}>{run.error}</span> : null}
                          {run.details ? <span className={helperClasses}>{run.details} </span> : null}
                          {run.warnings.length > 0 ? (
                            <span className={helperClasses}>{run.warnings.join("; ")}</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
