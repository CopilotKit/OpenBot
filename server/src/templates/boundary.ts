/**
 * The author's ceiling, turned into rules this deployment wrote.
 *
 * A TEMPLATE NEVER WRITES CEL. The `boundary:` block is a closed vocabulary of four keys and a list
 * of hostnames, and this file is the only thing that turns any of it into an expression. That
 * asymmetry is the whole security argument for shipping a per-Bot ceiling that a stranger's file gets
 * to influence: a stranger chooses between `read_only` and `full`, and a program here decides what
 * either of those means in the language the policy engine actually evaluates. If a template could
 * carry an expression instead, importing one would be handing somebody else's text to `evaluate`,
 * and every refusal in `shared/bot-template.ts` would be decoration around an open door.
 *
 * The clauses go in `template_boundaries` and are read as extra `deny` entries for one Bot. They are
 * NOT written into the deployment's `action_policy`, which is one row for everybody: a template may
 * only subtract, only for its own Bot, and only through a table an administrator can retract in one
 * act.
 *
 * EVERY CLAUSE IS SCOPED FIRST AND SCOPED BY THE BOT. `bot.id == "<agentId>" && (…)` is not merely
 * tidy. cel-js short-circuits `&&`, so for every other Bot in the deployment the tail of the clause
 * is never evaluated — and the tail is the part that names `intent`, an identifier cel-js throws on
 * when it is unbound. A throw in a deny list counts as a match, by design, so an unscoped clause that
 * threw would refuse an action for every Bot in the deployment rather than for the one the template
 * described. Putting the scope first turns a blast radius of "the whole deployment" into "the
 * imported Bot", which is the difference between a ceiling and an outage. Any future clause shape
 * must keep the scope as the leading conjunct for exactly this reason.
 *
 * The named Bot itself can still meet a throw: `gateway.ts` spreads `intent` in only when `intentOf`
 * recognised the tool, so a tool with no intent mapping leaves the identifier unbound and every
 * clause here throws for that Bot and refuses that action. That is the direction to fail in. A Bot
 * whose file said `shell: never` should not get a shell because somebody added a tool the intent
 * table has not caught up with.
 */
import type { BotTemplateBoundary } from "../../../shared/bot-template";
import { evaluateActionPolicy, type PolicyContext } from "../computer/policy";
import type { TemplateBoundarySource } from "./store";

/**
 * One compiled deny clause, and the line of the vocabulary that produced it.
 *
 * `agentId` is carried on the clause rather than passed alongside it, because validation needs it.
 * A clause is scoped by the Bot and cel-js short-circuits, so evaluating one against a context for
 * any other Bot proves only that the first conjunct parses — the tail, which is the part that can
 * throw, is never reached. A validator that cannot name the Bot the clause is about can therefore
 * only pretend to check it, and the row this becomes carries `agent_id` anyway.
 */
export type CompiledClause = {
  expression: string;
  sourceKey: TemplateBoundarySource;
  agentId: string;
};

/**
 * A clause that will not be stored, and the text of the thing that was refused.
 *
 * Thrown rather than returned, and thrown from the compiler as well as from the validator, because
 * there is no partially-safe answer to give a caller: an import either lands with the ceiling its
 * file described or it does not land. The import module turns this into a refusal with a `reason`,
 * the same way it treats a document that does not parse.
 */
export class BoundaryClauseRefusedError extends Error {
  /** What was refused. Safe to log and to show an administrator: nothing here is a secret. */
  readonly expression: string;

  constructor(expression: string, message: string) {
    super(message);
    this.name = "BoundaryClauseRefusedError";
    this.expression = expression;
  }
}

