// A rule topic may start with a past date to backdate the post:
//   "2026-08-03 | Best beaches near Paphos"
//   "2026-08-03 18:30 | Best beaches near Paphos"   (UTC)
// Without a time, the post gets a stable daytime hour derived from the topic,
// so a batch does not all share one timestamp. Future or invalid dates are
// ignored (the post is published now) but still stripped from the topic.

const LINE = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?\s*\|\s*(.+)$/;

function hourFor(text: string): { h: number; m: number } {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return { h: 7 + (hash % 14), m: (hash >>> 8) % 60 };
}

export function parseTopicLine(line: string, now: Date): { topic: string; publishedAt?: string } {
  const match = LINE.exec(line);
  if (!match) return { topic: line.trim() };
  const [, y, mo, d, hh, mm, rest] = match;
  const topic = rest.trim();
  const { h, m } = hh === undefined ? hourFor(topic) : { h: Number(hh), m: Number(mm) };
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), h, m));
  const valid =
    h < 24 &&
    m < 60 &&
    at.getUTCFullYear() === Number(y) &&
    at.getUTCMonth() === Number(mo) - 1 &&
    at.getUTCDate() === Number(d) &&
    at.getTime() < now.getTime();
  return valid ? { topic, publishedAt: at.toISOString() } : { topic };
}
