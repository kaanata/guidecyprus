/** An ad is live from `startsAt` (inclusive) until `endsAt` (exclusive). */
export function isLive(ad: { startsAt?: string; endsAt?: string }, now: Date): boolean {
  const t = now.getTime();
  if (ad.startsAt && Date.parse(ad.startsAt) > t) return false;
  if (ad.endsAt && Date.parse(ad.endsAt) <= t) return false;
  return true;
}
