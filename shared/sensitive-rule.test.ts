import { expect, test } from "bun:test";
import { SENSITIVE_FIELD as rulesCopy } from "./demonstration-rules";
import {
  isSensitiveTarget,
  SENSITIVE_FIELD as maskingCopy,
} from "./recorder-masking";

test("the two copies of the sensitive-field rule are the same literal", () => {
  expect(maskingCopy.source).toBe(rulesCopy.source);
  expect(maskingCopy.flags).toBe(rulesCopy.flags);
});

test("both rules agree on every label", () => {
  const labels = [
    "Card number",
    "Security code",
    "Password",
    "Shipping",
    "Topping",
    "cvc",
    "Card notes",
  ];
  for (const label of labels) {
    expect(isSensitiveTarget({ label })).toBe(rulesCopy.test(label));
  }
});
