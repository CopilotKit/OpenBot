/**
 * The compile gate for approval rules, which are globs and not CEL.
 *
 * A glob never fails to parse: `*` matches anything and every other character is literal. So the
 * rule that "compiles" can still be one that matches nothing (`mcp/gmail/*`, where no tool is named
 * `mcp/...`), one written as a regular expression (`composio-gmail/.*`, which looks for a dot and a
 * star), or one naming a tool, a kind of action or a Bot that does not exist here. Saved, each reads
 * as protection and protects nothing. This checks every row against the matcher the gate itself uses
 * ({@link globMatches}) and the tools, effects and Bots this OpenBot has, and says what is wrong with
 * each in words a model can act on and an admin can read.
 */
import { globMatches } from "./policy";
import {
  type RuleVocabulary,
  type VocabularyTool,
  vocabularyTools,
} from "./rule-vocabulary";
import { type ApprovalRuleInput, RULE_BEHAVIOURS } from "./types";

export type RuleRowProblem = {
  /** Which row, counted from 1 as the screen counts them. */
  row: number;
  field: keyof ApprovalRuleInput;
  message: string;
};

export type RuleRowsCheck =
  | { ok: true }
  | { ok: false; error: string; problems: RuleRowProblem[] };

/** Rows from one description. More than this is not one rule. */
export const MAX_RULE_ROWS = 8;

/** A pattern's longest, as the save route allows it. */
const PATTERN_LIMIT = 300;

/** Characters that mean something in a regular expression and are literal in a glob. */
const REGEX_SYNTAX = /[\\^$|()[\]{}+?]/;
/** The same in a target, which may be a folder's or a Bot's name, where brackets can be real. */
const REGEX_IN_NAME = /[\\^$|]/;

/** A tool, an effect or a Bot is one token. A target can be a Bot's or a folder's name. */
const ONE_TOKEN = /\s/;

function patternProblem(
  value: string,
  field: keyof ApprovalRuleInput,
): string | null {
  if (!value.trim()) return "It is empty. Use * to match anything.";
  if (value !== value.trim()) return "It starts or ends with a space.";
  if (value.length > PATTERN_LIMIT)
    return `It is longer than ${PATTERN_LIMIT} characters.`;
  if (field !== "scope" && ONE_TOKEN.test(value))
    return "It has a space in it, and no name here does.";
  if (
    (field === "scope" ? REGEX_IN_NAME : REGEX_SYNTAX).test(value) ||
    value.includes(".*")
  )
    return "It is written like a regular expression. Only * is special here: it matches anything, and every other character matches itself.";
  return null;
}

function list(values: readonly string[], limit = 12): string {
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit
    ? `${shown}, and ${values.length - limit} more`
    : shown;
}

/** The tools a row's tool pattern names. */
function toolsFor(
  pattern: string,
  tools: readonly VocabularyTool[],
): VocabularyTool[] {
  return tools.filter((tool) => globMatches(pattern, tool.ref));
}

