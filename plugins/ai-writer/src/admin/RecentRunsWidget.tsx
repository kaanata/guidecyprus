import { useCallback, useEffect, useState } from "react";
import type { StoredRun } from "../lib/runs";
import { formatCost, type UsageResponse } from "../lib/usage";
import { apiGet, apiPost } from "./api";
import { formatWhen } from "./rules-state";
import { buttonPrimaryClasses, helperClasses, rowStyle, stackStyle, statusErrorClasses, statusIdleClasses } from "./ui";

const PAGES = "/_emdash/admin/plugins/ai-writer";
const SOURCE_LABELS: Record<StoredRun["source"], string> = {
  rule: "Rule",
  express: "Express",
  panel: "Editor panel",
  bulk: "Bulk edit",
  links: "Internal links",
  slop: "No AI slop",
};

function planWindow(w: { remainingPercent: number; resetsAt: string }) {
  const mins = Math.max(0, Math.round((Date.parse(w.resetsAt) - Date.now()) / 60_000));
  const when = mins < 90 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  return `${w.remainingPercent}% left (resets in ${when})`;
}

// Dashboard widget: recent runs, provider usage and a "check now" button.
export function RecentRunsWidget() {
  const [runs, setRuns] = useState<StoredRun[] | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "idle" | "error"; text: string }>({ kind: "idle", text: "" });

  const refresh = useCallback(async () => {
    void apiGet<UsageResponse>("usage").then((u) => {
      if (u.ok === true) setUsage(u.data);
    });
    const r = await apiGet<{ runs: StoredRun[] }>("runs?limit=5");
    if (r.ok === true) {
      setRuns(r.data.runs);
    } else {
      setRuns([]);
      setNotice({ kind: "error", text: r.error.message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runDue = async () => {
    setBusy(true);
    setNotice({ kind: "idle", text: "Running due rules… this can take a few minutes." });
    const r = await apiPost<{ ran: StoredRun[] }>("rules/tick", {});
    setBusy(false);
    if (r.ok === false) {
      setNotice({ kind: "error", text: r.error.message });
    } else if (r.data.ran.length === 0) {
      setNotice({ kind: "idle", text: "No rules or internal-link jobs are due right now." });
    } else {
      const ok = r.data.ran.filter((run) => run.status === "ok").length;
      const cost = r.data.ran.reduce((sum, run) => sum + (run.cost ?? 0), 0);
      setNotice({
        kind: "idle",
        text: `Finished ${ok} of ${r.data.ran.length} job(s) (posts, links, edits). AI cost ${formatCost(cost)}.`,
      });
    }
    await refresh();
  };

  const now = new Date();
  const key = usage?.openrouter;
  return (
    <div style={stackStyle}>
      {usage?.lowPlan && usage.minimax ? (
        <p role="alert" className={statusErrorClasses}>
          MiniMax plan quota is low: 5-hour {planWindow(usage.minimax.interval)}, weekly {planWindow(usage.minimax.weekly)}.
        </p>
      ) : null}
      {usage?.minimax && !usage.lowPlan ? (
        <p className={helperClasses}>
          MiniMax plan: 5-hour {planWindow(usage.minimax.interval)} · weekly {planWindow(usage.minimax.weekly)}
        </p>
      ) : null}
      {usage?.lowCredit.low && key ? (
        <p role="alert" className={statusErrorClasses}>
          Low OpenRouter credit: {formatCost(key.remaining ?? 0)} left (warning below {formatCost(usage.lowCredit.threshold)}).
          Rules and edits stop working when it runs out.
        </p>
      ) : null}
      {usage ? (
        <p className={helperClasses}>
          AI cost: today {formatCost(usage.summary.today.cost)} · 7 days {formatCost(usage.summary.week.cost)} · 30 days{" "}
          {formatCost(usage.summary.month.cost)} · total {formatCost(usage.summary.allTime.cost)}
          {usage.summary.allTime.avgPostCost !== null ? ` · avg per post ${formatCost(usage.summary.allTime.avgPostCost)}` : ""}
          {key
            ? ` · OpenRouter today ${formatCost(key.daily)}${key.limit !== null && key.remaining !== null ? `, ${formatCost(key.remaining)} left of ${formatCost(key.limit)}` : ""}`
            : ""}
        </p>
      ) : null}
      {runs === null ? <p className={statusIdleClasses}>Loading…</p> : null}
      {runs !== null && runs.length === 0 ? <p className={helperClasses}>No AI Writer runs yet.</p> : null}
      {(runs ?? []).map((run) => (
        <div key={run.id} style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span
            className={run.status === "error" ? statusErrorClasses : helperClasses}
            title={run.error ?? run.details ?? run.topic}
          >
            {/* Runs record the entry's edit URL, which carries its collection. */}
            {run.postId && run.editUrl ? (
              <a href={run.editUrl}>{run.topic ?? run.postId}</a>
            ) : (
              (run.topic ?? "—")
            )}
            {` · ${SOURCE_LABELS[run.source] ?? run.source} · ${run.status}${run.cost !== undefined ? ` · ${formatCost(run.cost)}` : ""}`}
          </span>
          <span className={helperClasses}>{formatWhen(run.startedAt, now)}</span>
        </div>
      ))}
      <div style={rowStyle}>
        <button type="button" className={buttonPrimaryClasses} disabled={busy} onClick={() => void runDue()}>
          {busy ? "Running…" : "Run due jobs now"}
        </button>
        <a className={helperClasses} href={`${PAGES}/rules`}>
          Bulk Rules
        </a>
        <a className={helperClasses} href={`${PAGES}/express`}>
          Express Mode
        </a>
      </div>
      {notice.text ? (
        <p role="status" className={notice.kind === "error" ? statusErrorClasses : statusIdleClasses}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
