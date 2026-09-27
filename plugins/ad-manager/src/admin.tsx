import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import { API_BASE } from "./constants";
import { COUNTRY_CODES } from "./countries";
import { type Choice, choiceFromList, choiceToList, emptyChoiceErrors, toggleChoice } from "./lib/targeting-draft";
import type { AdListItem, MediaRef, StatsSummary, StoredAd } from "./lib/types";
import { AD_SPACES, AD_SPACE_IDS, PAGE_TYPES, isAcceptedSize, type AdSpaceId, type PageType } from "./spaces";

// Kumo classes, matching plugins/ai-writer/src/admin/ui.ts
const cardClasses = "bg-kumo-base border rounded-lg shadow-sm p-6";
const fieldClasses = "flex flex-col gap-1.5";
const labelClasses = "text-sm font-medium";
const helperClasses = "text-sm leading-snug text-kumo-subtle";
const errorClasses = "text-sm leading-snug text-kumo-danger";
const inputClasses =
  "flex h-9 gap-1.5 rounded-lg px-3 text-base border border-kumo-line bg-kumo-overlay text-kumo-default focus-within:border-kumo-focus focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50";
const textareaClasses =
  "min-h-40 rounded-lg p-3 font-mono text-sm border border-kumo-line bg-kumo-overlay text-kumo-default focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50";
const buttonPrimaryClasses =
  "group flex items-center h-9 gap-1.5 rounded-lg px-3 text-base font-medium select-none bg-kumo-brand !text-white ring ring-kumo-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-not-allowed disabled:opacity-50";
const buttonSecondaryClasses =
  "group flex items-center h-9 gap-1.5 rounded-lg px-3 text-base font-medium select-none bg-kumo-base !text-kumo-default ring ring-kumo-line not-disabled:hover:bg-kumo-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-not-allowed disabled:opacity-50";

const PAGE_TYPE_LABELS: Record<PageType, string> = {
  home: "Home",
  latest: "Latest news",
  competition: "Competition pages",
  article: "Articles",
  tag: "Tag pages",
  search: "Search",
  page: "Static pages",
};

// Country names in English, from the browser's own data; falls back to the code.
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ value: code as string, label: regionNames?.of(code) ?? code })).sort((a, b) =>
  a.label.localeCompare(b.label),
);

type Failure = { ok: false; error: string; fieldErrors?: Record<string, string> };

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

async function call<T>(route: string, body?: unknown): Promise<T | Failure> {
  try {
    const init =
      body === undefined
        ? undefined
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const response = await apiFetch(`${API_BASE}/${route}`, init);
    return await parseApiResponse<T | Failure>(response, "The request failed");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The request failed" };
  }
}

interface MediaItem {
  id: string;
  filename: string;
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
}

async function listImages(): Promise<MediaItem[]> {
  const response = await apiFetch("/_emdash/api/media?mimeType=image/jpeg,image/png,image/webp,image/gif&limit=100");
  const data = await parseApiResponse<{ items?: MediaItem[] }>(response, "Couldn't load the media library");
  return data.items ?? [];
}

async function listCompetitions(): Promise<Array<{ slug: string; label: string }> | null> {
  try {
    const response = await apiFetch("/_emdash/api/taxonomies/category/terms");
    const data = await parseApiResponse<unknown>(response, "Couldn't load competitions");
    const record = data as { items?: unknown[]; terms?: unknown[] };
    const list = (Array.isArray(data) ? data : (record.items ?? record.terms ?? [])) as Array<{
      slug?: string;
      label?: string;
      name?: string;
    }>;
    return list.filter((term) => term.slug).map((term) => ({ slug: term.slug!, label: term.label ?? term.name ?? term.slug! }));
  } catch {
    return null;
  }
}

// Schedules are entered in the admin's own time zone and stored as UTC.
function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const formatDateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatSchedule(ad: StoredAd): string {
  if (!ad.startsAt && !ad.endsAt) return "Always";
  return `${ad.startsAt ? formatDateTime(ad.startsAt) : "Now"} – ${ad.endsAt ? formatDateTime(ad.endsAt) : "No end"}`;
}