/** One row against the vocabulary, every field, so one retry can fix all of them. */
function rowProblems(
  rule: ApprovalRuleInput,
  row: number,
  vocabulary: RuleVocabulary,
  tools: readonly VocabularyTool[],
): RuleRowProblem[] {
  const problems: RuleRowProblem[] = [];
  const add = (field: keyof ApprovalRuleInput, message: string) =>
    problems.push({ row, field, message });

  for (const field of ["toolRef", "effect", "scope", "botId"] as const) {
    const problem = patternProblem(rule[field], field);
    if (problem) add(field, problem);
  }
  if (!(RULE_BEHAVIOURS as readonly string[]).includes(rule.behaviour))
    add(
      "behaviour",
      `"${rule.behaviour}" is not a behaviour. Use one of ${RULE_BEHAVIOURS.join(", ")}.`,
    );
  if (problems.length) return problems;

  const apps = vocabulary.apps.map((app) => app.id);
  const named = toolsFor(rule.toolRef, tools);
  if (named.length === 0) {
    const prefix = rule.toolRef.split("/")[0] ?? "";
    // The app an `mcp/<name>/...` pattern meant, where one is set up under a name that holds it.
    const meant = rule.toolRef.split("/")[1]?.toLowerCase() ?? "";
    const example =
      (meant && apps.find((app) => app.toLowerCase().includes(meant))) ||
      apps[0] ||
      "composio-gmail";
    add(
      "toolRef",
      rule.toolRef.startsWith("mcp/")
        ? `"${rule.toolRef}" matches no tool: no tool here starts with mcp/. An app's tool is <app id>/<tool>, such as ${example}/*.`
        : rule.toolRef.includes("*")
          ? `"${rule.toolRef}" matches no tool OpenBot has.${apps.length ? ` Apps set up: ${list(apps)}.` : " No apps are set up."}`
          : apps.includes(prefix) || rule.toolRef.includes("/")
            ? `"${rule.toolRef}" is not a tool OpenBot has.${apps.includes(prefix) ? ` ${prefix} has: ${list(tools.filter((tool) => tool.scope.kind === "app" && tool.scope.app === prefix).map((tool) => tool.ref.slice(prefix.length + 1)))}.` : apps.length ? ` Apps set up: ${list(apps)}.` : " No apps are set up."}`
            : `"${rule.toolRef}" is not a tool OpenBot has. Name an app's tool as <app id>/<tool>, or one of OpenBot's own, such as computer_click.`,
    );
    return problems;
  }

  const effects = [...new Set(named.flatMap((tool) => tool.effects))];
  const reached = named.filter((tool) =>
    tool.effects.some((effect) => globMatches(rule.effect, effect)),
  );
  if (reached.length === 0) {
    add(
      "effect",
      `"${rule.effect}" is not a kind of action ${named.length === 1 ? "that tool takes" : "those tools take"}. ${named.length === 1 ? "It takes" : "They take"}: ${list(effects)}.`,
    );
    return problems;
  }

  // An app's tool is always asked about with its app's id as the target, so a target naming
  // something else matches none of its calls. A computer's, a folder's or a hand-off's target is a
  // page, a folder or a Bot, and any of them may be one.
  if (
    reached.every((tool) => tool.scope.kind === "app") &&
    !reached.some(
      (tool) =>
        tool.scope.kind === "app" && globMatches(rule.scope, tool.scope.app),
    )
  ) {
    const own = [
      ...new Set(
        reached.map((tool) =>
          tool.scope.kind === "app" ? tool.scope.app : "",
        ),
      ),
    ];
    add(
      "scope",
      `"${rule.scope}" is never the target of ${own.length === 1 ? `a ${own[0]} tool` : "these tools"}: an app's tool is always asked about with its app's id as the target. Use ${list(own)} or *.`,
    );
  }

  if (
    rule.botId !== "*" &&
    !vocabulary.bots.some((bot) => globMatches(rule.botId, bot.id))
  )
    add(
      "botId",
      `No Bot's id is "${rule.botId}".${vocabulary.bots.length ? ` Bots: ${list(vocabulary.bots.map((bot) => `${bot.id} (${bot.name})`))}.` : ""} Use * for every Bot.`,
    );
  return problems;
}

/** Every row, against the matcher and the vocabulary. A readable error and each problem when not. */
export function checkRuleRows(
  rules: readonly ApprovalRuleInput[],
  vocabulary: RuleVocabulary,
): RuleRowsCheck {
  if (rules.length === 0)
    return {
      ok: false,
      error: "No rules were written.",
      problems: [],
    };
  if (rules.length > MAX_RULE_ROWS)
    return {
      ok: false,
      error: `That is ${rules.length} rules. Describe at most ${MAX_RULE_ROWS} at a time.`,
      problems: [],
    };
  const tools = vocabularyTools(vocabulary);
  const problems = rules.flatMap((rule, index) =>
    rowProblems(rule, index + 1, vocabulary, tools),
  );
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    error: problems
      .map((problem) =>
        rules.length > 1
          ? `Rule ${problem.row}, ${FIELD_WORDS[problem.field]}: ${problem.message}`
          : `${FIELD_WORDS[problem.field]}: ${problem.message}`,
      )
      .join(" "),
    problems,
  };
}

/** The fields as the rule form labels them. */
export const FIELD_WORDS: Record<keyof ApprovalRuleInput, string> = {
  toolRef: "Tool or app",
  effect: "Kind of action",
  scope: "Target",
  botId: "Bot",
  behaviour: "Behaviour",
};

/**
 * Rows that check and still cannot be what anybody meant: one that covers every action every Bot
 * takes. "Ask before anything" is a choice somebody can make, so it is said, not refused.
 */
export function ruleRowsWarning(
  rules: readonly ApprovalRuleInput[],
): string | null {
  const everything = rules.findIndex(
    (rule) =>
      rule.toolRef === "*" &&
      rule.effect === "*" &&
      rule.scope === "*" &&
      rule.botId === "*",
  );
  if (everything === -1) return null;
  const rule = rules[everything] as ApprovalRuleInput;
  const which = rules.length > 1 ? `Rule ${everything + 1}` : "This rule";
  return rule.behaviour === "allow"
    ? `${which} covers every action every Bot takes, so Bots stop asking before changes unless a stricter rule or a safety requirement asks.`
    : `${which} covers every action every Bot takes, including every page it reads.`;
}
