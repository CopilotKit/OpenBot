import { afterEach, describe, expect, test } from "bun:test";
import {
  callTool,
  listTools,
  type RoutineTools,
  useRoutineTools,
} from "../src/plugins/builtin-routines";
import {
  type Routine,
  RoutineNotFoundError,
  type RoutinePatch,
  RoutineRefusedError,
  type RoutineSummary,
} from "../src/routines/store";

/**
 * The builtin Routines transport, asserted without a database.
 *
 * What is under test is the boundary, not the store: which method a tool name reaches, whose id the
 * call is attributed to, and what a refusal reads as. A recording stub is installed through
 * {@link useRoutineTools}, which is the only seam the module has — `transportFor` resolves a kind to
 * a MODULE, so there is no constructor to pass a store to.
 *
 * The security property this file exists for is the attribution one: the owner comes from the
 * connection's actor and the Bot from the connection's Bot, never from the arguments a model
 * produced. A model that could name an owner could schedule work as somebody else.
 */

const CONNECTION = {
  url: "builtin://routines/",
  actorId: "user_asker",
  botId: "bot_helper",
};

const ROUTINE: Routine = {
  id: "routine_1",
  ownerUserId: "user_asker",
  agentId: "bot_helper",
  channelId: "channel_1",
  instruction: "Post the standup summary.",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Madrid",
  enabled: true,
  nextRunAt: new Date("2026-01-05T08:00:00.000Z"),
  lastRunAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const SUMMARY: RoutineSummary = {
  id: "routine_1",
  agentId: "bot_helper",
  instruction: "Post the standup summary.",
  schedule: "Weekdays at 09:00",
  timezone: "Europe/Madrid",
  enabled: true,
  nextRunAt: new Date("2026-01-05T08:00:00.000Z"),
  channelId: "channel_1",
  channelName: "Standup",
  channelDeleted: false,
  lastRun: {
    status: "succeeded",
    finishedAt: new Date("2026-01-02T08:00:03.000Z"),
  },
};

type Recorded =
  | { method: "create"; input: Parameters<RoutineTools["create"]>[0] }
  | { method: "listFor"; ownerUserId: string }
  | {
      method: "update";
      ownerUserId: string;
      id: string;
      patch: RoutinePatch;
    }
  | { method: "remove"; ownerUserId: string; id: string };

/** Installs a stub that records every call, and answers with the fixtures above. */
function recordingTools(overrides: Partial<RoutineTools> = {}): Recorded[] {
  const calls: Recorded[] = [];
  useRoutineTools({
    async create(input) {
      calls.push({ method: "create", input });
      return ROUTINE;
    },
    async listFor(ownerUserId) {
      calls.push({ method: "listFor", ownerUserId });
      return [SUMMARY];
    },
    async update(ownerUserId, id, patch) {
      calls.push({ method: "update", ownerUserId, id, patch });
      return ROUTINE;
    },
    async remove(ownerUserId, id) {
      calls.push({ method: "remove", ownerUserId, id });
    },
    ...overrides,
  });
  return calls;
}

// The binding is module-level and the suite is one process, so a stub left installed here would be
// the store some other file's test unexpectedly reaches.
afterEach(() => {
  useRoutineTools(null);
});

describe("the tool list", () => {
  test("is the four routine tools, named exactly", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "create_routine",
      "list_routines",
      "update_routine",
      "delete_routine",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("carries the cron contract in create_routine's description", async () => {
    const tools = await listTools();
    const create = tools.find((tool) => tool.name === "create_routine");
    expect(create).toBeDefined();
    const description = create?.description ?? "";
    expect(description).toContain("15");
    expect(description).toContain("timezone");
    expect(description).toContain("minute hour day-of-month month day-of-week");
    expect(description).toContain("0 9 * * 1-5");
  });

  test("tells the model how to phrase the instruction itself", async () => {
    // A live firing did nothing and reported success because its instruction was written in
    // schedule-speak ("Every run, append …"): the model read it as a question about scheduling,
    // checked that the routine existed, and answered "already configured". The firing turn now says
    // it is a firing (`routines/run-turn.ts`), and this is the other half — the authoring side, so
    // the instruction is written as work in the first place.
    const tools = await listTools();
    const create = tools.find((tool) => tool.name === "create_routine");
    const description = create?.description ?? "";
    expect(description).toContain("restate the schedule");

    const update = tools.find((tool) => tool.name === "update_routine");
    expect(update?.description ?? "").toContain("restate the schedule");
  });

  test("needs no actor, no arguments and no store", async () => {
    // The only call site is `refreshTools`, which passes `{url, token}` and never an actor. A list
    // that refused without one would store zero tools and Routines would advertise nothing.
    useRoutineTools(null);
    const tools = await listTools();
    expect(tools).toHaveLength(4);
  });
});

describe("dispatch", () => {
  test("create_routine reaches create, attributed to the connection", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "create_routine", {
      instruction: "Post the standup summary.",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Madrid",
      channelId: "channel_1",
    });

    expect(result.isError).toBe(false);
    const created = calls.find((call) => call.method === "create");
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      method: "create",
      input: {
        ownerUserId: "user_asker",
        agentId: "bot_helper",
        channelId: "channel_1",
        instruction: "Post the standup summary.",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Madrid",
      },
    });
  });

  test("create_routine answers in words, not in cron", async () => {
    recordingTools();
    const result = await callTool(CONNECTION, "create_routine", {
      instruction: "Post the standup summary.",
      cron: "0 9 * * 1-5",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Weekdays at 09:00");
    expect(result.text).toContain("Europe/Madrid");
    expect(result.text).toContain("Standup");
    expect(result.text).toContain("routine_1");
    expect(result.text).not.toContain("0 9 * * 1-5");
  });

  test("create_routine without a timezone passes none, inventing nothing", async () => {
    const calls = recordingTools();
    await callTool(CONNECTION, "create_routine", {
      instruction: "Post the standup summary.",
      cron: "0 9 * * 1-5",
    });

    const created = calls.find((call) => call.method === "create");
    // The STORE owns the UTC default. A zone guessed here would be a zone nobody chose.
    expect(created?.method === "create" && created.input.timezone).toBe(
      undefined,
    );
  });

  test("list_routines reaches listFor, and renders id, words, channel and last run", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "list_routines", {});

    expect(result.isError).toBe(false);
    expect(calls).toContainEqual({
      method: "listFor",
      ownerUserId: "user_asker",
    });
    expect(result.text).toContain("routine_1");
    expect(result.text).toContain("Weekdays at 09:00");
    expect(result.text).toContain("Standup");
    expect(result.text).toContain("succeeded");
  });

  test("update_routine reaches update with only the fields given", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "update_routine", {
      id: "routine_1",
      cron: "30 18 * * *",
      enabled: false,
    });

    expect(result.isError).toBe(false);
    expect(calls).toContainEqual({
      method: "update",
      ownerUserId: "user_asker",
      id: "routine_1",
      patch: { cron: "30 18 * * *", enabled: false },
    });
  });

  test("delete_routine reaches remove", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "delete_routine", {
      id: "routine_1",
    });

    expect(result.isError).toBe(false);
    expect(calls).toContainEqual({
      method: "remove",
      ownerUserId: "user_asker",
      id: "routine_1",
    });
  });

  test("an unknown tool refuses without touching the store", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "pause_routine", {
      id: "routine_1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("pause_routine");
    expect(calls).toHaveLength(0);
  });
});