const ctrText = (clicks: number, impressions: number) =>
  impressions > 0 ? `${((clicks / impressions) * 100).toFixed(2)}%` : "—";

const sizeList = (sizes: Array<{ width: number; height: number }>) => sizes.map((s) => `${s.width}×${s.height}`).join(" or ");

interface Draft {
  id?: string;
  name: string;
  advertiser: string;
  kind: "banner" | "code";
  space: AdSpaceId;
  status: "active" | "paused";
  weight: number;
  startsAt: string;
  endsAt: string;
  pageTypes: Choice<PageType>;
  competitions: Choice;
  countries: Choice;
  disclosure: string;
  image: MediaRef | null;
  mobileImage: MediaRef | null;
  href: string;
  alt: string;
  html: string;
}

function toDraft(ad?: StoredAd): Draft {
  return {
    id: ad?.id,
    name: ad?.name ?? "",
    advertiser: ad?.advertiser ?? "",
    kind: ad?.kind ?? "banner",
    space: ad?.space ?? "in-feed",
    status: ad?.status ?? "active",
    weight: ad?.weight ?? 10,
    startsAt: toLocalInput(ad?.startsAt),
    endsAt: toLocalInput(ad?.endsAt),
    pageTypes: choiceFromList(ad?.targeting.pageTypes),
    competitions: choiceFromList(ad?.targeting.competitions),
    countries: choiceFromList(ad?.targeting.countries),
    disclosure: ad?.disclosure ?? "",
    image: ad?.banner?.image ?? null,
    mobileImage: ad?.banner?.mobileImage ?? null,
    href: ad?.banner?.href ?? "",
    alt: ad?.banner?.alt ?? "",
    html: ad?.code?.html ?? "",
  };
}

function toPayload(draft: Draft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: draft.name,
    kind: draft.kind,
    space: draft.space,
    status: draft.status,
    weight: draft.weight,
    targeting: {
      pageTypes: choiceToList(draft.pageTypes),
      competitions: choiceToList(draft.competitions),
      countries: choiceToList(draft.countries),
    },
  };
  if (draft.id) payload.id = draft.id;
  if (draft.advertiser.trim()) payload.advertiser = draft.advertiser;
  if (draft.disclosure.trim()) payload.disclosure = draft.disclosure;
  const startsAt = fromLocalInput(draft.startsAt);
  const endsAt = fromLocalInput(draft.endsAt);
  if (startsAt) payload.startsAt = startsAt;
  if (endsAt) payload.endsAt = endsAt;
  if (draft.kind === "banner") {
    payload.banner = {
      image: draft.image ?? undefined,
      href: draft.href,
      alt: draft.alt,
      ...(draft.space === "top-banner" && draft.mobileImage ? { mobileImage: draft.mobileImage } : {}),
    };
  } else {
    payload.code = { html: draft.html };
  }
  return payload;
}

function FieldError({ message }: { message?: string }): JSX.Element | null {
  return message ? <span className={errorClasses}>{message}</span> : null;
}

