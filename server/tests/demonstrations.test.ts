import { expect, test } from "bun:test";
import { draftDemonstration } from "../src/demonstrations/draft";
import { createDemonstrationRecorder } from "../src/demonstrations/recording";
import {
  demonstrationRoutineInstruction,
  parseDemonstrationSchedule,
} from "../src/demonstrations/schedule";
import type { DemonstrationStore } from "../src/demonstrations/store";
import {
  DEMONSTRATION_MAX_DURATION_MS,
  DemonstrationRefusedError,
  demonstrationExpiresAt,
  parseDemonstrationAction,
  reachedDemonstrationTimeLimit,
} from "../src/demonstrations/types";
import { RoutineRefusedError } from "../src/routines/store";

test("recorded actions reject typed secrets and unknown payload fields", () => {
  expect(() =>
    parseDemonstrationAction({
      kind: "type",
      url: "https://example.test/form",
      target: { role: "textbox", name: "Password", sensitive: true },
      text: "private-password",
    }),
  ).toThrow();
});
test("draft preserves ordered real actions and replaces input with parameters", () => {
  const draft = draftDemonstration({
    id: "recording",
    title: "Find invoice",
    actions: [
      {
        kind: "click",
        url: "https://example.test/invoices",
        target: { role: "textbox", name: "Search", sensitive: false },
      },
      {
        kind: "type",
        url: "https://example.test/invoices",
        target: { role: "textbox", name: "Search", sensitive: false },
      },
      {
        kind: "key",
        key: "Enter",
        url: "https://example.test/invoices",
        target: { role: "textbox", name: "Search", sensitive: false },
      },
    ],
  });
  expect(draft.instructions.indexOf("Click")).toBeLessThan(
    draft.instructions.indexOf("{{input_1}}"),
  );
  expect(draft.instructions).toContain("Enter");
  expect(draft.sourceRecordingId).toBe("recording");
  expect(draft.tools).toEqual([]);
  expect(draft.requiredTools).toContain("computer_type");
});
test("sensitive recorded input directs human handoff instead of retaining a value", () => {
  const draft = draftDemonstration({
    id: "r",
    title: "Sign in",
    actions: [
      {
        kind: "type",
        url: "https://example.test/login",
        target: { role: "textbox", name: "[sensitive field]", sensitive: true },
      },
    ],
  });
  expect(draft.instructions).toContain("ask the person");
  expect(draft.requiredTools).toContain("computer_request_help");
  expect(draft.instructions).not.toContain("{{input_1}}");
});
test("draft requires at least one completed human action", () => {
  expect(() =>
    draftDemonstration({ id: "r", title: "Empty", actions: [] }),
  ).toThrow();
});
test("stopping waits for already received human gestures before closing the recording", async () => {
  const row: Awaited<ReturnType<DemonstrationStore["get"]>> = {
    id: "r",
    ownerUserId: "owner",
    botId: "bot",
    title: "Workflow",
    status: "recording",
    actions: [],
    draft: null,
    skillSlug: null,
    createdAt: new Date(),
    finishedAt: null,
    expiresAt: new Date(Date.now() + 600_000),
    maxDurationMs: 600_000,
    reachedTimeLimit: false,
  };
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = createDemonstrationRecorder({
    ownsBot: async () => true,
    ownsSkill: async () => false,
    store: {
      get: async () => row,
      start: async () => row,
      markPublished: async () => row,
      append: async (_owner, _id, input) => {
        await blocked;
        if (row.status !== "recording")
          throw new Error(
            "Recording closed before its successful gesture was saved.",
          );
        row.actions.push(parseDemonstrationAction(input));
      },
      stop: async () => {
        row.status = "stopped";
        return row;
      },
    },
  });
  const action = {
    kind: "click",
    url: "https://example.test/",
    target: { role: "button", name: "Search", sensitive: false },
  };
  const captures = [
    recorder.capture("owner", "bot", "r", action),
    recorder.capture("owner", "bot", "r", action),
  ];
  const stop = recorder.stop("owner", "r");
  expect(row.status).toBe("recording");
  release?.();
  await Promise.all(captures);
  const stopped = await stop;
  expect(stopped.status).toBe("stopped");
  expect(stopped.actions).toHaveLength(2);
});

type Row = Awaited<ReturnType<DemonstrationStore["get"]>>;
const recordingRow = (overrides: Partial<Row> = {}): Row => ({
  id: "r",
  ownerUserId: "owner",
  botId: "bot",
  title: "Find invoice",
  status: "recording",
  actions: [],
  draft: null,
  skillSlug: null,
  createdAt: new Date(),
  finishedAt: null,
  expiresAt: new Date(Date.now() + DEMONSTRATION_MAX_DURATION_MS),
  maxDurationMs: DEMONSTRATION_MAX_DURATION_MS,
  reachedTimeLimit: false,
  ...overrides,
});
const fakeStore = (row: Row) => ({
  get: async () => row,
  start: async () => row,
  markPublished: async () => row,
  append: async () => {},
  stop: async () => {
    if (row.status === "recording") {
      row.status = "stopped";
      row.finishedAt = new Date();
    }
    return row;
  },
});

