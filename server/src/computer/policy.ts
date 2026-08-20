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
 * Precedence: deny, then ask, then allow. A rule that removes permission must never be
 * defeated by a broader rule that grants it, or a company cannot reason about what it has forbidden.
 *
 * `ask` sits between the two, and both halves of that position are deliberate. It must not soften a
 * `deny`, because a thing a deployment has forbidden is not up for renegotiation at a prompt, and an
 * approval box in front of a tired person at the end of a task is not the review anybody signed off
 * when they wrote the deny rule. And it must beat `allow`, because the policy this product ships with
 * is `allow: ["true"]`: an ask evaluated after the allow list would be unreachable in the default
 * configuration, so the first rule anybody ever wrote here would silently do nothing.
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
  /** Evaluated first. Any expression true means refused, whatever `ask` or `allow` says. */
  deny: string[];
  /**
   * Any expression true means a person is asked before the action runs.
   *
   * The middle answer a boundary with two lists cannot give. "It may spend money, but not more than
   * fifty pounds without me" and "it may do this, but I want to see the first one" are the shapes
   * every deployment reaches for once it trusts a Bot enough to let it act at all, and until this
   * list existed the only way to express either was to forbid the action and have a person take the
   * wheel, which throws away the Bot's turn and everything it had worked out to get there.
   */
  ask: string[];
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
  /**
   * How many times this Bot has just made this exact call, counting the one being decided.
   *
   * A stuck model retries, and every retry is a real action on somebody's live website. Each one is
   * permitted on its own terms, because each one is: the rule that would refuse the thirtieth click
   * on a button would refuse the first, and refusing the first is refusing the product. Only the
   * count separates them, so the count is here, and a deployment that wants to stop a Bot going in
   * circles writes `repeat.count >= 10` and nothing else changes.
   *
   * Always present, at one on a call the Bot has not made before, so that a rule mentioning it is
   * evaluable on every action. An absent field would throw inside CEL, and a deny rule that throws
   * denies, so an optional `repeat` would turn one rule about repetition into a deployment that
   * refuses everything.
   *
   * It is wrong in both directions, and a rule written against it has to be worth both. Under, three
   * ways: the window is time-based, so a Bot slow enough to spread its attempts wider than the window
   * never trips this, and one that varies a single argument each time round is thirty calls; the
   * count is held by the process that served the call, so a deployment behind two API replicas
   * splits every count and a rule about ten attempts fires at twenty or never; and a call to another
   * server's tools over MCP is not counted at all, because only the computer gateway counts.
   *
   * Over, once, and that one costs somebody their Bot rather than their evidence. Two calls are the
   * same call when the thing acted on is the same, whatever was typed into it, so ten searches typed
   * into one box and one file read ten times while a Bot works through it are both ten repeats, and
   * `repeat.count >= 10` refuses the tenth. It is a backstop against the loop that actually happens,
   * not a guarantee, which is the argument for trying a rule about it in `dry-run` first.
   */
  repeat: { count: number };
  /**
   * Whether anybody is watching this run.
   *
   * A scheduled or webhook-triggered run has no person at the screen: nobody can take the wheel,
   * nobody can answer a question, and nobody notices the wrong button being pressed until the
   * consequence arrives. That is a real difference in risk from the same action taken while somebody
   * is sitting there, and until now the policy could not see it, so a deployment had to choose one
   * boundary for both.
   *
   * With this a rule can be stricter about work nobody is supervising without being stricter about
   * everything: `run.unattended && intent == "activate"` lets a routine read, browse and write
   * notes, and forbids it pressing anything.
   *
   * Always present, never optional. This engine treats an expression it cannot evaluate as a match,
   * which for a deny rule means refusing. A context that sometimes omitted this field would turn
   * every rule naming it into a rule that refuses every attended action too, which is the opposite
   * of what whoever wrote it meant. Same reasoning as the neutral values plugins/store.ts fills in.
   */
  run: { unattended: boolean };
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
   * Whether a `computer_type` call will press Enter when it has finished typing.
   *
   * The third door into a form, and the one a rule about clicking and a rule about `key` both miss.
   * The type tool takes a flag meaning "and submit", the computer presses Enter itself, and no
   * keypress ever reaches the gateway as its own action, so a boundary written against Enter watched
   * the Bot walk past it: a preset named "never submit a form" left the one call that submits a
   * single-field form untouched.
   *
   * Present on every action rather than only on the calls that can set it, and false is doing work
   * there. `key` is absent unless a key was pressed, which is why the presets that mention it have
   * to be guarded by tool name to stay evaluable; a rule saying `submit` should not need that
   * ceremony, because the whole point of the field is that an operator writes one short sentence
   * about form submission and it holds everywhere.
   */
  submit?: boolean;
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
   * that must stop a submission still has to refuse Enter outright, and the preset says so. `submit`
   * above covers the one case where the intention is not a guess, because the Bot asked for it.
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
    | "write_tool";
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
};

