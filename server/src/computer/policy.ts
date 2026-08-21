/**
 * Whether a Bot may take one particular action on one particular page.
 *
 * Mirrors the policy engine in CopilotKit's enterprise agent gateway rather than being re-derived, so
 * a rule written here means the same thing there. Kept from it: CEL expressions, `dry-run` vs
 * `enforce`, default-deny, and fail-closed evaluation. Added here: a `deny` list, because an
 * allow-only policy can only forbid one thing by withdrawing permission from everything.
 *
 * CEL instead of a rule table. The boundary a company wants is a sentence: "never click anything
 * that says Submit on a page outside our own domain". A table of columns can express the shapes we
 * thought of; an expression language can express the one they thought of. This is also the language
 * the enterprise gateway already speaks, so a rule written here means the same thing there.
 *
 * Precedence: deny beats allow. A rule that removes permission must never be
 * defeated by a broader rule that grants it, or a company cannot reason about what it has forbidden.
 */
import { evaluate } from "cel-js";

export type PolicyMode = "dry-run" | "enforce";

export type ActionPolicy = {
  /**
   * `enforce` blocks. `dry-run` decides and records, and lets everything through.
   *
   * Dry-run exists so an operator can write a rule against real traffic and read the audit trail
   * before it starts refusing anybody's work. A governance feature nobody dares switch on is not a
   * governance feature.
   */
  mode: PolicyMode;
  /** Evaluated first. Any expression true means refused, whatever `allow` says. */
  deny: string[];
  /** Any expression true means permitted. Empty means nothing is permitted. */
  allow: string[];
};

/**
 * The attributes a rule can be written against.
 *
 * `element` is resolved by the gateway from the snapshot the server itself fetched, never from what
 * the caller claimed it was clicking. A policy that decides on an attacker-supplied label is
 * decoration: the whole point is that "do not click Submit" cannot be evaded by calling it something
 * else in the request.
 */
export type PolicyContext = {
  tool: { name: string };
  bot: { id: string };
  page: { url: string; host: string };
  actor: { id: string };
  element?: {
    ref: string;
    role: string;
    name: string;
    type?: string;
  };
  /**
   * The key a `computer_key` call is about to press.
   *
   * Without this, a rule about clicking is bypassed. An agent that meets a deny rule on
   * clicking "Submit order" will press Enter in the form instead, and the order goes through: the
   * click is refused and audited, the keypress is allowed, because nothing in the context could tell
   * one keypress from another.
   *
   * A form has two doors and the policy could only see one. Now a rule can say
   * `tool.name == "computer_key" && key == "Enter"`, and an operator blocking a submit button knows
   * to block both routes, which the deny example in `.env.example` now does.
   */
  key?: string;
  /**
   * What the action does, rather than which tool was called.
   *
   * `tool.name` describes mechanism. An operator thinks in effects, "do not activate anything called
   * submit", and mechanism is a poor proxy for effect: a button is activated by a click OR by Enter
   * OR by Space, so a rule naming `computer_click` covers only one activation path.
   *
   * `activate`, a click, or Enter or Space, which are the gestures that press a thing.
   * `type`, text going into a field, including any other keypress.
   * `navigate`, opening a page.
   * `read`, looking at the page or listing what is on it.
   * `write_file` / `read_file` / `list_files`, the workspace.
   *
   * It still cannot see whether a keypress will submit a form. A browser submits
   * from Enter in any field of it, and the element a keypress names is the field, not the form. The
   * gateway would need to know the page's structure at decision time, which it does not, refs are
   * held off-DOM by Playwright and the policy runs before the action reaches the browser. So a rule
   * that must stop a submission still has to refuse Enter outright, and the preset says so.
   */
  intent?:
    | "activate"
    | "type"
    | "navigate"
    | "read"
    | "read_file"
    | "write_file"
    | "list_files"
    // A tool on somebody else's MCP server. Split by effect for the same reason as the browser
    // intents: an operator thinks "nothing may change anything in Jira", not "nothing may call
    // editJiraIssue, transitionJiraIssue, addCommentToJiraIssue and the six others".
    | "read_tool"
    | "write_tool"
    | "run_command";
  /**
   * The file a `computer_read_file` or `computer_write_file` call is aimed at.
   *
   * The path is as the Bot asked for it, relative to its workspace. Containment is not policy: a path
   * that tries to escape is refused by the computer itself and is not negotiable. A rule here is about
   * which files inside the workspace a given Bot may touch.
   *
   * `name` and `extension` are split out because the rules people actually want are "nothing called
   * *.env" and "nothing under credentials/", and making them write string surgery in CEL to express
   * that would guarantee subtly wrong rules.
   */
  file?: {
    path: string;
    name: string;
    /** Without the dot, and lower-case. Empty for a file with no extension. */
    extension: string;
  };
  /**
   * The MCP server and tool a call is aimed at.
   *
   * Split out rather than left in `tool.name`. The offered tool name is `mcp__jira__editJiraIssue`,
   * and asking an operator to write string surgery against that to say "nothing may write to Jira"
   * would guarantee rules that are subtly wrong the first time a vendor renames something. Server,
   * tool and effect are three plain fields instead.
   *
   * `effect` is decided by the server's own advertised catalogue crossed with a reviewed list of
   * which of its tools change things, and it fails closed: anything not positively known to be a
   * read is a write.
   */
  mcp?: {
    server: string;
    tool: string;
    effect: "read" | "write";
  };
  /**
   * The command a Bot is about to run on its computer, verbatim.
   *
   * Verbatim because a rule about a shell can only be written against what was actually typed. This
   * is the field for `deny: contains(command, "rm -rf")`, and for the blunter and more useful
   * `deny: intent == "run_command"`, which is how a deployment says its Bots do not get a shell.
   *
   * Matching on command text is a filter, not a boundary: a command can be written a hundred ways
   * and no list catches them all. The boundary is the container the command runs in.
   */
  command?: string;
};

