import { useEffect, useState } from "react";
import type { RunRecord } from "../lib/runs";
import { formatCost, type PeriodSummary, type UsageResponse } from "../lib/usage";
import { apiGet } from "./api";
import {
  cardClasses,
  cardTitleClasses,
  helperClasses,
  stackStyle,
  statusErrorClasses,
  statusIdleClasses,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./ui";

const SOURCE_LABELS: Record<RunRecord["source"], string> = {
  rule: "Bulk Rules posts",
  express: "Express Mode",
  panel: "Editor panel",
  bulk: "Bulk edit",
  links: "Internal links",
  slop: "No AI slop edits",
};

function planWindow(w: { remainingPercent: number; resetsAt: string }) {
  const mins = Math.max(0, Math.round((Date.parse(w.resetsAt) - Date.now()) / 60_000));
  const when = mins < 90 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  return `${w.remainingPercent}% left (resets in ${when})`;
}

function periodCell(p: PeriodSummary, source: RunRecord["source"]) {
  const s = p.bySource[source];
  return s ? `${formatCost(s.cost)} (${s.runs})` : "—";
}

// AI cost from run history plus the OpenRouter key's own totals.
export function UsageCard() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void apiGet<UsageResponse>("usage").then((r) => {
      if (r.ok === true) setUsage(r.data);
      else setError(r.error.message);
    });
  }, []);

  const sources = usage
    ? (Object.keys(SOURCE_LABELS) as Array<RunRecord["source"]>).filter((s) => usage.summary.month.bySource[s])
    : [];
  const key = usage?.openrouter;

  return (
    <section className={cardClasses}>
      <div style={stackStyle}>
        <h3 className={cardTitleClasses}>Usage &amp; cost</h3>
        <p className={helperClasses}>
          Costs are the exact amounts OpenRouter reports for each call, summed per run. MiniMax calls are covered by
          your MiniMax plan and count as $0 here; their quota is shown below. Express
          Mode's individual step and image buttons are not runs, so they only appear in the OpenRouter totals. Runs from
          before cost logging count as $0; the per-post average only uses posts that recorded a cost.
        </p>
        {error ? <p className={statusErrorClasses}>{error}</p> : null}
        {usage?.lowPlan && usage.minimax ? (
          <p role="alert" className={statusErrorClasses}>
            MiniMax plan quota is low: 5-hour window {planWindow(usage.minimax.interval)}, weekly{" "}
            {planWindow(usage.minimax.weekly)}. Generation pauses with errors when a window runs out.
          </p>
        ) : null}
        {usage?.lowCredit.low && usage.openrouter ? (
          <p role="alert" className={statusErrorClasses}>
            Low OpenRouter credit: {formatCost(usage.openrouter.remaining ?? 0)} left, below your{" "}
            {formatCost(usage.lowCredit.threshold)} warning. Rules, links and edits stop working when it runs out.
          </p>
        ) : null}
        {!usage && !error ? <p className={statusIdleClasses}>Loading usage…</p> : null}
        {usage ? (
          <>
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    {["Runs", "Today (UTC)", "Last 7 days", "Last 30 days", "All time"].map((h) => (
                      <th key={h} style={thStyle}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={tdStyle}>All AI Writer runs</td>
                    {[usage.summary.today, usage.summary.week, usage.summary.month, usage.summary.allTime].map((p, i) => (
                      <td key={i} style={tdStyle} title={`${p.runs} runs, ${p.calls} calls, ${p.tokens} tokens`}>
                        {formatCost(p.cost)} ({p.runs})
                      </td>
                    ))}
                  </tr>
                  {sources.map((s) => (
                    <tr key={s}>
                      <td style={tdStyle}>{SOURCE_LABELS[s]}</td>
                      <td style={tdStyle}>{periodCell(usage.summary.today, s)}</td>
                      <td style={tdStyle}>{periodCell(usage.summary.week, s)}</td>
                      <td style={tdStyle}>{periodCell(usage.summary.month, s)}</td>
                      <td style={tdStyle}>{periodCell(usage.summary.allTime, s)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={tdStyle}>Average writing cost per new post</td>
                    {[usage.summary.today, usage.summary.week, usage.summary.month, usage.summary.allTime].map((p, i) => (
                      <td
                        key={i}
                        style={tdStyle}
                        title={`${p.costedPosts} of ${p.posts} new posts recorded a cost`}
                      >
                        {p.avgPostCost === null ? "—" : `${formatCost(p.avgPostCost)} (${p.costedPosts})`}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {usage.minimax ? (
              <p className={helperClasses}>
                MiniMax plan (text, image and speech share one quota): 5-hour window {planWindow(usage.minimax.interval)} ·
                weekly {planWindow(usage.minimax.weekly)}
              </p>
            ) : usage.minimaxError ? (
              <p className={helperClasses}>MiniMax plan quota is unavailable: {usage.minimaxError}.</p>
            ) : null}
            {key ? (
              <p className={helperClasses}>
                OpenRouter key: today {formatCost(key.daily)} · this week {formatCost(key.weekly)} · this month{" "}
                {formatCost(key.monthly)} · all time {formatCost(key.usage)}
                {key.limit !== null
                  ? ` · limit ${formatCost(key.limit)}, ${formatCost(key.remaining ?? 0)} left`
                  : " · no limit set"}
              </p>
            ) : (
              <p className={helperClasses}>
                OpenRouter key usage is unavailable{usage.openrouterError ? `: ${usage.openrouterError}` : ""}.
              </p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
