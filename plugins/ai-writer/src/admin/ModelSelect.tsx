import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelsResponse } from "../lib/models";
import type { ListedModel } from "../lib/openrouter";
import type { Provider } from "../lib/providers";
import { formatCost, formatTokenPrices } from "../lib/usage";
import { apiGet, type ApiError } from "./api";
import { buttonSecondaryClasses, helperClasses, inputClasses, popoverClasses, popoverItemClasses } from "./ui";

type CatalogState = { data: ModelsResponse | null; error: ApiError | null };
const NO_OPTIONS: ListedModel[] = [];
let catalogPromise: Promise<CatalogState> | null = null;

// One request per page load, shared by every picker on the page. A failed or
// partial load is not cached, so the next mount refetches.
function loadCatalog(): Promise<CatalogState> {
  if (!catalogPromise) {
    catalogPromise = apiGet<ModelsResponse>("models").then((r) => {
      if (r.ok === true) {
        if (Object.keys(r.data.errors).length > 0) catalogPromise = null;
        return { data: r.data, error: null };
      }
      catalogPromise = null;
      return { data: null, error: r.error };
    });
  }
  return catalogPromise;
}

/** Price shown under a model: listed token prices, or the last cost seen for an image model. */
export function priceLabel(kind: "text" | "image", m: ListedModel, imagePrices?: Record<string, number>): string {
  if (kind === "image") {
    const seen = imagePrices?.[m.id];
    return seen === undefined ? "" : `~${formatCost(seen)} / image (last seen)`;
  }
  return formatTokenPrices(m.promptPrice, m.completionPrice);
}

/** Drop the cached catalog so the next picker mount refetches (e.g. after Settings saves new providers). */
export function invalidateCatalog(): void {
  catalogPromise = null;
}

export function useCatalog(): CatalogState {
  const [state, setState] = useState<CatalogState>({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    void loadCatalog().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// Search-then-pick input. Free text is accepted too, so a known model id can
// be typed even when the catalog failed to load. Empty value = "use default".
// Options come from `provider` when given (the Settings page's unsaved
// choice), otherwise from the saved provider for this kind.
export function ModelSelect(props: {
  kind: "text" | "image";
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  ariaLabel: string;
  compact?: boolean;
  provider?: Provider;
}) {
  const { kind, value, onChange, placeholder, ariaLabel, compact, provider } = props;
  const { data } = useCatalog();
  const active = provider ?? data?.providers[kind];
  const options: ListedModel[] = data && active ? data.catalogs[active][kind] : NO_OPTIONS;
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list =
      q === "" || q === value.toLowerCase()
        ? options
        : options.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    return list.slice(0, 50);
  }, [options, query, value]);

  const selected = options.find((m) => m.id === value);
  const selectedPrice = selected ? priceLabel(kind, selected, data?.imagePrices) : "";

  const pick = (id: string) => {
    onChange(id);
    setQuery(id);
    setOpen(false);
  };

  return (
    <div ref={containerRef} style={{ position: "relative", width: compact ? "15rem" : "100%" }}>
      <div style={{ display: "flex", gap: "0.25rem" }}>
        <input
          type="text"
          aria-label={ariaLabel}
          value={query}
          placeholder={placeholder}
          className={inputClasses}
          style={{ width: "100%" }}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            onChange(e.target.value.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
        {value ? (
          <button type="button" aria-label={`Clear ${ariaLabel}`} className={buttonSecondaryClasses} onClick={() => pick("")}>
            ×
          </button>
        ) : null}
      </div>
      {open ? (
        <div role="listbox" className={popoverClasses}>
          {filtered.length === 0 ? (
            <div className={helperClasses} style={{ padding: "0.5rem 0.75rem" }}>
              No models loaded — type a model id.
            </div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === value}
                className={popoverItemClasses}
                onClick={() => pick(m.id)}
              >
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.name}
                </span>
                <span className={helperClasses}>
                  {m.id}
                  {priceLabel(kind, m, data?.imagePrices) ? ` · ${priceLabel(kind, m, data?.imagePrices)}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {selectedPrice && !compact ? <p className={helperClasses}>{selectedPrice}</p> : null}
    </div>
  );
}