function ImagePicker(props: {
  id: string;
  label: string;
  hint: string;
  value: MediaRef | null;
  error?: string;
  onChange: (value: MediaRef | null) => void;
}): JSX.Element {
  const { id, label, hint, value, error, onChange } = props;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function openPicker() {
    setOpen(true);
    if (items) return;
    try {
      setItems(await listImages());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load the media library");
    }
  }

  const query = search.trim().toLowerCase();
  const visibleItems = query
    ? (items ?? []).filter(
        (item) => item.filename.toLowerCase().includes(query) || (item.alt ?? "").toLowerCase().includes(query),
      )
    : items;

  return (
    <div className={fieldClasses}>
      <span className={labelClasses}>{label}</span>
      {value ? (
        <div className="flex items-center gap-3">
          <img src={value.url} alt="" className="h-12 w-auto rounded border" />
          <span className={helperClasses}>
            {value.width}×{value.height}
          </span>
          <button type="button" className={buttonSecondaryClasses} onClick={() => onChange(null)}>
            Remove
          </button>
        </div>
      ) : null}
      <div>
        <button type="button" className={buttonSecondaryClasses} aria-describedby={`${id}-hint`} onClick={() => void openPicker()}>
          {value ? "Change image" : "Choose image"}
        </button>
      </div>
      <span id={`${id}-hint`} className={helperClasses}>
        {hint}
      </span>
      <FieldError message={error} />
      {open ? (
        <div className="space-y-2 rounded-lg border p-2">
          {items && items.length > 0 ? (
            <div className={fieldClasses}>
              <label htmlFor={`${id}-search`} className={labelClasses}>Search images</label>
              <input
                id={`${id}-search`}
                type="search"
                className={inputClasses}
                placeholder="Filter by filename or description"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className={helperClasses}>Lists the newest 100 images. Search only filters what's already loaded.</span>
            </div>
          ) : null}
          <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto">
          {loadError ? (
            <p className={errorClasses}>{loadError}</p>
          ) : items === null ? (
            <p className={helperClasses}>Loading images…</p>
          ) : items.length === 0 ? (
            <p className={helperClasses}>No images yet. Upload one in the media library first.</p>
          ) : (visibleItems ?? []).length === 0 ? (
            <p className={helperClasses}>No images match your search.</p>
          ) : (
            (visibleItems ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={!item.width || !item.height}
                className="rounded border p-1 text-left not-disabled:hover:bg-kumo-tint disabled:opacity-50"
                onClick={() => {
                  if (!item.width || !item.height) return;
                  onChange({ mediaId: item.id, url: item.url, width: item.width, height: item.height });
                  setOpen(false);
                }}
              >
                <img src={item.url} alt="" className="h-16 w-full object-cover" />
                <span className="block text-xs">{item.width && item.height ? `${item.width}×${item.height}` : "Size unknown"}</span>
              </button>
            ))
          )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Case- and accent-insensitive, so "turk" finds "Türkiye".
const foldText = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** "All" checkbox plus the individual options; unticking All reveals the list. */
function TargetPicker(props: {
  id: string;
  legend: string;
  allLabel: string;
  helper: string;
  options: Array<{ value: string; label: string }>;
  choice: Choice;
  error?: string;
  searchable?: boolean;
  onChange: (choice: Choice) => void;
  /** Rendered instead of the option list, e.g. while options load. */
  fallback?: JSX.Element;
}): JSX.Element {
  const { id, legend, allLabel, helper, options, choice, error, searchable, onChange, fallback } = props;
  const [search, setSearch] = useState("");
  const query = foldText(search.trim());
  const visible = query
    ? options.filter((o) => foldText(o.label).includes(query) || o.value.toLowerCase() === query)
    : options;
  const labelOf = (value: string) => options.find((o) => o.value === value)?.label ?? value;

  return (
    <fieldset className="space-y-2" aria-describedby={`${id}-helper`}>
      <legend className={labelClasses}>{legend}</legend>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={choice.all} onChange={(e) => onChange({ ...choice, all: e.target.checked })} />
        {allLabel}
      </label>
      {choice.all ? null : fallback ?? (
        <div className="space-y-2 rounded-lg border p-3">
          {searchable ? (
            <>
              {choice.picked.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {choice.picked.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="rounded-full border px-2 py-0.5 text-sm not-disabled:hover:bg-kumo-tint"
                      aria-label={`Remove ${labelOf(value)}`}
                      onClick={() => onChange(toggleChoice(choice, value))}
                    >
                      {labelOf(value)} ×
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                id={`${id}-search`}
                type="search"
                aria-label={`Search ${legend.toLowerCase()}`}
                className={inputClasses}
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </>
          ) : null}
          <div
            className="flex flex-wrap gap-x-4 gap-y-2"
            // Inline: the admin's prebuilt CSS doesn't ship these utility classes.
            style={searchable ? { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(12rem, 1fr))", maxHeight: "16rem", overflowY: "auto" } : undefined}
          >
            {visible.length === 0 ? (
              <p className={helperClasses}>Nothing matches your search.</p>
            ) : (
              visible.map((option) => (
                <label key={option.value} className="flex items-center gap-2">
                  <input type="checkbox" checked={choice.picked.includes(option.value)} onChange={() => onChange(toggleChoice(choice, option.value))} />
                  {option.label}
                </label>
              ))
            )}
          </div>
        </div>
      )}
      <p id={`${id}-helper`} className={helperClasses}>{helper}</p>
      <FieldError message={error} />
    </fieldset>
  );
}

function AdEditor(props: { initial: Draft; onClose: () => void; onSaved: () => void }): JSX.Element {
  const { initial, onClose, onSaved } = props;
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [competitions, setCompetitions] = useState<Array<{ slug: string; label: string }> | null | undefined>(undefined);

  useEffect(() => {
    void listCompetitions().then(setCompetitions);
  }, []);

  const space = AD_SPACES[draft.space];
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  // `initial` is the draft the editor was opened with and stays stable for the
  // dialog's lifetime, so this comparison is cheap and only trips a confirm when
  // something actually changed. A pristine editor still closes instantly.
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const requestClose = () => {
    if (isDirty && !window.confirm("Discard your changes?")) return;
    onClose();
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const clientErrors = emptyChoiceErrors(draft);
    if (draft.kind === "banner" && !draft.image) clientErrors["banner.image"] = "Choose an image";
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }
    setSaving(true);
    const result = await call<{ ok: true; ad: StoredAd }>("ads/save", toPayload(draft));
    setSaving(false);
    if (isFailure(result)) {
      setErrors(result.fieldErrors ?? { _: result.error });
      return;
    }
    onSaved();
  }

  const imageError =
    draft.image && !isAcceptedSize(draft.space, draft.image, "main")
      ? `This space doesn't accept ${draft.image.width}×${draft.image.height} images`
      : errors["banner.image"] ?? errors.banner;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ad-editor-title"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") requestClose();
      }}
    >
      <form onSubmit={onSubmit} className={`${cardClasses} w-full max-w-2xl space-y-5`}>
        <h2 id="ad-editor-title" className="text-lg font-semibold">
          {draft.id ? "Edit ad" : "New ad"}
        </h2>
        <FieldError message={errors._} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={fieldClasses}>
            <label htmlFor="ad-name" className={labelClasses}>Name</label>
            <input id="ad-name" autoFocus className={inputClasses} value={draft.name} onChange={(e) => set("name", e.target.value)} />
            <FieldError message={errors.name} />
          </div>
          <div className={fieldClasses}>
            <label htmlFor="ad-advertiser" className={labelClasses}>Advertiser (optional)</label>
            <input id="ad-advertiser" className={inputClasses} value={draft.advertiser} onChange={(e) => set("advertiser", e.target.value)} />
            <FieldError message={errors.advertiser} />
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className={labelClasses}>Type</legend>
          <div className="flex gap-4">
            {(["banner", "code"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-2">
                <input type="radio" name="ad-kind" checked={draft.kind === kind} onChange={() => set("kind", kind)} />
                {kind === "banner" ? "Banner image" : "Ad network code"}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className={fieldClasses}>
            <label htmlFor="ad-space" className={labelClasses}>Space</label>
            <select id="ad-space" className={inputClasses} value={draft.space} onChange={(e) => set("space", e.target.value as AdSpaceId)}>
              {AD_SPACE_IDS.map((id) => (
                <option key={id} value={id}>{AD_SPACES[id].label}</option>
              ))}
            </select>
          </div>
          <div className={fieldClasses}>
            <label htmlFor="ad-status" className={labelClasses}>Status</label>
            <select id="ad-status" className={inputClasses} value={draft.status} onChange={(e) => set("status", e.target.value as Draft["status"])}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </div>
          <div className={fieldClasses}>
            <label htmlFor="ad-weight" className={labelClasses}>Weight</label>
            <input id="ad-weight" type="number" min={1} max={100} step={1} className={inputClasses} value={draft.weight} onChange={(e) => set("weight", Number(e.target.value))} />
            <FieldError message={errors.weight} />
          </div>
        </div>
        <p className={helperClasses}>{space.description}. Higher weight means the ad is shown more often than others in the same space.</p>

        {draft.kind === "banner" ? (
          <div className="space-y-4">
            <ImagePicker id="ad-image" label="Image" hint={`This space takes ${sizeList(space.accepts)} images.`} value={draft.image} error={imageError} onChange={(v) => set("image", v)} />
            {draft.space === "top-banner" ? (
              <ImagePicker id="ad-mobile-image" label="Phone image (optional)" hint={`Shown on phones: ${sizeList(space.acceptsMobile)}.`} value={draft.mobileImage} error={errors["banner.mobileImage"]} onChange={(v) => set("mobileImage", v)} />
            ) : null}
            <div className={fieldClasses}>
              <label htmlFor="ad-href" className={labelClasses}>Link</label>
              <input id="ad-href" type="url" placeholder="https://" className={inputClasses} value={draft.href} onChange={(e) => set("href", e.target.value)} />
              <FieldError message={errors["banner.href"]} />
            </div>
            <div className={fieldClasses}>
              <label htmlFor="ad-alt" className={labelClasses}>Image description</label>
              <input id="ad-alt" className={inputClasses} value={draft.alt} onChange={(e) => set("alt", e.target.value)} />
              <span className={helperClasses}>Read aloud by screen readers, e.g. "Welcome bonus on your first bet".</span>
              <FieldError message={errors["banner.alt"]} />
            </div>
          </div>
        ) : (
          <div className={fieldClasses}>
            <label htmlFor="ad-code" className={labelClasses}>Ad code</label>
            <textarea id="ad-code" className={textareaClasses} value={draft.html} onChange={(e) => set("html", e.target.value)} />
            <span className={helperClasses}>This code runs on your site exactly as pasted. Only use code from ad networks you trust.</span>
            <FieldError message={errors["code.html"] ?? errors.code} />
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className={labelClasses}>Schedule</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={fieldClasses}>
              <label htmlFor="ad-start" className={labelClasses}>Start</label>
              <input id="ad-start" type="datetime-local" className={inputClasses} value={draft.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
              <FieldError message={errors.startsAt} />
            </div>
            <div className={fieldClasses}>
              <label htmlFor="ad-end" className={labelClasses}>End</label>
              <input id="ad-end" type="datetime-local" className={inputClasses} value={draft.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
              <FieldError message={errors.endsAt} />
            </div>
          </div>
          <p className={helperClasses}>Times are in your time zone. Leave both empty to run with no limit.</p>
        </fieldset>

        <TargetPicker
          id="ad-pages"
          legend="Pages"
          allLabel="All pages"
          helper="Untick All pages to choose where this ad shows."
          options={PAGE_TYPES.map((type) => ({ value: type, label: PAGE_TYPE_LABELS[type] }))}
          choice={draft.pageTypes}
          error={errors["targeting.pageTypes"]}
          onChange={(choice) => set("pageTypes", choice as Choice<PageType>)}
        />

        <TargetPicker
          id="ad-competitions"
          legend="Competitions"
          allLabel="All competitions"
          helper="Ads limited to competitions only show on those competitions' pages and articles, never on home, latest, tag or search pages."
          options={(competitions ?? []).map((c) => ({ value: c.slug, label: c.label }))}
          choice={draft.competitions}
          error={errors["targeting.competitions"]}
          onChange={(choice) => set("competitions", choice)}
          fallback={
            competitions === undefined ? (
              <p className={helperClasses}>Loading competitions…</p>
            ) : competitions === null || competitions.length === 0 ? (
              <input
                aria-label="Competition slugs, separated by commas"
                className={inputClasses}
                value={draft.competitions.picked.join(", ")}
                onChange={(e) =>
                  set("competitions", { all: false, picked: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })
                }
              />
            ) : undefined
          }
        />

        <TargetPicker
          id="ad-countries"
          legend="Countries"
          allLabel="All countries"
          helper="Based on the visitor's location from Cloudflare. Visitors whose country can't be detected only see ads set to All countries."
          options={COUNTRY_OPTIONS}
          choice={draft.countries}
          error={errors["targeting.countries"] ?? Object.entries(errors).find(([key]) => key.startsWith("targeting.countries."))?.[1]}
          searchable
          onChange={(choice) => set("countries", choice)}
        />

        <div className={fieldClasses}>
          <label htmlFor="ad-disclosure" className={labelClasses}>Disclosure (optional)</label>
          <input id="ad-disclosure" className={inputClasses} value={draft.disclosure} onChange={(e) => set("disclosure", e.target.value)} />
          <span className={helperClasses}>Shown under the ad, e.g. "18+ · Play responsibly".</span>
          <FieldError message={errors.disclosure} />
        </div>

        <div className="space-y-2">
          <span className={labelClasses}>Preview</span>
          <div
            className="flex max-w-full items-center justify-center overflow-hidden rounded border bg-kumo-tint"
            style={{ width: space.reserve.desktop.width, height: space.reserve.desktop.height }}
          >
            {draft.kind === "banner" && draft.image ? (
              <img src={draft.image.url} alt={draft.alt} width={draft.image.width} height={draft.image.height} />
            ) : (
              <span className={helperClasses}>{draft.kind === "code" ? "Code ads only run on the live site." : "Choose an image to preview."}</span>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className={buttonSecondaryClasses} onClick={requestClose}>Cancel</button>
          <button type="submit" className={buttonPrimaryClasses} disabled={saving}>{saving ? "Saving…" : "Save ad"}</button>
        </div>
      </form>
    </div>
  );
}

function AdsPage(): JSX.Element {
  const [ads, setAds] = useState<AdListItem[] | null>(null);
  const [codeAdsEnabled, setCodeAdsEnabled] = useState(true);
  const [spaceFilter, setSpaceFilter] = useState<AdSpaceId | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">("all");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await call<{ ok: true; ads: AdListItem[]; codeAdsEnabled: boolean }>("ads/list");
    if (isFailure(result)) {
      setMessage(result.error);
      return;
    }
    setMessage(null);
    setAds(result.ads);
    setCodeAdsEnabled(result.codeAdsEnabled);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(ad: AdListItem, status: Draft["status"]) {
    const result = await call("ads/save", toPayload({ ...toDraft(ad), status }));
    if (isFailure(result)) setMessage(result.error);
    else {
      setMessage(null);
      await load();
    }
  }

  async function remove(ad: AdListItem) {
    if (!window.confirm(`Delete "${ad.name}"? Its past stats stay on the performance page.`)) return;
    const result = await call("ads/delete", { id: ad.id });
    if (isFailure(result)) setMessage(result.error);
    else {
      setMessage(null);
      await load();
    }
  }

  async function toggleCodeAds(next: boolean) {
    const result = await call<{ ok: true; codeAdsEnabled: boolean }>("settings", { codeAdsEnabled: next });
    if (isFailure(result)) setMessage(result.error);
    else {
      setMessage(null);
      setCodeAdsEnabled(result.codeAdsEnabled);
    }
  }

  const visible = (ads ?? []).filter(
    (ad) => (spaceFilter === "all" || ad.space === spaceFilter) && (statusFilter === "all" || ad.status === statusFilter),
  );

  return (
    <div className="emdash-plugin-page space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Ads</h1>
        <button type="button" className={buttonPrimaryClasses} onClick={() => setEditing(toDraft())}>New ad</button>
      </header>
      {message ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className={errorClasses}>{message}</p>
          <button type="button" className={buttonSecondaryClasses} onClick={() => void load()}>Try again</button>
        </div>
      ) : null}

      <section className={cardClasses}>
        <label className="flex items-start gap-3">
          <input type="checkbox" checked={codeAdsEnabled} onChange={(e) => void toggleCodeAds(e.target.checked)} />
          <span>
            <span className="block font-medium">Show code ads</span>
            <span className={helperClasses}>Turn this off to stop every ad-network code snippet at once. Banner ads keep showing.</span>
          </span>
        </label>
      </section>

      <section className={`${cardClasses} space-y-4`}>
        <div className="flex flex-wrap gap-4">
          <div className={fieldClasses}>
            <label htmlFor="filter-space" className={labelClasses}>Space</label>
            <select id="filter-space" className={inputClasses} value={spaceFilter} onChange={(e) => setSpaceFilter(e.target.value as AdSpaceId | "all")}>
              <option value="all">All spaces</option>
              {AD_SPACE_IDS.map((id) => <option key={id} value={id}>{AD_SPACES[id].label}</option>)}
            </select>
          </div>
          <div className={fieldClasses}>
            <label htmlFor="filter-status" className={labelClasses}>Status</label>
            <select id="filter-status" className={inputClasses} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </div>
        </div>

        {ads === null ? (
          message ? null : <p className={helperClasses}>Loading ads…</p>
        ) : visible.length === 0 ? (
          <p className={helperClasses}>{ads.length === 0 ? "No ads yet. Create one to fill your ad spaces." : "No ads match these filters."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {["Name", "Space", "Type", "Status", "Schedule", "Weight", "Views (7 days)", "Clicks", "CTR", ""].map((h) => (
                    <th key={h} className="text-left font-medium pb-2 pr-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((ad) => (
                  <tr key={ad.id} className="border-t">
                    <td className="py-2 pr-3">
                      <span className="block font-medium">{ad.name}</span>
                      {ad.advertiser ? <span className={helperClasses}>{ad.advertiser}</span> : null}
                    </td>
                    <td className="py-2 pr-3">{AD_SPACES[ad.space].label}</td>
                    <td className="py-2 pr-3">{ad.kind === "banner" ? "Banner" : "Code"}</td>
                    <td className="py-2 pr-3">{ad.status === "active" ? "Active" : "Paused"}</td>
                    <td className="py-2 pr-3">{formatSchedule(ad)}</td>
                    <td className="py-2 pr-3">{ad.weight}</td>
                    <td className="py-2 pr-3">{ad.last7.impressions}</td>
                    <td className="py-2 pr-3">{ad.last7.clicks}</td>
                    <td className="py-2 pr-3">{ctrText(ad.last7.clicks, ad.last7.impressions)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className={buttonSecondaryClasses} onClick={() => setEditing(toDraft(ad))}>Edit</button>
                        <button type="button" className={buttonSecondaryClasses} onClick={() => void setStatus(ad, ad.status === "active" ? "paused" : "active")}>
                          {ad.status === "active" ? "Pause" : "Resume"}
                        </button>
                        <button
                          type="button"
                          className={buttonSecondaryClasses}
                          onClick={() => setEditing({ ...toDraft(ad), id: undefined, name: `${ad.name} (copy)`.slice(0, 80), status: "paused" })}
                        >
                          Duplicate
                        </button>
                        <button type="button" className={buttonSecondaryClasses} onClick={() => void remove(ad)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing ? (
        <AdEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function updatedText(lastRollupAt: string | null): string {
  if (!lastRollupAt) return "Stats haven't been updated yet. They refresh every 5 minutes.";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(lastRollupAt)) / 60000));
  if (minutes < 1) return "Stats updated just now";
  if (minutes < 60) return `Stats updated ${minutes} min ago`;
  return `Stats updated ${formatDateTime(lastRollupAt)}`;
}

function useSummary(days: 7 | 30): { summary: StatsSummary | null; error: string | null } {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void call<{ ok: true } & StatsSummary>("stats/summary", { days }).then((result) => {
      if (cancelled) return;
      if (isFailure(result)) setError(result.error);
      else {
        setError(null);
        setSummary(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [days]);
  return { summary, error };
}

function PerformancePage(): JSX.Element {
  const [days, setDays] = useState<7 | 30>(7);
  const [selected, setSelected] = useState<string | null>(null);
  const { summary, error } = useSummary(days);
  const selectedRow = summary?.rows.find((row) => row.adId === selected) ?? null;

  return (
    <div className="emdash-plugin-page space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Ad performance</h1>
        <div className="flex gap-2" role="group" aria-label="Period">
          {([7, 30] as const).map((d) => (
            <button key={d} type="button" aria-pressed={days === d} className={days === d ? buttonPrimaryClasses : buttonSecondaryClasses} onClick={() => setDays(d)}>
              Last {d} days
            </button>
          ))}
        </div>
      </header>
      {error ? <p role="status" className={errorClasses}>{error}</p> : null}
      <p className={helperClasses}>{summary ? updatedText(summary.lastRollupAt) : "Loading stats…"}</p>

      <section className={cardClasses}>
        {summary && summary.rows.length === 0 ? (
          <p className={helperClasses}>No views recorded in this period yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {["Ad", "Space", "Views", "Clicks", "CTR"].map((h) => <th key={h} className="text-left font-medium pb-2 pr-3">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {summary?.rows.map((row) => (
                  <tr key={row.adId} className="border-t">
                    <td className="py-2 pr-3">
                      <button type="button" className="font-medium underline-offset-2 hover:underline" aria-pressed={selected === row.adId} onClick={() => setSelected(row.adId)}>
                        {row.name}
                      </button>
                    </td>
                    <td className="py-2 pr-3">{row.space ? AD_SPACES[row.space].label : "—"}</td>
                    <td className="py-2 pr-3">{row.impressions}</td>
                    <td className="py-2 pr-3">{row.clicks}</td>
                    <td className="py-2 pr-3">{ctrText(row.clicks, row.impressions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedRow && summary ? (
        <section className={`${cardClasses} space-y-3`}>
          <h2 className="text-lg font-semibold">{selectedRow.name}: day by day</h2>
          <table className="w-full text-sm">
            <thead>
              <tr>{["Day", "Views", "Clicks", "CTR"].map((h) => <th key={h} className="text-left font-medium pb-2 pr-3">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(summary.daily[selectedRow.adId] ?? []).map((d) => (
                <tr key={d.day} className="border-t">
                  <td className="py-2 pr-3">{d.day}</td>
                  <td className="py-2 pr-3">{d.impressions}</td>
                  <td className="py-2 pr-3">{d.clicks}</td>
                  <td className="py-2 pr-3">{ctrText(d.clicks, d.impressions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

function TopAdsWidget(): JSX.Element {
  const { summary, error } = useSummary(7);
  if (error) return <p className={errorClasses}>{error}</p>;
  if (!summary) return <p className={helperClasses}>Loading…</p>;
  if (summary.rows.length === 0) return <p className={helperClasses}>No ad views in the last 7 days.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>{["Ad", "Views", "CTR"].map((h) => <th key={h} className="text-left font-medium pb-2">{h}</th>)}</tr>
      </thead>
      <tbody>
        {summary.rows.slice(0, 5).map((row) => (
          <tr key={row.adId}>
            <td className="py-2">{row.name}</td>
            <td className="py-2">{row.impressions}</td>
            <td className="py-2">{ctrText(row.clicks, row.impressions)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const pages: PluginAdminExports["pages"] = { "/ads": AdsPage, "/performance": PerformancePage };
export const widgets: PluginAdminExports["widgets"] = { "top-ads": TopAdsWidget };
export default TopAdsWidget;
