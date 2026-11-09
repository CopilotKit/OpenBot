import type { ActionPolicy, RuleLabel } from "@/lib/computers/queries";

/**
 * A rule an administrator can start from, in words first and CEL underneath.
 *
 * `cost` is what the rule also catches, or misses, that its name does not say. Each one is a real
 * edge of the rule as written, so it is shown before the rule is added rather than discovered from
 * the refusals it produces.
 */
export type RuleTemplate = RuleLabel & {
  rule: string;
  cost: string;
  /**
   * The rule's earlier text, still in force wherever it was added before it changed, and saved
   * without a name of its own then. Read so that rule keeps the template's name.
   */
  formerRules?: string[];
};

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    name: "Never submit a form",
    description: "Stops a Bot pressing a submit button, or Enter while typing.",
    // The keypress clause is guarded by tool name so a click is only refused on a submit button.
    // Both tools that can press Enter are named: `computer_type` takes a `submit` flag that presses
    // it once the text is in, and a rule naming only `computer_key` left that door open. It asks for
    // the activation the gateway reads from the key, not `key == "Enter"`, so Shift+Enter, `\n` and
    // Space (which press a focused button) are refused as well.
    rule: '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && intent == "activate")',
    cost: "Also stops the Bot pressing Enter or Space anywhere else. A form can submit from Enter in any field.",
  },
  {
    name: "Never type into a password field",
    description: "Stops a Bot typing into a field labelled as a password.",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "A password box with a different label isn't covered. The rule matches the label.",
  },
  {
    name: "Stay off social media",
    description: "Stops a Bot opening Facebook or X.",
    // Each site, or a name ending in a dot and the site. `contains(page.host, "x.com")` also stopped
    // dropbox.com and netflix.com. The dot is `[.]` because cel-js keeps backslashes as written, so
    // `\\.` would match a backslash and the rule would stop nothing.
    rule: 'intent == "navigate" && (page.host == "facebook.com" || matches(page.host, "[.]facebook[.]com$") || page.host == "x.com" || matches(page.host, "[.]x[.]com$"))',
    formerRules: [
      'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    ],
    cost: "Only these two sites. A link that redirects there from elsewhere is allowed.",
  },
];

/** The template a rule came from: its current text, or one it shipped with before. */
function templateOf(rule: string): RuleTemplate | undefined {
  return RULE_TEMPLATES.find(
    (one) => one.rule === rule || one.formerRules?.includes(rule),
  );
}

/** What a rule can be written against, in the words an administrator would use. */
export const RULE_ATTRIBUTES: { name: string; meaning: string }[] = [
  {
    name: "tool.name",
    meaning:
      "The action, such as computer_click, computer_type or computer_key.",
  },
  {
    name: "intent",
    meaning: "What the action is for: activate, type or navigate.",
  },
  { name: "bot.id", meaning: "The Bot taking the action." },
  { name: "actor.id", meaning: "The person the Bot is acting for." },
  {
    name: "initiator.kind",
    meaning:
      "What started the run: person, routine or handoff. A scheduled run acts as its owner, so actor.id alone can't tell you.",
  },
  { name: "page.url, page.host", meaning: "The page the Bot is on." },
  {
    name: "element.name, element.role",
    meaning: "The button, link or field being clicked or typed into.",
  },
  { name: "key", meaning: "The key pressed, such as Enter." },
  { name: "file", meaning: "The file being read or written." },
  { name: "command", meaning: "The command being run." },
  {
    name: "mcp.server, mcp.tool, mcp.effect",
    meaning:
      "For a connected app's tool: which app, which tool, and read or write.",
  },
];

/** The name a rule is shown by: its label, a template's name if it is one, or plainly "Custom rule". */
export function ruleLabel(policy: ActionPolicy, rule: string): RuleLabel {
  const label = policy.labels?.[rule];
  if (label) return label;
  const template = templateOf(rule);
  if (template)
    return { name: template.name, description: template.description };
  return { name: "Custom rule", description: "" };
}

/**
 * The policy with one rule rewritten in place, keeping its position and taking its name with it.
 *
 * A template's rule has no stored label, only the template's own, so that one is stored under the
 * new text: edited, it no longer matches the template, and would otherwise read as "Custom rule".
 */
export function withRuleReplaced(
  policy: ActionPolicy,
  rule: string,
  next: string,
): ActionPolicy {
  const { [rule]: own, ...labels } = policy.labels ?? {};
  const template = templateOf(rule);
  const label =
    own ??
    (template
      ? { name: template.name, description: template.description }
      : undefined);
  return {
    ...policy,
    deny: policy.deny.map((one) => (one === rule ? next : one)),
    labels: label ? { ...labels, [next]: label } : labels,
  };
}

/** The policy without one rule, and without that rule's label. */
export function withoutRule(policy: ActionPolicy, rule: string): ActionPolicy {
  const { [rule]: _removed, ...labels } = policy.labels ?? {};
  return {
    ...policy,
    deny: policy.deny.filter((one) => one !== rule),
    labels,
  };
}
