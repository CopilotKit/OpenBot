import { describe, expect, test } from "bun:test";
import {
  ComputerUnavailableError,
  StaleSnapshotError,
} from "../src/computer/client";
import {
  ActionRefusedError,
  type ComputerGateway,
} from "../src/computer/gateway";
import { computerTools } from "../src/computer/tools";

/**
 * What the server-side computer tools must guarantee.
 *
 * These moved out of the browser, and the properties worth testing are the ones a green typecheck
 * cannot see:
 *  - the actor and the Bot reach the gateway, because the audit row is written from them
 *  - a refusal comes back as an ANSWER carrying the rule, not as a thrown error that ends the run
 *  - the failure modes stay distinguishable, because a model handed one sentence for all of them
 *    retries the identical call until its step cap
 *  - arguments a model got wrong are refused here, with a sentence the model can correct itself from
 */

const ACTOR = { id: "user-1", userId: "user-1" };
const BOT = "bot-1";

type Call = { method: string; botId: string; actor: unknown; input: unknown };

/** A gateway that records what reached it, and can be told to fail one way or another. */
function fakeGateway(fail?: unknown) {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (botId: string, actor: unknown, input: unknown) => {
      calls.push({ method, botId, actor, input });
      if (fail) throw fail;
      return { did: method };
    };

  const gateway = {
    navigate: (botId: string, actor: unknown, url: string) =>
      record("navigate")(botId, actor, { url }),
    click: record("click"),
    type: record("type"),
    key: record("key"),
    scroll: record("scroll"),
    readFile: record("readFile"),
    listFiles: record("listFiles"),
    writeFile: record("writeFile"),
    runCommand: record("runCommand"),
    read: async (botId: string) => {
      calls.push({ method: "read", botId, actor: null, input: null });
      if (fail) throw fail;
      return { title: "A page" };
    },
    snapshot: async (botId: string) => {
      calls.push({ method: "snapshot", botId, actor: null, input: null });
      if (fail) throw fail;
      return { snapshotId: 3 };
    },
  } as unknown as ComputerGateway;

  return { gateway, calls };
}

const toolsFor = (gateway: ComputerGateway, extra?: Record<string, unknown>) =>
  new Map(
    computerTools({ gateway, botId: BOT, actor: ACTOR, ...extra }).map(
      (tool) => [tool.name, tool],
    ),
  );

const parse = (raw: string) => JSON.parse(raw) as Record<string, unknown>;

describe("the computer tools, executed here", () => {
  test("every acting tool goes through the gateway, carrying the Bot and the actor", async () => {
    const { gateway, calls } = fakeGateway();
    const tools = toolsFor(gateway);

    await tools.get("computer_run_command")?.execute({ command: "ls" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("runCommand");
    expect(calls[0]?.botId).toBe(BOT);
    // The audit row is written from this. A tool that dropped it would leave an unattributed trail.
    expect(calls[0]?.actor).toEqual(ACTOR);
    expect(calls[0]?.input).toEqual({ command: "ls" });
  });

  test("a refusal is an answer carrying the rule, not a thrown error", async () => {
    const { gateway } = fakeGateway(
      new ActionRefusedError("No shell on this deployment.", "no-shell"),
    );
    const tools = toolsFor(gateway);

    const outcome = parse(
      (await tools.get("computer_run_command")?.execute({ command: "ls" })) ??
        "{}",
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toBe(true);
    // The rule's own words. "The agent declined" is the sentence this product exists to replace.
    expect(outcome.reason).toBe("No shell on this deployment.");
    expect(outcome.rule).toBe("no-shell");
  });

  test("the failure modes stay apart, so a model can tell a retry from a dead end", async () => {
    const stale = parse(
      (await toolsFor(fakeGateway(new StaleSnapshotError("gone")).gateway)
        .get("computer_click")
        ?.execute({ ref: "e1", snapshotId: 1 })) ?? "{}",
    );
    expect(stale.stale).toBe(true);
    expect(String(stale.reason)).toContain("computer_snapshot");

    const gone = parse(
      (await toolsFor(fakeGateway(new ComputerUnavailableError("off")).gateway)
        .get("computer_read")
        ?.execute({})) ?? "{}",
    );
    expect(gone.unavailable).toBe(true);
    expect(gone.stale).toBeUndefined();
  });

  test("arguments a model got wrong are refused before the gateway is touched", async () => {
    const { gateway, calls } = fakeGateway();
    const tools = toolsFor(gateway);

    const outcome = parse(
      // snapshotId as a string is a thing models do, and the gateway would refuse it much deeper.
      (await tools
        .get("computer_click")
        ?.execute({ ref: "e1", snapshotId: "1" })) ?? "{}",
    );

    expect(outcome.ok).toBe(false);
    expect(String(outcome.reason)).toContain("computer_click");
    expect(calls).toHaveLength(0);
  });

  test("optional arguments are omitted rather than sent as undefined", async () => {
    const { gateway, calls } = fakeGateway();
    const tools = toolsFor(gateway);

    await tools.get("computer_key")?.execute({ key: "Enter" });

    // `exactOptionalPropertyTypes` is on in this codebase, and a literal `undefined` on the wire is
    // a different thing from an absent field to the computer reading it.
    expect(calls[0]?.input).toEqual({ key: "Enter" });
  });

  test("report_refusal records, and still answers when nothing is recording", async () => {
    const recorded: unknown[] = [];
    const { gateway } = fakeGateway();

    const withStore = toolsFor(gateway, {
      recordRefusal: async (input: unknown) => {
        recorded.push(input);
      },
    });
    const answered = parse(
      (await withStore
        .get("report_refusal")
        ?.execute({ reason: "It looked unsafe.", request: "delete prod" })) ??
        "{}",
    );
    expect(answered.ok).toBe(true);
    expect(recorded).toHaveLength(1);

    // A deployment with no audit store must not lose the Bot's ability to say it declined.
    const without = toolsFor(gateway);
    const still = parse(
      (await without.get("report_refusal")?.execute({ reason: "No." })) ?? "{}",
    );
    expect(still.ok).toBe(true);
  });

  test("the two tools that need a person present are not offered here", async () => {
    const names = new Set(toolsFor(fakeGateway().gateway).keys());
    // Both end with somebody typing into a masked box or taking the wheel. Offering them to a run
    // with nobody watching would be offering a call that can never be answered.
    expect(names.has("computer_request_secret")).toBe(false);
    expect(names.has("computer_request_help")).toBe(false);
    expect(names.has("computer_run_command")).toBe(true);
  });
});