export type PolicyDecision = {
  allowed: boolean;
  mode: PolicyMode;
  /** Which expression decided it, so the audit row can say why and an operator can find the rule. */
  matched: string | null;
  /**
   * Which list that expression came from. `default` means nothing matched and the floor applied.
   *
   * `ask` is not a verdict on its own: it says the boundary wants a person's answer, and the caller
   * decides what to do about that. The gateway either finds an approval already granted for this
   * exact action or stops and asks; both outcomes are recorded with this source, so the trail can
   * tell an action a person consented to from one nothing ever questioned.
   */
  source: "deny" | "ask" | "allow" | "default";
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
 */
function matches(
  expression: string,
  context: PolicyContext,
  onError: boolean,
): boolean {
  try {
    return (
      evaluate(
        expression,
        context as unknown as Record<string, unknown>,
        POLICY_FUNCTIONS as Record<string, CallableFunction>,
      ) === true
    );
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
  const ask = policy?.ask ?? [];
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

  // Ask second, and a broken ask expression asks. The same reasoning as the deny loop, with a gentler
  // cost: a typo here interrupts somebody who was not expecting to be interrupted, which is a
  // nuisance, whereas the alternative is a rule that quietly permits exactly the thing it was written
  // to hold back. A boundary whose failures land on the permissive side is not a boundary.
  for (const expression of ask) {
    if (matches(expression, context, true)) {
      return {
        allowed: false,
        mode,
        matched: expression,
        source: "ask",
        // Nothing happens until somebody says so, except in dry-run, where the whole promise is that
        // switching the policy on changes nothing. A dry-run ask is a note in the trail saying "here
        // is where you would have been interrupted", which is precisely what an operator trying a
        // rule out against real traffic wants to find out before it starts stopping anybody.
        forward: mode === "dry-run",
        reason: describeAsk(context),
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

/**
 * The verb a person reads, chosen from what the action does rather than which tool ran.
 *
 * A question phrased as "allow computer_write_file?" asks somebody to translate an implementation
 * detail before they can decide, and a question nobody understands gets answered yes.
 */
const ASK_VERBS: Record<string, string> = {
  activate: "press",
  type: "type into",
  navigate: "open",
  read: "look at",
  read_file: "read",
  write_file: "write to",
  list_files: "list",
  read_tool: "call",
  write_tool: "call",
};

/**
 * The question itself: what is about to happen, in one sentence.
 *
 * The rule that asked is deliberately not in here. It travels beside the question as its own field,
 * so the surface can show it as a rule and the trail can record it as one, and a person reading the
 * prompt is not made to parse CEL before they can answer a question about a button.
 */
function describeAsk(context: PolicyContext): string {
  return `The Bot wants to ${ASK_VERBS[context.intent ?? ""] ?? "act on"} ${subjectOf(context)}.`;
}

/** A refusal a person can act on: what was refused, and on what. */
function describeRefusal(context: PolicyContext, expression: string): string {
  // A file or tool refusal must not be phrased as happening "on <host>": neither the workspace nor
  // somebody else's server has anything to do with whatever page the browser happens to be showing,
  // and saying so sends somebody to the wrong place.
  if (context.mcp) {
    return (
      `This deployment's policy does not allow that: ${subjectOf(context)} ` +
      `is blocked by the rule \`${expression}\`.`
    );
  }
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

/**
 * The thing an action is aimed at, named the way the person who has to decide would name it.
 *
 * Every branch is checked for content rather than presence, because a caller judging something that
 * is not a browser action fills the browser fields in with empty strings on purpose: a rule about
 * element names must evaluate to false against a tool call rather than becoming unevaluable and
 * therefore matching. Reading those blanks as "a file" produced a question with a hole in it, "The
 * Bot wants to call .", which is a sentence nobody can answer and which arrived attached to two
 * buttons.
 */
function subjectOf(context: PolicyContext): string {
  if (context.mcp) return `${context.mcp.tool} on ${context.mcp.server}`;
  if (context.file?.path) return context.file.path;
  if (context.element?.name) {
    return `“${context.element.name}” on ${context.page.host}`;
  }
  return context.page.host || "this page";
}
