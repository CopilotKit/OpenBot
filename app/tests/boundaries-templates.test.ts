import { expect, test } from "bun:test";
import { ruleLabel, RULE_TEMPLATES } from "@/lib/boundaries/rules";
import {
  checkPolicyRule,
  evaluateActionPolicy,
  type PolicyContext,
} from "../../server/src/computer/policy";

/**
 * The shipped templates, run through the real evaluator. A template is read by its name and its one
 * sentence before it is added, so the rule under them has to stop what they say and nothing else.
 */

const social = RULE_TEMPLATES.find(
  (template) => template.name === "Stay off social media",
)!;

/** Opening `host`, with every other field bound empty, as the gateway builds a navigation. */
function opening(host: string): PolicyContext {
  return {
    tool: { name: "computer_navigate" },
    bot: { id: "research-assistant" },
    actor: { id: "person-1" },
    page: { url: `https://${host}/`, host },
    intent: "navigate",
    key: "",
    element: { ref: "", role: "", name: "", type: "" },
    file: { path: "", name: "", extension: "" },
    command: "",
    mcp: { server: "", tool: "", effect: "" },
    initiator: { kind: "person", id: "" },
  };
}

const stopped = (host: string) =>
  !evaluateActionPolicy(
    { mode: "enforce", deny: [social.rule], allow: ["true"] },
    opening(host),
  ).allowed;

/*
 * It read `contains(page.host, "x.com")`, and "dropbox.com" and "netflix.com" both contain
 * "x.com", so a template that says it stops Facebook and X also stopped two sites that are neither.
 */
test("Stay off social media stops Facebook and X and their subdomains, and nothing that only ends in their letters", () => {
  expect(checkPolicyRule(social.rule)).toEqual({ ok: true });
  expect(
    Object.fromEntries(
      [
        "x.com",
        "www.x.com",
        "facebook.com",
        "m.facebook.com",
        "dropbox.com",
        "netflix.com",
      ].map((host) => [host, stopped(host)]),
    ),
  ).toEqual({
    "x.com": true,
    "www.x.com": true,
    "facebook.com": true,
    "m.facebook.com": true,
    "dropbox.com": false,
    "netflix.com": false,
  });
});

test("a rule added from the earlier version of a template is still shown by the template's name", () => {
  const earlier =
    'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))';
  expect(
    ruleLabel({ mode: "enforce", deny: [earlier], allow: ["true"] }, earlier),
  ).toEqual({ name: social.name, description: social.description });
});