export type PolicyDecision = {
  allowed: boolean;
  mode: PolicyMode;
  /** Which expression decided it, so the audit row can say why and an operator can find the rule. */
  matched: string | null;
  /** Which list that expression came from. `default` means nothing matched and the floor applied. */
  source: "deny" | "allow" | "default";
  /** True when the action should actually be carried out. False for a refusal in `enforce`. */
  forward: boolean;
  /** Why, in words that go in front of a person. */
  reason: string;
};

/**
 * String helpers, registered as CEL globals.
 *
 * cel-js 0.8.2 implements no string methods at all: `element.name.contains("Submit")` raises
 * "Unknown method: contains", as do `startsWith`, `endsWith` and `matches`. These globals make
 * substring rules enforceable with the installed CEL version.
 *
 * Both are case-insensitive. A rule saying "never click submit" also catches a button labelled
 * "SUBMIT".
 */
const POLICY_FUNCTIONS: Record<string, (...args: never[]) => unknown> = {
  contains: ((haystack: unknown, needle: unknown) =>
    String(haystack).toLowerCase().includes(String(needle).toLowerCase())) as (
    ...args: never[]
  ) => unknown,
  matches: ((value: unknown, pattern: unknown) => {
    try {
      return new RegExp(String(pattern), "i").test(String(value));
    } catch {
      // An unparseable regex is a broken rule, not a match. The caller treats a thrown expression as
      // fail-closed, so returning false here would quietly weaken a deny rule; throw instead.
      throw new Error(`not a valid pattern: ${String(pattern)}`);
    }
  }) as (...args: never[]) => unknown,
};

/**
 * Evaluate one expression. Never throws.
 *
 * `onError` decides what a broken expression means, because the safe answer differs by list: a broken
 * `allow` must not permit, and a broken `deny` must not stop denying. Both are logged loudly, because
 * a policy that silently misbehaves is worse than one that visibly refuses.
 *
 * A rule can be broken two ways and only one of them throws. `"Submit order"` is valid CEL: it parses,
 * it evaluates, and it answers with a string, which is not an answer to "does this rule apply". That
 * is what somebody writes who reads the deny list as a list of labels rather than expressions, and
 * reading it as "no match" would let the action through under the permissive allow rule that ships by
 * default, with nothing logged and the rule still listed on the Boundaries page as though it were in
 * force. So anything other than a boolean is a broken rule, and takes the same fail-closed path as a
 * throw. False is a real answer and stays one; a deny list that read every false as a denial would
 * refuse everything.
 */
