// Kumo primitive class strings. EmDash's admin stylesheet defines
// every class below; do not add classes that EmDash itself doesn't use.
export const cardClasses = "bg-kumo-base border rounded-lg shadow-sm p-6";
export const cardTitleClasses = "m-0 text-base font-medium text-kumo-default";
export const fieldClasses = "flex flex-col gap-1.5";
export const labelClasses = "m-0 text-base font-medium text-kumo-default";
export const helperClasses = "text-sm leading-snug text-kumo-subtle";
export const errorClasses = "text-sm leading-snug text-kumo-danger";
export const inputClasses =
  "flex h-9 gap-1.5 rounded-lg px-3 text-base border border-kumo-line bg-kumo-overlay text-kumo-default focus-within:border-kumo-focus focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50";
export const selectClasses = inputClasses;
export const textareaClasses =
  "w-full min-h-[100px] resize-y rounded-md border border-kumo-line bg-kumo-overlay p-3 font-mono text-sm text-kumo-strong placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-brand";
export const buttonPrimaryClasses =
  "group flex items-center h-9 gap-1.5 rounded-lg px-3 text-base font-medium select-none bg-kumo-brand !text-white ring ring-kumo-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-not-allowed disabled:opacity-50";
export const buttonSecondaryClasses =
  "group flex items-center h-9 gap-1.5 rounded-lg px-3 text-base font-medium select-none bg-kumo-base !text-kumo-default ring ring-kumo-line not-disabled:hover:bg-kumo-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-not-allowed disabled:opacity-50";
export const statusIdleClasses = "text-sm leading-snug text-kumo-subtle";
export const statusErrorClasses = "text-sm leading-snug text-kumo-danger font-medium";
export const popoverClasses =
  "absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg bg-kumo-base ring ring-kumo-line text-kumo-default shadow-lg";
export const popoverItemClasses =
  "group mx-1.5 flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-base outline-none data-highlighted:bg-kumo-tint hover:bg-kumo-tint";
export const chipClasses =
  "inline-flex items-center gap-1 rounded-md ring ring-kumo-line bg-kumo-overlay px-2 py-0.5 text-xs text-kumo-default";

// Tailwind has no accent-color utility; reuse the brand token Kumo uses.
export const checkboxAccentStyle = { accentColor: "var(--color-kumo-brand)" } as const;

// Layout is inline so it never depends on a utility class EmDash didn't ship.
export const twoColumnStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 320px)",
  gap: "1.5rem",
  alignItems: "start",
} as const;
export const rowStyle = { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" } as const;
export const stackStyle = { display: "flex", flexDirection: "column", gap: "1rem" } as const;
export const listBoxStyle = {
  maxHeight: "10rem",
  overflowY: "auto",
  border: "1px solid var(--color-kumo-line)",
  borderRadius: "0.5rem",
  padding: "0.5rem",
} as const;

// Tables (Rules page). Inline for the same reason as the layout styles above.
export const tableWrapStyle = { overflowX: "auto" } as const;
export const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" } as const;
export const thStyle = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "1px solid var(--color-kumo-line)",
  fontWeight: 500,
  whiteSpace: "nowrap",
} as const;
export const tdStyle = {
  padding: "0.5rem",
  borderBottom: "1px solid var(--color-kumo-line)",
  verticalAlign: "top",
} as const;