/**
 * The characters a value may contain to be written into a clause verbatim.
 *
 * Deliberately narrower than either thing that reaches it. An agent id is `agent_<uuid>` and a
 * hostname has already been through `HOSTNAME` in the parser, so both are comfortably inside this
 * set — and the emitter still checks, because "the caller validated it" is an assumption that
 * survives exactly until somebody adds a second caller.
 *
 * A set rather than an escape function, and this is the one surprising decision in the file.
 * cel-js does not decode escape sequences: the literal `"a\"b"` evaluates to the four-character
 * string `a\"b` rather than to `a"b`, as does `"a\\b"` and `"a\nb"`. So escaping is structurally
 * safe — a `\"` does not terminate the literal, and `") || true || ("` cannot break out — but it is
 * semantically lossy, and a host clause built from a mangled literal would be a rule that silently
 * never matches the host it names. In a negated list that over-denies and in any other position it
 * under-denies, and neither is a thing to discover from an audit row six months later. A value this
 * emitter cannot represent exactly is therefore a refusal rather than an approximation.
 */
const REPRESENTABLE = /^[A-Za-z0-9._-]{1,253}$/;

/**
 * The one place a value becomes part of an expression.
 *
 * Every literal in every clause goes through here, including the ones this file chose itself, like
 * `run_command`. Routing our own constants through the same check costs nothing and means the file
 * has no second, unchecked path for a string to reach `evaluate` — which is the property being
 * claimed, and a property with an exception is not one.
 */
function equals(field: string, value: string): string {
  if (!REPRESENTABLE.test(value)) {
    throw new BoundaryClauseRefusedError(
      `${field} == ${JSON.stringify(value)}`,
      `a boundary clause cannot be written against ${JSON.stringify(value)}: only letters, digits, dot, underscore and hyphen can be emitted exactly, and this compiler refuses a value it would have to approximate`,
    );
  }
  return `${field} == "${value}"`;
}

/** `intent == "a" || intent == "b"`, which is how the vocabulary's plural entries are said. */
function anyIntent(intents: readonly string[]): string {
  return intents.map((intent) => equals("intent", intent)).join(" || ");
}

/**
 * The vocabulary, compiled.
 *
 * The permissive end of every key emits nothing. `shell: permitted` is not a rule that permits a
 * shell — nothing here can grant anything, and a row saying "this Bot may run commands" would read
 * on the Boundaries screen as though the template had conferred something. A ceiling that forbids
 * nothing is an absence of clauses, which is also what makes retraction honest: the rows that exist
 * are exactly the things somebody consented to giving up.
 *
 * Validation runs here rather than only at the call site. A caller that forgets is the failure this
 * is guarding against, so the compiler refuses its own output before returning it and the exported
 * validator stays available for clauses that arrive from somewhere else.
 */
export function compileBoundary(
  agentId: string,
  boundary: BotTemplateBoundary,
): CompiledClause[] {
  const scope = equals("bot.id", agentId);
  const clauses: CompiledClause[] = [];
  const add = (sourceKey: TemplateBoundarySource, predicate: string) => {
    clauses.push({
      expression: `${scope} && (${predicate})`,
      sourceKey,
      agentId,
    });
  };

  if (boundary.shell === "never") {
    add("shell", anyIntent(["run_command"]));
  }
  if (boundary.files === "none") {
    add("files", anyIntent(["read_file", "write_file", "list_files"]));
  } else if (boundary.files === "read_only") {
    add("files", anyIntent(["write_file"]));
  }
  if (boundary.browser === "none") {
    add("browser", anyIntent(["activate", "type", "navigate", "read"]));
  } else if (boundary.browser === "read_only") {
    // `navigate` and `read` are absent on purpose: read-only means looking, and looking includes
    // opening the page being looked at. What it excludes is the two gestures that change something
    // on somebody else's site.
    add("browser", anyIntent(["activate", "type"]));
  }
  /*
   * A host list compiles to equality and never to a pattern.
   *
   * `POLICY_FUNCTIONS.matches` throws on an unparseable pattern, and a throwing deny expression
   * counts as a match in `evaluateActionPolicy` — which is right for a hand-written rule and
   * catastrophic for a generated one, because the clause would refuse every action it is evaluated
   * against rather than the navigation it was about. Equality cannot throw, cannot backtrack, and
   * cannot be widened by a metacharacter in a hostname that got past the parser.
   *
   * Emitted whenever the list is non-empty, including when `browser: none` has already denied
   * navigation outright. The rows are the record of what the file said, and a compiler that dropped
   * a clause because another one happened to cover it would make the stored ceiling depend on a key
   * the row does not name.
   *
   * `page.host` comes from `hostOf`, which is `URL.host` and therefore carries a non-default port:
   * a navigation to `billing.example:8443` does not equal the listed `billing.example` and is
   * refused. The parser refuses a port in the file, so a template cannot say otherwise, and being
   * refused is the safe half of that mismatch.
   */
  if (boundary.navigateHosts.length > 0) {
    const permitted = boundary.navigateHosts
      .map((host) => equals("page.host", host))
      .join(" || ");
    add("navigate_hosts", `${equals("intent", "navigate")} && !(${permitted})`);
  }
  if (boundary.mcp === "none") {
    add("mcp", anyIntent(["read_tool", "write_tool"]));
  } else if (boundary.mcp === "read_only") {
    add("mcp", anyIntent(["write_tool"]));
  }

  refuseUnsafeClauses(clauses);
  return clauses;
}

