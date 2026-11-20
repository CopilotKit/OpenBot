import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { type AgentProfile, agentKeys } from "../src/lib/agents/queries";
import { authKeys } from "../src/lib/auth/queries";
import type { ActivityDetails } from "../src/lib/computers/activity";
import { setComputerStateMutationOptions } from "../src/lib/computers/mutations";

/**
 * Wiping a computer forgets what ran on it, and a reload or another tab does not bring it back.
 *
 * The wipe was kept only in the page's memory. The conversation still holds every call the deleted
 * machine ran, and a page opened afresh reads the conversation again, so after a reload, or in a tab
 * opened after the wipe, every command from the deleted machine was back in the Activity pane. That
 * is the promise `clearActivity` makes, broken by pressing F5.
 *
 * Each "page" here is the real module, loaded fresh, in one browser: what a reload or a second tab
 * is. Only what the browser keeps between them (`localStorage`) carries over.
 */

type ActivityModule = typeof import("../src/lib/computers/activity");

let pages = 0;
/** The Activity module as a newly opened page has it: nothing in memory, the browser's storage as it is. */
async function openPage(): Promise<ActivityModule> {
  pages += 1;
  return (await import(
    `../src/lib/computers/activity.ts?page=${pages}`
  )) as ActivityModule;
}

/** A command that ran, as the pane reads one. */
function ran(command: string): ActivityDetails {
  return {
    kind: "command",
    subject: command,
    output: `${command}\n`,
    exitCode: 0,
  };
}

/** A conversation's computer calls, in the order they ran, each answered. */
function conversation(...commands: [string, string][]) {
  return commands.map(([id, command]) => ({ id, did: ran(command) }));
}

const BOT = "wiped-bot";

const realFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1/" });
});
afterEach(() => {
  window.localStorage.clear();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

/**
 * Admin, Computers, Reset, Reset it: the real mutation, from a page that has opened no conversation.
 * The computer answers the reset with a 200, as the fleet route does.
 */
async function resetFromAdmin(target: { computer: string; botId?: string }) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ cleared: true }), {
      status: 200,
    })) as unknown as typeof fetch;
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "dev-local-user",
    email: "dev@openbot.local",
    role: "admin",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: ADMIN_BOT, isolated: false, isolationActive: false } as AgentProfile,
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const options = setComputerStateMutationOptions(queryClient);
  const variables = { action: "reset" as const, ...target };
  await options.mutationFn?.(variables, {
    client: queryClient,
    meta: undefined,
  });
  await options.onSuccess?.(
    undefined as never,
    variables,
    undefined as never,
    undefined as never,
  );
}
/** A Bot no page in this file has read a conversation of, as Admin has read none. */
let adminBots = 0;
let ADMIN_BOT = "";

test("after a reload, what the wiped computer ran stays gone and what runs next still shows", async () => {
  const before = conversation(["w-1", "uname -a"], ["w-2", "rm -rf build"]);
  const first = await openPage();
  first.recordActivity(BOT, before);
  expect(first.activityFor(BOT)).toHaveLength(2);
  first.clearActivity(BOT);
  expect(first.activityFor(BOT)).toEqual([]);

  // Reloaded: the conversation is read again, from the start.
  const reloaded = await openPage();
  reloaded.recordActivity(BOT, before);
  expect(reloaded.activityFor(BOT)).toEqual([]);

  // What the Bot does on the new computer still appears.
  reloaded.recordActivity(BOT, [...before, ...conversation(["w-3", "pwd"])]);
  expect(reloaded.activityFor(BOT).map((entry) => entry.subject)).toEqual([
    "pwd",
  ]);

  // And a tab opened after that sees the same.
  const another = await openPage();
  another.recordActivity(BOT, [...before, ...conversation(["w-3", "pwd"])]);
  expect(another.activityFor(BOT).map((entry) => entry.subject)).toEqual([
    "pwd",
  ]);
});

