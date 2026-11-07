import { standardUI } from "@copilotkit/react-core/v2/generative-ui";
import type { ComponentType } from "react";

type TextFieldProps = {
  variant?: string | undefined;
  setValue: (value: unknown) => void;
};

/** CopilotKit's own TextField, which this one draws unchanged. */
const StandardTextField = (
  standardUI.components.get("TextField") as {
    component: ComponentType<TextFieldProps>;
  }
).component;

/**
 * What a number field puts in its data model for the text in the box: a number once the text is
 * one, otherwise the text as typed.
 *
 * Only a whole finite number converts. Text on its way to one ("", "-", "1e", "0.") is kept as it
 * is, so the box never rewrites what the person is typing, and clearing it leaves it empty.
 */
export function numberFieldValue(text: string): string | number {
  if (text.trim() === "") return text;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : text;
}

/**
 * The catalog's `TextField`: the standard one, except that a number field writes a number.
 *
 * WHY. CopilotKit's TextField writes the box's text into the data model for every variant, though
 * its value is declared as a string or a number. A Bot writes the starting amounts as numbers, so a
 * total it computes (`calc` with `transport + lodging + food`) adds until the person edits a field,
 * and from then on joins text: the trip budget starter task read "$10025080" after lodging was
 * changed to 250. Writing a number keeps the arithmetic a Bot wrote working the way it reads.
 */
export function A2UITextField(props: TextFieldProps) {
  if (props.variant !== "number") return <StandardTextField {...props} />;
  return (
    <StandardTextField
      {...props}
      setValue={(value) =>
        props.setValue(
          typeof value === "string" ? numberFieldValue(value) : value,
        )
      }
    />
  );
}
