import { checkboxAccentStyle, helperClasses, rowStyle } from "./ui";

export function Checkbox(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={helperClasses} style={rowStyle}>
      <input
        type="checkbox"
        style={checkboxAccentStyle}
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}
