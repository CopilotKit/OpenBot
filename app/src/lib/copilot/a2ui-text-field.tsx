import {
  type GenerativeUIComponentProps,
  standardUI,
} from "@copilotkit/react-core/v2/generative-ui";

import { useState } from "react";

const definition = standardUI.components.get("TextField");
if (!definition) throw new Error("The standard catalog has no TextField");
const StandardTextField = definition.component;
type Props = GenerativeUIComponentProps<typeof standardUI, "TextField">;

/** Keep the SDK's field, but preserve numbers in the generated surface's data model. */
export function A2UITextField(props: Props) {
  const [empty, setEmpty] = useState(false);
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