/**
 * Every intent the gateway and the MCP path can bind, so validation exercises the whole clause.
 *
 * Written out rather than derived, because a union of string literals cannot be enumerated at run
 * time without a cast. The annotation catches a renamed or deleted intent at compile time; an ADDED
 * one is not caught, so adding an intent to `PolicyContext` means adding it here in the same change.
 * A clause checked against fewer situations than it will meet is checked less than it looks.
 */
const NEUTRAL_INTENTS: readonly NonNullable<PolicyContext["intent"]>[] = [
  "activate",
  "type",
  "navigate",
  "read",
  "read_file",
  "write_file",
  "list_files",
  "read_tool",
  "write_tool",
  "run_command",
];

/**
 * A context that is about nothing, for a Bot that is about to exist.
 *
 * Every field is bound, mirroring the neutral binding the gateway and the MCP path both construct,
 * because an unbound identifier throws in cel-js and a validator that let a clause throw for the
 * wrong reason would refuse a correct clause.
 *
 * `bot.id` is the real agent id, and it has to be. cel-js short-circuits `&&`, so a context naming
 * any other Bot stops at the first conjunct and the tail — the part that can throw — is never
 * evaluated. Checking a scoped clause against a foreign Bot proves only that the scope parses.
 *
 * "Neutral" here means the context describes no action anybody took, not that no clause matches it.
 * Some clause will match some intent — that is what a deny clause is for — and the check below is
 * about whether a clause ANSWERS the question rather than about what it answers.
 */
function neutralContext(
  agentId: string,
  intent: NonNullable<PolicyContext["intent"]>,
): PolicyContext {
  return {
    tool: { name: "template_boundary_check" },
    bot: { id: agentId },
    actor: { id: "" },
    // `.invalid` is reserved by RFC 2606 and resolves nowhere, so this names no site an author could
    // have meant even though the parser would accept it as a hostname.
    page: { url: "", host: "template-boundary.invalid" },
    element: { ref: "", role: "", name: "", type: "" },
    key: "",
    file: { path: "", name: "", extension: "" },
    command: "",
    mcp: { server: "", tool: "", effect: "" },
    intent,
  };
}

/**
 * Whether an expression answered true or false, as opposed to throwing or answering with a string.
 *
 * Asked through `evaluateActionPolicy` twice rather than by calling cel-js directly, so that what is
 * being checked is the engine that will actually judge this clause, with its function table and its
 * own handling of a broken expression, rather than a second evaluator that could drift from it.
 *
 * The two calls are what make a throw visible. `evaluateActionPolicy` deliberately hides the
 * difference between "true" and "broken", because both must deny — but it hides it in opposite
 * directions depending on the list: a broken expression in `deny` matches and a broken expression in
 * `allow` does not. So a real boolean gives the same verdict on both sides, and anything that
 * throws or answers with a non-boolean disagrees with itself. That disagreement is the signal.
 */
