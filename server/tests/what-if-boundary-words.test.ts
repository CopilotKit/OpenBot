import { describe, expect, test } from "bun:test";
import { evaluateActionPolicy } from "../src/computer/policy";
import { boundaryLayer } from "../src/what-if-check";

/**
 * How the Boundaries layer of "What would happen" and "Why did this happen?" says which rule
 * decided. An unnamed rule once read "The rule a rule with no name allows it."
 */
describe("the boundary layer's sentence", () => {
  const context = {
    intent: "navigate",
    tool: { name: "computer_navigate" },
    page: { url: "https://www.facebook.com/", host: "www.facebook.com" },
  } as never;
  const deny = 'intent == "navigate" && page.host == "www.facebook.com"';

  test("an unnamed rule that allows it", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [], allow: ["true"] },
      context,
    );
    expect(boundaryLayer(decision).summary).toBe(
      "A rule with no name allows it.",
    );
  });

  test("an unnamed rule that refuses it", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [deny], allow: ["true"] },
      context,
    );
    expect(boundaryLayer(decision).summary).toBe(
      "A rule with no name refuses it.",
    );
  });

  test("a named rule that refuses it", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: [deny],
        allow: ["true"],
        labels: { [deny]: { name: "No social media", description: "" } },
      },
      context,
    );
    expect(boundaryLayer(decision).summary).toBe(
      'The rule "No social media" refuses it.',
    );
  });
});
