import { describe, expect, test } from "bun:test";
import {
  type BotTemplateBoundary,
  STRICT_BOUNDARY,
} from "../../shared/bot-template";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../src/computer/policy";
import {
  BoundaryClauseRefusedError,
  type CompiledClause,
  compileBoundary,
  describeBoundary,
  refuseUnsafeClauses,
} from "../src/templates/boundary";

/**
 * These test what the clauses DO, not what they look like.
 *
 * A compiler that emits the agreed string and a policy engine that reads it differently is the
 * failure this file exists to catch, so most of the cases below hand the compiled clause to
 * `evaluateActionPolicy` — the same function the gateway calls — with the permissive `allow: ["true"]`
 * a fresh deployment actually ships. That configuration is the honest one to test in: it proves the
 * clause refuses on its own rather than being carried by a deny-by-default floor.
 *
 * Every case that asserts a refusal also asserts that a DIFFERENT Bot is untouched. A per-Bot ceiling
 * that leaks onto its neighbours is not a smaller version of the feature, it is an outage.
 */

const AGENT = "agent_11111111-1111-4111-8111-111111111111";
const OTHER = "agent_22222222-2222-4222-8222-222222222222";

function boundary(
  overrides: Partial<BotTemplateBoundary>,
): BotTemplateBoundary {
  return { ...STRICT_BOUNDARY, ...overrides };
}

const PERMISSIVE: BotTemplateBoundary = {
  shell: "permitted",
  files: "read_write",
  browser: "full",
  navigateHosts: [],
  mcp: "read_write",
};

/**
 * One key narrowed and every other key wide open.
 *
 * Built on the permissive end rather than on `STRICT_BOUNDARY` so that a case about `shell` produces
 * exactly one clause. Narrowing a strict base instead makes every assertion ambiguous: a refused read
 * would be evidence about the file ceiling, the browser ceiling or the key under test, and the test
 * would keep passing after the key under test stopped compiling at all.
 */
function only(overrides: Partial<BotTemplateBoundary>): BotTemplateBoundary {
  return { ...PERMISSIVE, ...overrides };
}

/**
 * A context with every field bound, as the gateway and the MCP path both build one.
 *
 * Bound rather than partial because an unbound identifier throws in cel-js and a throw in a deny list
 * counts as a match: a test using a half-built context would watch clauses "work" for the wrong
 * reason and would keep passing after the compiler stopped naming the right fields.
 */
function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: { name: "computer_click" },
    bot: { id: AGENT },
    actor: { id: "dev-local-user" },
    page: { url: "https://example.com/order", host: "example.com" },
    element: { ref: "e1", role: "button", name: "Submit order" },
    key: "",
    file: { path: "", name: "", extension: "" },
    command: "",
    mcp: { server: "", tool: "", effect: "" },
    intent: "read",
    ...overrides,
  };
}

/** The shipped default, plus one template's clauses. The configuration a real import lands in. */
function policyOf(clauses: CompiledClause[]): ActionPolicy {
  return {
    mode: "enforce",
    deny: clauses.map((clause) => clause.expression),
    allow: ["true"],
  };
}

function allows(clauses: CompiledClause[], ctx: PolicyContext): boolean {
  return evaluateActionPolicy(policyOf(clauses), ctx).allowed;
}