test("the recording limit is ten minutes and is reported from the row", () => {
  expect(DEMONSTRATION_MAX_DURATION_MS).toBe(600_000);
  const createdAt = new Date("2026-09-29T10:00:00Z");
  expect(demonstrationExpiresAt(createdAt).toISOString()).toBe(
    "2026-09-29T10:10:00.000Z",
  );
  expect(
    reachedDemonstrationTimeLimit({
      createdAt,
      finishedAt: new Date("2026-09-29T10:10:00Z"),
    }),
  ).toBe(true);
  expect(
    reachedDemonstrationTimeLimit({
      createdAt,
      finishedAt: new Date("2026-09-29T10:09:59Z"),
    }),
  ).toBe(false);
  expect(reachedDemonstrationTimeLimit({ createdAt, finishedAt: null })).toBe(
    false,
  );
});

test("the server stops a recording at its limit without anyone pressing stop", async () => {
  const row = recordingRow();
  const recorder = createDemonstrationRecorder({
    ownsBot: async () => true,
    ownsSkill: async () => false,
    store: fakeStore(row),
    maxDurationMs: 20,
  });
  await recorder.start("owner", "bot", "Find invoice");
  expect(row.status).toBe("recording");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(row.status).toBe("stopped");
});

test("stopping by hand cancels the time-limit stop", async () => {
  const row = recordingRow();
  let stops = 0;
  const store = fakeStore(row);
  const recorder = createDemonstrationRecorder({
    ownsBot: async () => true,
    ownsSkill: async () => false,
    store: {
      ...store,
      stop: async () => {
        stops += 1;
        return store.stop();
      },
    },
    maxDurationMs: 20,
  });
  await recorder.start("owner", "bot", "Find invoice");
  await recorder.stop("owner", "r");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(stops).toBe(1);
});

test("schedule input is bounded and refuses unknown fields or a missing schedule", () => {
  expect(
    parseDemonstrationSchedule({
      cron: " 0 9 * * 1-5 ",
      timezone: "Europe/London",
      inputs: "",
    }),
  ).toEqual({ cron: "0 9 * * 1-5", timezone: "Europe/London" });
  expect(() => parseDemonstrationSchedule({})).toThrow(
    DemonstrationRefusedError,
  );
  expect(() =>
    parseDemonstrationSchedule({ cron: "0 9 * * *", ownerUserId: "other" }),
  ).toThrow(DemonstrationRefusedError);
  expect(() =>
    parseDemonstrationSchedule({ cron: "0 9 * * *", inputs: "x".repeat(1001) }),
  ).toThrow(DemonstrationRefusedError);
});

test("the routine instruction names the saved skill and never invents inputs", () => {
  const asks = demonstrationRoutineInstruction({
    title: "Find invoice",
    slug: "find-invoice",
  });
  expect(asks).toContain("/find-invoice");
  expect(asks).toContain("ask the person rather than guessing");
  expect(
    demonstrationRoutineInstruction({
      title: "Find invoice",
      slug: "find-invoice",
      inputs: "invoice 42",
    }),
  ).toContain("Use these inputs: invoice 42");
});

test("scheduling creates a routine for the recording's own Bot through the routine store", async () => {
  const row = recordingRow({ status: "published", skillSlug: "find-invoice" });
  const created: unknown[] = [];
  const recorder = createDemonstrationRecorder({
    ownsBot: async () => true,
    ownsSkill: async (_owner, slug) => slug === "find-invoice",
    store: fakeStore(row),
    routines: {
      create: async (input) => {
        created.push(input);
        return {
          id: "routine_1",
          ownerUserId: input.ownerUserId,
          agentId: input.agentId,
          channelId: input.channelId ?? "channel_1",
          instruction: input.instruction,
          cron: input.cron,
          timezone: input.timezone ?? "UTC",
          enabled: true,
          nextRunAt: new Date("2026-09-30T09:00:00Z"),
          lastRunAt: null,
          createdAt: new Date(),
        };
      },
    },
  });
  const routine = await recorder.schedule("owner", "r", {
    cron: "0 9 * * 1-5",
  });
  expect(routine.id).toBe("routine_1");
  expect(created).toEqual([
    {
      ownerUserId: "owner",
      agentId: "bot",
      instruction: demonstrationRoutineInstruction({
        title: "Find invoice",
        slug: "find-invoice",
      }),
      cron: "0 9 * * 1-5",
      timezone: undefined,
      channelId: undefined,
    },
  ]);
});

test("scheduling refuses an unpublished demonstration and carries routine refusals through", async () => {
  const draft = recordingRow({ status: "drafted" });
  const refusing = {
    create: async () => {
      throw new RoutineRefusedError(
        "Routines may run at most every 15 minutes.",
      );
    },
  };
  const unpublished = createDemonstrationRecorder({
    ownsBot: async () => true,
    ownsSkill: async () => true,
    store: fakeStore(draft),
    routines: refusing,
  });
  await expect(
    unpublished.schedule("owner", "r", { cron: "0 9 * * *" }),
  ).rejects.toThrow("Save this demonstration as a skill");
  const published = createDemonstrationRecorder({
    ownsBot: async () => true,
    ownsSkill: async () => true,
    store: fakeStore(
      recordingRow({ status: "published", skillSlug: "find-invoice" }),
    ),
    routines: refusing,
  });
  await expect(
    published.schedule("owner", "r", { cron: "* * * * *" }),
  ).rejects.toThrow("at most every 15 minutes");
  const gone = createDemonstrationRecorder({
    ownsBot: async () => true,
    ownsSkill: async () => false,
    store: fakeStore(
      recordingRow({ status: "published", skillSlug: "find-invoice" }),
    ),
    routines: refusing,
  });
  await expect(
    gone.schedule("owner", "r", { cron: "0 9 * * *" }),
  ).rejects.toBeInstanceOf(DemonstrationRefusedError);
});
