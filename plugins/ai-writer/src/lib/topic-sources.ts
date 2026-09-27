import { topicSourceOf, type Rule } from "./rules";
import { fetchFeedItems } from "./rss";

export type FoundTopics = { found: Array<{ key: string; topic: string }>; error?: string };

// New topics for an automatic-source rule: one run's worth (postsPerRun), so
// queued topics never go stale while waiting for a later run.
export async function findTopics(rule: Rule, opts: { now: Date; fetchImpl?: typeof fetch }): Promise<FoundTopics> {
  const seen = new Set(rule.sourceSeen ?? []);
  switch (topicSourceOf(rule)) {
    case "rss": {
      const { items, errors } = await fetchFeedItems(rule.feeds ?? [], { seen, fetchImpl: opts.fetchImpl });
      return {
        found: items.slice(0, rule.postsPerRun).map((item) => ({ key: item.url, topic: item.title })),
        ...(errors.length > 0 ? { error: errors.map((e) => `${e.feed}: ${e.message}`).join("; ") } : {}),
      };
    }
    default:
      return { found: [] };
  }
}
