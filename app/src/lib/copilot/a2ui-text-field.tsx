import {
  type GenerativeUIComponentProps,
  standardUI,
} from "@copilotkit/react-core/v2/generative-ui";

import { useEffect, useState } from "react";

const definition = standardUI.components.get("TextField");
if (!definition) throw new Error("The standard catalog has no TextField");
const StandardTextField = definition.component;
type Props = GenerativeUIComponentProps<typeof standardUI, "TextField">;

/**
 * Keep the SDK's field, but store numbers so generated totals do not concatenate text.
 * Clearing intentionally stores zero for arithmetic, displayed blank during this edit.
 * This is not a nullable field: submitting or remounting reads that model value as zero.
 *
 * WHY. CopilotKit's TextField writes the box's text into the data model for every variant. A Bot
 * writes the starting amounts as numbers, so a total it computes (`calc` with
 * `transport + lodging + food`) added until the person edited a field and then joined text: the trip
 * budget starter task read "$10025080" after lodging was changed to 250.
 */
export function A2UITextField(props: Props) {
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    if (props.value !== 0 || props.variant !== "number") setEmpty(false);
  }, [props.value, props.variant]);
  return (
    <StandardTextField
      {...props}
      value={
        props.variant === "number" && empty && props.value === 0
          ? ""
          : props.value
      }
      setValue={(value: string | number) => {
        if (props.variant !== "number") {
          props.setValue(value);
          return;
        }
        setEmpty(value === "");
        const number = Number(value);
        props.setValue(Number.isFinite(number) ? number : value);
      }}
    />
  );
}