describe("attribution", () => {
  test("an owner named in the arguments is ignored", async () => {
    const calls = recordingTools();
    await callTool(CONNECTION, "create_routine", {
      ownerUserId: "someone-else",
      agentId: "another-bot",
      instruction: "Post the standup summary.",
      cron: "0 9 * * 1-5",
    });

    const created = calls.find((call) => call.method === "create");
    expect(created?.method === "create" && created.input.ownerUserId).toBe(
      "user_asker",
    );
    expect(created?.method === "create" && created.input.agentId).toBe(
      "bot_helper",
    );
  });

  test("an owner named in the arguments is ignored by list, update and delete", async () => {
    const calls = recordingTools();
    const spoofed = { ownerUserId: "someone-else", agentId: "another-bot" };
    await callTool(CONNECTION, "list_routines", { ...spoofed });
    await callTool(CONNECTION, "update_routine", {
      ...spoofed,
      id: "routine_1",
      instruction: "Something else.",
    });
    await callTool(CONNECTION, "delete_routine", {
      ...spoofed,
      id: "routine_1",
    });

    for (const call of calls) {
      expect(call).toMatchObject({ ownerUserId: "user_asker" });
    }
  });

  test("a run attributed to nobody is refused", async () => {
    const calls = recordingTools();
    const result = await callTool(
      { url: CONNECTION.url, botId: "bot_helper" },
      "list_routines",
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "A routine belongs to somebody, and this run is not attributed to anybody.",
    );
    expect(calls).toHaveLength(0);
  });

  test("an empty actor is not an actor", async () => {
    const calls = recordingTools();
    const result = await callTool(
      { url: CONNECTION.url, actorId: "   ", botId: "bot_helper" },
      "list_routines",
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "A routine belongs to somebody, and this run is not attributed to anybody.",
    );
    expect(calls).toHaveLength(0);
  });

  test("a run that names no Bot is refused", async () => {
    const calls = recordingTools();
    const result = await callTool(
      { url: CONNECTION.url, actorId: "user_asker" },
      "create_routine",
      { instruction: "Post it.", cron: "0 9 * * 1-5" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "A routine runs as a Bot, and this run does not name one.",
    );
    expect(calls).toHaveLength(0);
  });

  test("a deployment with no routine store refuses", async () => {
    useRoutineTools(null);
    const result = await callTool(CONNECTION, "list_routines", {});

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Routines is not available in this deployment.");
  });
});

describe("a write that landed but could not be read back", () => {
  test("create: a listFor that throws after a successful write is not reported as a failure", async () => {
    recordingTools({
      async listFor() {
        throw new Error("connection reset");
      },
    });

    const result = await callTool(CONNECTION, "create_routine", {
      instruction: "Post the standup summary.",
      cron: "0 9 * * 1-5",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("That routine is set. Its id is routine_1.");
  });

  test("update: a listFor that throws after a successful write is not reported as a failure", async () => {
    recordingTools({
      async listFor() {
        throw new Error("connection reset");
      },
    });

    const result = await callTool(CONNECTION, "update_routine", {
      id: "routine_1",
      instruction: "Something else.",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("That routine is updated. Its id is routine_1.");
  });

  test("create: the vanished-routine fallback reads as a sentence and names the id", async () => {
    recordingTools({
      async listFor() {
        return [];
      },
    });

    const result = await callTool(CONNECTION, "create_routine", {
      instruction: "Post the standup summary.",
      cron: "0 9 * * 1-5",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("That routine is set. Its id is routine_1.");
  });

  test("update: the vanished-routine fallback reads as a sentence and names the id", async () => {
    recordingTools({
      async listFor() {
        return [];
      },
    });

    const result = await callTool(CONNECTION, "update_routine", {
      id: "routine_1",
      instruction: "Something else.",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("That routine is updated. Its id is routine_1.");
  });

  test("the confirmation read is attributed to the connection's actor, not the routine's owner", async () => {
    const calls = recordingTools();
    await callTool(CONNECTION, "create_routine", {
      instruction: "Post the standup summary.",
      cron: "0 9 * * 1-5",
    });

    const reads = calls.filter((call) => call.method === "listFor");
    expect(reads).toContainEqual({
      method: "listFor",
      ownerUserId: "user_asker",
    });
  });
});

describe("a disabled routine's rendered next-run", () => {
  test('omits an ISO timestamp after "next" and keeps the switched-off wording', async () => {
    recordingTools({
      async listFor() {
        return [{ ...SUMMARY, enabled: false }];
      },
    });

    const result = await callTool(CONNECTION, "list_routines", {});

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(SUMMARY.nextRunAt.toISOString());
    expect(result.text).toContain("switched off");
    expect(result.text).toMatch(/next when switched back on/);
  });
});

describe("beyond-spec validation refusals", () => {
  test("create_routine without an instruction refuses without touching the store", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "create_routine", {
      cron: "0 9 * * 1-5",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("A routine needs an instruction to carry out.");
    expect(calls).toHaveLength(0);
  });

  test("create_routine without a cron refuses without touching the store", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "create_routine", {
      instruction: "Post it.",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "A routine needs a schedule: five cron fields, `minute hour day-of-month month day-of-week`.",
    );
    expect(calls).toHaveLength(0);
  });

  test("update_routine without an id refuses without touching the store", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "update_routine", {
      instruction: "Something else.",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Say which routine to change, by the id from list_routines.",
    );
    expect(calls).toHaveLength(0);
  });

  test("update_routine with an empty patch refuses without touching the store", async () => {
    const calls = recordingTools();
    const result = await callTool(CONNECTION, "update_routine", {
      id: "routine_1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Say what to change about that routine.");
    expect(calls).toHaveLength(0);
  });
});

describe("what the store said", () => {
  test("a refusal is carried through verbatim", async () => {
    recordingTools({
      async create() {
        throw new RoutineRefusedError(
          "Routines may run at most every 15 minutes.",
        );
      },
    });

    const result = await callTool(CONNECTION, "create_routine", {
      instruction: "Post it.",
      cron: "* * * * *",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Routines may run at most every 15 minutes.");
  });

  test("a missing routine is a sentence about ownership", async () => {
    recordingTools({
      async remove() {
        throw new RoutineNotFoundError();
      },
    });

    const result = await callTool(CONNECTION, "delete_routine", {
      id: "routine_nope",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("There is no routine of yours with that id.");
  });

  test("anything else is capped in code points and never escapes", async () => {
    recordingTools({
      async listFor() {
        throw new Error(`${"é".repeat(600)}!`);
      },
    });

    const result = await callTool(CONNECTION, "list_routines", {});

    expect(result.isError).toBe(true);
    expect(Array.from(result.text)).toHaveLength(400);
    expect(result.text).toBe("é".repeat(400));
  });
});
