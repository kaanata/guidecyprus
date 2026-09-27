import type { ReactNode } from "react";
import { fieldClasses, helperClasses, labelClasses } from "./ui";

export function Field(props: { label: string; helper?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={fieldClasses}>
      <label htmlFor={props.htmlFor} className={labelClasses}>
        {props.label}
      </label>
      {props.children}
      {props.helper ? <p className={helperClasses}>{props.helper}</p> : null}
    </div>
  );
}