function answersBoolean(expression: string, context: PolicyContext): boolean {
  const asDeny = evaluateActionPolicy(
    { mode: "enforce", deny: [expression], allow: [] },
    context,
  );
  const asAllow = evaluateActionPolicy(
    { mode: "enforce", deny: [], allow: [expression] },
    context,
  );
  return (asDeny.source === "deny") === (asAllow.source === "allow");
}

/**
 * Refuse anything that would not behave like a rule, before it is stored.
 *
 * A malformed clause in `template_boundaries` is not a bad rule, it is a Bot that cannot act at all:
 * the deny list fails closed on a throw, so a clause that throws refuses everything the Bot ever
 * tries, permanently, with an audit trail blaming a rule nobody can read. Catching it at write time
 * costs a few evaluations against a context nobody is waiting on, and the alternative is catching it
 * at the moment somebody's coworker stops working.
 *
 * Checked against every intent rather than one, because a clause is a conjunction and only some
 * intents reach its far end.
 */
export function refuseUnsafeClauses(clauses: CompiledClause[]): void {
  for (const clause of clauses) {
    for (const intent of NEUTRAL_INTENTS) {
      if (
        !answersBoolean(
          clause.expression,
          neutralContext(clause.agentId, intent),
        )
      ) {
        throw new BoundaryClauseRefusedError(
          clause.expression,
          `the compiled boundary clause for ${clause.sourceKey} did not evaluate to true or false, so it was refused rather than stored: a clause that cannot answer refuses every action this Bot ever attempts`,
        );
      }
    }
  }
}

/**
 * The author's ceiling, said in sentences rather than in the vocabulary's words.
 *
 * The authoritative copy of this wording, and it lives next to the compiler on purpose. The consent
 * screen and the administrator's Boundaries list are describing the same block, and two hand-kept
 * copies of "what this Bot may not do" drift — at which point somebody consented to one sentence and
 * an administrator is reading another, about the same Bot.
 *
 * It describes the ceiling rather than enumerating the clauses. The permissive end of a key emits no
 * clause at all, and a person deciding whether to trust a stranger's coworker still has to be told
 * that it may run shell commands. Saying nothing about shell because there was no rule to show would
 * be the most dangerous silence on the page.
 */
export function describeBoundary(boundary: BotTemplateBoundary): string[] {
  const sentences: string[] = [];
  sentences.push(
    boundary.shell === "never"
      ? "It may not run shell commands."
      : "It may run shell commands.",
  );
  sentences.push(
    boundary.files === "none"
      ? "It may not read or write files."
      : boundary.files === "read_only"
        ? "It may read files, and may not change them."
        : "It may read and write files.",
  );
  sentences.push(
    boundary.browser === "none"
      ? "It may not use a browser."
      : boundary.browser === "read_only"
        ? "It may look at web pages, and may not click, type or submit on them."
        : "It may use a browser fully: clicking, typing and submitting.",
  );
  /*
   * An empty `navigate_hosts` is the ABSENCE of a host limit rather than a limit of none. The format
   * documents it as adding no host clause at all, and this repo's own research-desk example ships
   * `browser: read_only` with no hosts on purpose. The sentence here used to read "The author named
   * no web address it may visit.", which a reviewer reads as the tightest ceiling the vocabulary can
   * express while it is in fact the loosest — in the section whose whole job is to state that ceiling
   * in plain English. Where no browser is permitted there is no host clause to make, so nothing is
   * said.
   */
  if (boundary.browser !== "none") {
    sentences.push(
      boundary.navigateHosts.length === 0
        ? "The author put no limit on which sites it may visit."
        : `On the web it is confined to ${boundary.navigateHosts.join(", ")}.`,
    );
  }
  sentences.push(
    boundary.mcp === "none"
      ? "It may not call connector tools."
      : boundary.mcp === "read_only"
        ? "It may call connector tools that read, and not ones that write."
        : "It may call connector tools that read and write.",
  );
  return sentences;
}