test("history the wiping page had not read yet is from before the wipe too", async () => {
  // A conversation opens on its latest turns, and its stored history merges in ahead of them later.
  const first = await openPage();
  first.recordActivity(BOT, conversation(["h-3", "make"]));
  first.clearActivity(BOT);

  // Reloaded, the whole conversation is read: everything up to the wiped call ran on the wiped machine.
  const reloaded = await openPage();
  reloaded.recordActivity(
    BOT,
    conversation(
      ["h-1", "git clone repo"],
      ["h-2", "cd repo"],
      ["h-3", "make"],
      ["h-4", "ls"],
    ),
  );
  expect(reloaded.activityFor(BOT).map((entry) => entry.subject)).toEqual([
    "ls",
  ]);
});

test("a tab already open drops what another tab wiped", async () => {
  const calls = conversation(["t-1", "df -h"]);
  const open = await openPage();
  open.recordActivity(BOT, calls);
  const wiping = await openPage();
  wiping.recordActivity(BOT, calls);

  wiping.clearActivity(BOT);
  // The browser tells every other page on the origin that storage changed, as this event.
  const key = "openbot:computer-activity-wiped:wiped-bot";
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: window.localStorage.getItem(key),
    }),
  );

  expect(open.activityFor(BOT)).toEqual([]);
  // Still read again on every change, and still gone.
  open.recordActivity(BOT, calls);
  expect(open.activityFor(BOT)).toEqual([]);
});

test("another computer's history is not touched by the wipe", async () => {
  const first = await openPage();
  first.recordActivity(BOT, conversation(["o-1", "ls"]));
  first.recordActivity("other-bot", conversation(["o-2", "ls"]));
  first.clearActivity(BOT);

  const reloaded = await openPage();
  reloaded.recordActivity("other-bot", conversation(["o-2", "ls"]));
  expect(reloaded.activityFor("other-bot")).toHaveLength(1);
});

for (const [row, target] of [
  [
    "one Bot's seat, as a shared computer lists it",
    () => ({ computer: "person:dev-local-user", botId: ADMIN_BOT }),
  ],
  [
    "the person's whole computer",
    () => ({ computer: "person:dev-local-user" }),
  ],
] as const)
  test(`a reset of ${row} from Admin, which read none of the conversation, keeps what ran gone after every reload`, async () => {
    adminBots += 1;
    ADMIN_BOT = `admin-reset-bot-${adminBots}`;
    const history = conversation(
      [`${ADMIN_BOT}-1`, "uname -a"],
      [`${ADMIN_BOT}-2`, "date"],
    );
    // The conversation is open in a tab of its own while Admin resets the computer.
    const open = await openPage();
    open.recordActivity(ADMIN_BOT, history);
    expect(open.activityFor(ADMIN_BOT)).toHaveLength(2);

    // Admin had nothing in memory to wipe. It kept nothing, and a reload brought every command back.
    await resetFromAdmin(target());
    const key = `openbot:computer-activity-wiped:${ADMIN_BOT}`;
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: window.localStorage.getItem(key),
      }),
    );
    expect(open.activityFor(ADMIN_BOT)).toEqual([]);

    const reloaded = await openPage();
    reloaded.recordActivity(ADMIN_BOT, history);
    expect(reloaded.activityFor(ADMIN_BOT)).toEqual([]);

    // The next command, watched as it runs on the new computer, appears with when it ran.
    const next = `${ADMIN_BOT}-3`;
    reloaded.noteWatched(next);
    reloaded.recordActivity(ADMIN_BOT, [...history, { id: next, did: null }]);
    reloaded.recordActivity(ADMIN_BOT, [
      ...history,
      ...conversation([next, "pwd"]),
    ]);
    expect(
      reloaded.activityFor(ADMIN_BOT).map((entry) => entry.subject),
    ).toEqual(["pwd"]);
    expect(reloaded.activityFor(ADMIN_BOT)[0]?.at).toBeNumber();

    // Reloaded again, and again: only what ran after the reset, and no time the page cannot know.
    for (let reload = 0; reload < 2; reload += 1) {
      const again = await openPage();
      again.recordActivity(ADMIN_BOT, [
        ...history,
        ...conversation([next, "pwd"]),
      ]);
      expect(
        again.activityFor(ADMIN_BOT).map((entry) => entry.subject),
      ).toEqual(["pwd"]);
      // Read off the entry itself, so a missing entry fails here instead of passing as no time.
      const [entry] = again.activityFor(ADMIN_BOT);
      if (!entry) throw new Error("The command after the wipe was not listed.");
      expect(entry.at).toBeUndefined();
    }
  });
