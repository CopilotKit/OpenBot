import type { ActionPolicy, RuleLabel } from "@/lib/computers/queries";

/**
 * A rule an administrator can start from, in words first and CEL underneath.
 *
 * `cost` is what the rule also catches, or misses, that its name does not say. Each one is a real
 * edge of the rule as written, so it is shown before the rule is added rather than discovered from
 * the refusals it produces.
 */
export type RuleTemplate = RuleLabel & { rule: string; cost: string };

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    name: "Never submit a form",
    description: "Stops a Bot pressing a submit button, or Enter while typing.",
    // `key` is guarded by tool name so the clause short-circuits before it on actions that have no
    // keypress in them. Both tools that can press Enter are named: `computer_type` takes a `submit`
    // flag that presses it once the text is in, and a rule naming only `computer_key` left that door
    // open.
    rule: '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && key == "Enter")',
    cost: "Also stops the Bot pressing Enter anywhere else. A form can submit from Enter in any field.",
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
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    cost: "Only these two sites. A link that redirects there from elsewhere is allowed.",
  },
];

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
  const template = RULE_TEMPLATES.find((one) => one.rule === rule);
  if (template)
    return { name: template.name, description: template.description };
  return { name: "Custom rule", description: "" };
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