function matches(
  expression: string,
  context: PolicyContext,
  onError: boolean,
): boolean {
  try {
    const result = evaluate(
      expression,
      context as unknown as Record<string, unknown>,
      POLICY_FUNCTIONS as Record<string, CallableFunction>,
    );
    if (typeof result === "boolean") return result;

    console.error(
      JSON.stringify({
        type: "computer-policy-expression-error",
        expression,
        error: `expected a true or false answer, got ${result === null ? "null" : typeof result}`,
        treatedAs: onError,
      }),
    );
    return onError;
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "computer-policy-expression-error",
        expression,
        error: String(error),
        treatedAs: onError,
      }),
    );
    return onError;
  }
}

/**
 * Decide whether this action may run.
 *
 * An absent policy denies. An unconfigured deployment is one that has not said what its Bots may do,
 * and the safe reading of silence is "nothing", not "anything". The shipped configuration therefore
 * states its permissions explicitly rather than relying on a default, so that what a Bot may do is
 * always something somebody wrote down.
 */
export function evaluateActionPolicy(
  policy: ActionPolicy | null | undefined,
  context: PolicyContext,
): PolicyDecision {
  const mode: PolicyMode = policy?.mode ?? "enforce";
  const deny = policy?.deny ?? [];
  const allow = policy?.allow ?? [];

  // Deny first, and a broken deny expression still denies. One typo in a rule therefore blocks the
  // action rather than admitting it: the failure is loud, immediate and safe, and the alternative is
  // a deployment that believes it has forbidden something it has not.
  for (const expression of deny) {
    if (matches(expression, context, true)) {
      return {
        allowed: false,
        mode,
        matched: expression,
        source: "deny",
        // dry-run records the refusal and lets the work continue, which is what makes it safe to
        // switch on against live traffic.
        forward: mode === "dry-run",
        reason: describeRefusal(context, expression),
      };
    }
  }

  for (const expression of allow) {
    if (matches(expression, context, false)) {
      return {
        allowed: true,
        mode,
        matched: expression,
        source: "allow",
        forward: true,
        reason: "Permitted by policy.",
      };
    }
  }

  return {
    allowed: false,
    mode,
    matched: null,
    source: "default",
    forward: mode === "dry-run",
    reason:
      "No rule in this deployment's policy permits that action, so it was refused. " +
      "An administrator can add one.",
  };
}

/** A refusal a person can act on: what was refused, and on what. */
function describeRefusal(context: PolicyContext, expression: string): string {
  // A tool call is named by its server and its tool, and nothing else here fits it. The browser
  // fields are all present on an MCP context and all empty, deliberately, so that a rule written
  // about a page evaluates to false rather than being unevaluable. That makes every one of the
  // tests below true of a tool call and all of them wrong about it: without this branch a refused
  // Jira call reads "the file  is blocked", naming a workspace it never touched and a path that is
  // not there. Checked first because it is the only one of these that is ever certain.
  // A command is described by the command. Falling through to the page branch below would produce
  // "a run_command action on " with an empty host, because a shell call has no page.
  if (context.command) {
    return (
      `This deployment's policy does not allow that: the command \`${context.command}\` ` +
      `is blocked by the rule \`${expression}\`.`
    );
  }

  if (context.mcp) {
    return (
      `This deployment's policy does not allow that: ${context.mcp.tool} on ` +
      `${context.mcp.server} is blocked by the rule \`${expression}\`.`
    );
  }
  // A file refusal must not be phrased as happening "on <host>": the workspace has nothing to do with
  // whatever page the browser happens to be showing, and saying so sends somebody to the wrong place.
  if (context.file?.path) {
    return (
      `This deployment's policy does not allow that: the file ${context.file.path} ` +
      `is blocked by the rule \`${expression}\`.`
    );
  }
  const what = context.element?.name
    ? `“${context.element.name}”`
    : `a ${context.tool.name.replace("computer_", "")} action`;
  return (
    `This deployment's policy does not allow that: ${what} on ${context.page.host} ` +
    `is blocked by the rule \`${expression}\`.`
  );
}