describe("compileBoundary", () => {
  test("the strictest vocabulary produces one clause per key it denies", () => {
    const clauses = compileBoundary(AGENT, STRICT_BOUNDARY);
    expect(clauses.map((clause) => clause.sourceKey)).toEqual([
      "shell",
      "files",
      "browser",
      "mcp",
    ]);
    for (const clause of clauses) {
      expect(clause.agentId).toBe(AGENT);
      expect(clause.expression.startsWith(`bot.id == "${AGENT}" && (`)).toBe(
        true,
      );
    }
  });

  test("the permissive end of every key emits nothing at all", () => {
    expect(compileBoundary(AGENT, PERMISSIVE)).toEqual([]);
  });

  test("each vocabulary value compiles to the intents it names", () => {
    const expressionFor = (
      value: Partial<BotTemplateBoundary>,
      sourceKey: string,
    ) => {
      const clause = compileBoundary(AGENT, only(value)).find(
        (candidate) => candidate.sourceKey === sourceKey,
      );
      return clause?.expression ?? "";
    };

    expect(expressionFor({ shell: "never" }, "shell")).toBe(
      `bot.id == "${AGENT}" && (intent == "run_command")`,
    );
    expect(expressionFor({ files: "none" }, "files")).toBe(
      `bot.id == "${AGENT}" && (intent == "read_file" || intent == "write_file" || intent == "list_files")`,
    );
    expect(expressionFor({ files: "read_only" }, "files")).toBe(
      `bot.id == "${AGENT}" && (intent == "write_file")`,
    );
    expect(expressionFor({ browser: "none" }, "browser")).toBe(
      `bot.id == "${AGENT}" && (intent == "activate" || intent == "type" || intent == "navigate" || intent == "read")`,
    );
    expect(expressionFor({ browser: "read_only" }, "browser")).toBe(
      `bot.id == "${AGENT}" && (intent == "activate" || intent == "type")`,
    );
    expect(expressionFor({ mcp: "none" }, "mcp")).toBe(
      `bot.id == "${AGENT}" && (intent == "read_tool" || intent == "write_tool")`,
    );
    expect(expressionFor({ mcp: "read_only" }, "mcp")).toBe(
      `bot.id == "${AGENT}" && (intent == "write_tool")`,
    );
    expect(
      expressionFor(
        { browser: "read_only", navigateHosts: ["a.example", "b.example"] },
        "navigate_hosts",
      ),
    ).toBe(
      `bot.id == "${AGENT}" && (intent == "navigate" && !(page.host == "a.example" || page.host == "b.example"))`,
    );
  });

  test("a host list compiles to equality and never to a pattern", () => {
    const clauses = compileBoundary(
      AGENT,
      only({
        browser: "read_only",
        navigateHosts: ["billing.acme.example", "docs.acme.example"],
      }),
    );
    const hostClause = clauses.find(
      (clause) => clause.sourceKey === "navigate_hosts",
    );
    expect(hostClause).toBeDefined();
    const expression = hostClause?.expression ?? "";
    // `matches` throws on an unparseable pattern and a throwing deny counts as a match, which would
    // refuse every action this clause is ever evaluated against rather than the navigation it names.
    expect(expression).not.toContain("matches");
    expect(expression).not.toContain("contains");
    expect(expression).toContain('page.host == "billing.acme.example"');
    expect(expression).toContain('page.host == "docs.acme.example"');
  });

  test("a value the emitter cannot write exactly is refused, not approximated", () => {
    // cel-js keeps escape sequences verbatim inside a string literal, so an escaped value would be a
    // clause that silently never matches what it names. Neither of these can reach the compiler
    // today — the parser validates hostnames and the agent id is minted here — and the emitter checks
    // anyway, because "the caller validated it" survives exactly until there is a second caller.
    expect(() =>
      compileBoundary(`${AGENT}" || true || "`, STRICT_BOUNDARY),
    ).toThrow(BoundaryClauseRefusedError);
    expect(() =>
      compileBoundary(
        AGENT,
        only({
          browser: "read_only",
          navigateHosts: ['a.example" || true || "'],
        }),
      ),
    ).toThrow(BoundaryClauseRefusedError);
  });

  test("a refused value names itself without being re-emitted raw", () => {
    try {
      compileBoundary(`${AGENT}"`, STRICT_BOUNDARY);
      throw new Error("the compiler accepted an unrepresentable agent id");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundaryClauseRefusedError);
      if (error instanceof BoundaryClauseRefusedError) {
        expect(error.expression).toBe(
          `bot.id == ${JSON.stringify(`${AGENT}"`)}`,
        );
      }
    }
  });
});

describe("refuseUnsafeClauses", () => {
  test("a clause that throws is refused rather than stored", () => {
    const clause: CompiledClause = {
      // `nosuchfield` is unbound, and cel-js throws on an unbound identifier. Stored, this clause
      // would refuse every action this Bot ever attempted.
      expression: `bot.id == "${AGENT}" && (nosuchfield == "x")`,
      sourceKey: "shell",
      agentId: AGENT,
    };
    expect(() => refuseUnsafeClauses([clause])).toThrow(
      BoundaryClauseRefusedError,
    );
  });

  test("a clause that answers with a string is refused", () => {
    const clause: CompiledClause = {
      // Valid CEL that parses and evaluates, and is not an answer to "does this rule apply".
      expression: `"run_command"`,
      sourceKey: "shell",
      agentId: AGENT,
    };
    expect(() => refuseUnsafeClauses([clause])).toThrow(
      BoundaryClauseRefusedError,
    );
  });

  test("a clause that only throws past its scope is still caught", () => {
    // The scope short-circuits, so a validator checking this against any other Bot would see the
    // first conjunct answer false and call the clause sound. The clause is checked against a context
    // for its own Bot for exactly this reason.
    const clause: CompiledClause = {
      expression: `bot.id == "${AGENT}" && (intent == "navigate" && !(page.nosuchfield == "x"))`,
      sourceKey: "navigate_hosts",
      agentId: AGENT,
    };
    expect(() =>
      refuseUnsafeClauses([{ ...clause, agentId: OTHER }]),
    ).not.toThrow();
    expect(() => refuseUnsafeClauses([clause])).toThrow(
      BoundaryClauseRefusedError,
    );
  });

  test("everything the compiler emits survives its own validation", () => {
    const clauses = compileBoundary(
      AGENT,
      boundary({
        shell: "never",
        files: "read_only",
        browser: "read_only",
        navigateHosts: ["billing.acme.example"],
        mcp: "read_only",
      }),
    );
    expect(clauses).toHaveLength(5);
    expect(() => refuseUnsafeClauses(clauses)).not.toThrow();
  });
});

describe("the compiled clauses, under the policy engine", () => {
  test("shell: never refuses a command from this Bot and not from another", () => {
    const clauses = compileBoundary(AGENT, only({ shell: "never" }));
    const shell = context({
      tool: { name: "computer_run_command" },
      intent: "run_command",
      command: "ls",
    });
    expect(allows(clauses, shell)).toBe(false);
    expect(allows(clauses, { ...shell, bot: { id: OTHER } })).toBe(true);
    // The same Bot doing something else is untouched: a ceiling subtracts one thing, not everything.
    expect(allows(clauses, context({ intent: "read" }))).toBe(true);
  });

  test("files: none refuses reading, writing and listing", () => {
    const clauses = compileBoundary(AGENT, only({ files: "none" }));
    for (const intent of ["read_file", "write_file", "list_files"] as const) {
      const ctx = context({
        intent,
        file: { path: "notes.md", name: "notes.md", extension: "md" },
      });
      expect(allows(clauses, ctx)).toBe(false);
      expect(allows(clauses, { ...ctx, bot: { id: OTHER } })).toBe(true);
    }
  });

  test("files: read_only refuses the write and permits the read", () => {
    const clauses = compileBoundary(AGENT, only({ files: "read_only" }));
    expect(allows(clauses, context({ intent: "write_file" }))).toBe(false);
    expect(allows(clauses, context({ intent: "read_file" }))).toBe(true);
    expect(allows(clauses, context({ intent: "list_files" }))).toBe(true);
    expect(
      allows(clauses, context({ intent: "write_file", bot: { id: OTHER } })),
    ).toBe(true);
  });

  test("browser: none refuses looking as well as acting", () => {
    const clauses = compileBoundary(AGENT, only({ browser: "none" }));
    for (const intent of ["activate", "type", "navigate", "read"] as const) {
      expect(allows(clauses, context({ intent }))).toBe(false);
      expect(allows(clauses, context({ intent, bot: { id: OTHER } }))).toBe(
        true,
      );
    }
  });

  test("browser: read_only refuses the gestures that change something", () => {
    const clauses = compileBoundary(AGENT, only({ browser: "read_only" }));
    expect(allows(clauses, context({ intent: "activate" }))).toBe(false);
    expect(allows(clauses, context({ intent: "type" }))).toBe(false);
    expect(allows(clauses, context({ intent: "read" }))).toBe(true);
    expect(allows(clauses, context({ intent: "navigate" }))).toBe(true);
  });

  test("a host list confines navigation to the hosts named, for this Bot only", () => {
    const clauses = compileBoundary(
      AGENT,
      only({
        browser: "read_only",
        navigateHosts: ["billing.acme.example", "docs.acme.example"],
      }),
    );
    const navigate = (host: string, botId = AGENT) =>
      context({
        tool: { name: "computer_navigate" },
        intent: "navigate",
        bot: { id: botId },
        page: { url: `https://${host}/`, host },
      });

    expect(allows(clauses, navigate("billing.acme.example"))).toBe(true);
    expect(allows(clauses, navigate("docs.acme.example"))).toBe(true);
    expect(allows(clauses, navigate("evil.example"))).toBe(false);
    // A near miss is a miss. Equality is the whole point: nothing here is a prefix or a suffix rule.
    expect(allows(clauses, navigate("billing.acme.example.evil.example"))).toBe(
      false,
    );
    expect(allows(clauses, navigate("sub.billing.acme.example"))).toBe(false);
    // `hostOf` is `URL.host`, which carries a non-default port. The listed host does not match it,
    // and being refused is the safe half of that mismatch.
    expect(allows(clauses, navigate("billing.acme.example:8443"))).toBe(false);
    // Another Bot navigates anywhere, including the host this template forbade.
    expect(allows(clauses, navigate("evil.example", OTHER))).toBe(true);
  });

  test("mcp: none refuses reading and writing tools", () => {
    const clauses = compileBoundary(AGENT, only({ mcp: "none" }));
    const call = (intent: "read_tool" | "write_tool", botId = AGENT) =>
      context({
        tool: { name: "mcp__jira__editJiraIssue" },
        bot: { id: botId },
        intent,
        mcp: {
          server: "jira",
          tool: "editJiraIssue",
          effect: intent === "write_tool" ? "write" : "read",
        },
      });
    expect(allows(clauses, call("read_tool"))).toBe(false);
    expect(allows(clauses, call("write_tool"))).toBe(false);
    expect(allows(clauses, call("write_tool", OTHER))).toBe(true);
  });

  test("mcp: read_only refuses the write and permits the read", () => {
    const clauses = compileBoundary(AGENT, only({ mcp: "read_only" }));
    expect(allows(clauses, context({ intent: "write_tool" }))).toBe(false);
    expect(allows(clauses, context({ intent: "read_tool" }))).toBe(true);
  });

  test("an action with no intent bound refuses this Bot and leaves the rest alone", () => {
    // `gateway.ts` spreads `intent` in only when `intentOf` recognised the tool, so a tool with no
    // mapping leaves the identifier unbound, every clause throws, and a throwing deny counts as a
    // match. That is the direction to fail in — and because the scope is the leading conjunct and
    // cel-js short-circuits, it fails that way for the named Bot rather than for the deployment.
    const clauses = compileBoundary(AGENT, STRICT_BOUNDARY);
    const unmapped: PolicyContext = {
      tool: { name: "computer_something_new" },
      bot: { id: AGENT },
      actor: { id: "dev-local-user" },
      page: { url: "https://example.com/", host: "example.com" },
    };
    expect(allows(clauses, unmapped)).toBe(false);
    expect(allows(clauses, { ...unmapped, bot: { id: OTHER } })).toBe(true);
  });

  test("a Bot with no ceiling is unaffected by another Bot's whole ceiling", () => {
    const clauses = compileBoundary(AGENT, STRICT_BOUNDARY);
    for (const intent of [
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
    ] as const) {
      expect(allows(clauses, context({ intent, bot: { id: OTHER } }))).toBe(
        true,
      );
    }
  });
});

describe("describeBoundary", () => {
  test("the strictest ceiling reads as a refusal of each capability", () => {
    expect(describeBoundary(STRICT_BOUNDARY)).toEqual([
      "It may not run shell commands.",
      "It may not read or write files.",
      "It may not use a browser.",
      "It may call connector tools that read, and not ones that write.",
    ]);
  });

  test("a permissive ceiling still says what the Bot may do", () => {
    // The permissive end emits no clause, and a person deciding whether to trust a stranger's
    // coworker still has to be told. Silence here would be the most dangerous line on the page.
    expect(describeBoundary(PERMISSIVE)).toEqual([
      "It may run shell commands.",
      "It may read and write files.",
      "It may use a browser fully: clicking, typing and submitting.",
      "The author put no limit on which sites it may visit.",
      "It may call connector tools that read and write.",
    ]);
  });

  test("a host list is named, and no host sentence is offered without a browser", () => {
    expect(
      describeBoundary(
        boundary({
          browser: "read_only",
          files: "read_only",
          navigateHosts: ["billing.acme.example", "docs.acme.example"],
        }),
      ),
    ).toEqual([
      "It may not run shell commands.",
      "It may read files, and may not change them.",
      "It may look at web pages, and may not click, type or submit on them.",
      "On the web it is confined to billing.acme.example, docs.acme.example.",
      "It may call connector tools that read, and not ones that write.",
    ]);
    expect(
      describeBoundary(boundary({ browser: "none", mcp: "none" })),
    ).toEqual([
      "It may not run shell commands.",
      "It may not read or write files.",
      "It may not use a browser.",
      "It may not call connector tools.",
    ]);
  });
});
