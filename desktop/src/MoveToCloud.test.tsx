import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/*
 * The move to OpenBot Cloud as the setup window runs it, through the whole window (`App`): the
 * shell is scripted at `invoke` and `listen`, as it answers a person who updated OpenBot
 * (Self-Contained) to this version, or one connected to an OpenBot elsewhere.
 */

type Answer = unknown | ((args: unknown) => unknown);
let answers: Record<string, Answer> = {};
let calls: Array<{ command: string; args?: unknown }> = [];
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    calls.push({ command, args });
    if (command in answers) {
      const answer = answers[command];
      return typeof answer === "function" ? answer(args) : answer;
    }
    return null;
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    listener: (event: { payload: unknown }) => void,
  ) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)?.add(listener);
    return () => listeners.get(name)?.delete(listener);
  },
}));

mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
  ButtonMark: () => null,
  MarkImage: ({ id, name }: { id: string; name: string }) => (
    <img alt={name} data-mark={id} />
  ),
}));

const { App } = await import("./App");
const { countLines, formatSpace, reconnectPage } = await import(
  "./MoveToCloud"
);

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

let before: string | undefined;
beforeEach(() => {
  before = process.env.VITE_OPENBOT_CLOUD_ENABLED;
  process.env.VITE_OPENBOT_CLOUD_ENABLED = "true";
});
afterEach(() => {
  cleanup();
  if (before === undefined) delete process.env.VITE_OPENBOT_CLOUD_ENABLED;
  else process.env.VITE_OPENBOT_CLOUD_ENABLED = before;
  answers = {};
  calls = [];
  listeners.clear();
  localStorage.clear();
});

const GB = 18_400_000_000;

/** OpenBot (Self-Contained), set up and already running when the window opens. */
function selfContainedRunning(offer: {
  due: boolean;
  fromSettings?: boolean;
}): void {
  answers = {
    connection: { mode: "local", address: null, signedIn: false },
    default_root: "/Users/you/OpenBot",
    already_configured: {
      values: {},
      saved: {
        modelApiKeys: { openai: true, anthropic: false },
        modelSessions: { openai: false, anthropic: false },
        model: "open-ai-api-key",
      },
      launch: { harness: { id: "langgraph-ts" } },
      localEval: {
        stack: "local-abc123",
        ownership: "created",
        phase: "installed",
        connected: true,
      },
    },
    take_ai_connection_change: false,
    already_running: true,
    move_offer: {
      due: offer.due,
      fromSettings: offer.fromSettings ?? false,
      footprintBytes: GB,
    },
  };
}

const APPS = [
  {
    appId: "gmail",
    appName: "Gmail",
    accountLabel: "sam@example.com",
    botNames: ["Inbox helper"],
  },
  { appId: "slack", appName: "Slack" },
  { appId: "google-drive", appName: "Google Drive" },
];

const PREVIEW = {
  counts: [
    { kind: "bots", count: 3 },
    { kind: "conversations", count: 42 },
    { kind: "messages", count: 2814 },
    { kind: "memories", count: 52 },
    { kind: "skills", count: 9 },
    { kind: "routines", count: 1 },
    { kind: "goals", count: 0 },
    { kind: "files", count: 64 },
    { kind: "settings", count: 1 },
    { kind: "model-keys", count: 1 },
  ],
  apps: APPS,
  footprintBytes: GB,
  modelKeysAvailable: true,
};

const MOVED = {
  removedBytes: GB,
  diskGainedBytes: GB - 200_000_000,
  apps: APPS,
  notes: [
    "Research runs on an ordinary computer here, because OpenBot Cloud has no isolated computers.",
  ],
  leftBehind: [],
};

async function launch() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  return view;
}

function called(command: string) {
  return calls.filter((call) => call.command === command);
}

async function emit(payload: unknown) {
  await act(async () => {
    for (const listener of listeners.get("move:progress") ?? [])
      listener({ payload });
  });
}

/** Settings' Move to OpenBot Cloud: the window opens on what moves. */
async function atConfirm() {
  selfContainedRunning({ due: false, fromSettings: true });
  answers.move_preview = PREVIEW;
  const view = await launch();
  await view.findByRole("button", { name: "Move to OpenBot Cloud" });
  await waitFor(() =>
    expect(
      (
        view.getByRole("button", {
          name: "Move to OpenBot Cloud",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  return view;
}

test("after the update, OpenBot (Self-Contained) asks once, before showing OpenBot, with what the move removes", async () => {
  selfContainedRunning({ due: true });
  const view = await launch();
  await view.findByRole("heading", { name: "Move to OpenBot Cloud?" });
  // The shell is told this build offers OpenBot Cloud, and OpenBot is not shown yet.
  expect(called("move_offer").map((call) => call.args)).toEqual([
    { cloud: true },
  ]);
  expect(called("show_openbot")).toEqual([]);
  const cloud = view.getByRole("radio", {
    name: /^OpenBot Cloud/,
  }) as HTMLInputElement;
  expect(cloud.checked).toBe(true);
  expect(cloud.closest("label")?.textContent).toContain("Recommended");
  expect(cloud.closest("label")?.textContent).toContain(
    "Your Bots, conversations, memory, skills, routines and files move to your OpenBot Cloud account. This removes about 18.4 GB of OpenBot files from this computer.",
  );
  expect(
    view.getByRole("radio", { name: /^OpenBot \(Self-Contained\)/ }),
  ).toBeTruthy();
  // Continue goes on to what moves, read from the OpenBot running here.
  answers.move_preview = PREVIEW;
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await view.findByRole("heading", { name: "Move to OpenBot Cloud" });
  expect(called("move_preview")).toHaveLength(1);
});

test("a launch that isn't due shows OpenBot straight away, and a connected app is never asked", async () => {
  selfContainedRunning({ due: false });
  let view = await launch();
  await waitFor(() => expect(called("show_openbot")).toHaveLength(1));
  expect(view.queryByRole("heading", { name: "Move to OpenBot Cloud?" })).toBe(
    null,
  );
  cleanup();
  calls = [];
  // Connected to OpenBot Cloud or a company's OpenBot: the shell opens it, and nothing is asked.
  answers = {
    connection: {
      mode: "connected",
      address: "https://api.open.bot",
      signedIn: true,
    },
    move_offer: { due: true, fromSettings: false, footprintBytes: GB },
  };
  view = await launch();
  await waitFor(() => expect(called("show_connected")).toHaveLength(1));
  expect(called("move_offer")).toEqual([]);
  expect(view.queryByRole("heading", { name: "Move to OpenBot Cloud?" })).toBe(
    null,
  );
});

test("Keep records the answer and shows OpenBot, and the next launch never asks again", async () => {
  selfContainedRunning({ due: true });
  const view = await launch();
  await view.findByRole("heading", { name: "Move to OpenBot Cloud?" });
  await userEvent.click(
    view.getByRole("radio", { name: /^OpenBot \(Self-Contained\)/ }),
  );
  // Keep picked: the note is about moving later, not about what a move removes (box B).
  expect(view.queryByText(/Nothing is removed/)).toBe(null);
  view.getByText("You can still move to OpenBot Cloud later in Settings.");
  await userEvent.click(
    view.getByRole("button", { name: "Keep OpenBot on this computer" }),
  );
  await waitFor(() => expect(called("show_openbot")).toHaveLength(1));
  const order = calls.map((call) => call.command);
  expect(order.indexOf("keep_self_contained")).toBeGreaterThan(-1);
  expect(order.indexOf("keep_self_contained")).toBeLessThan(
    order.indexOf("show_openbot"),
  );
  expect(called("move_offer")).toHaveLength(1);
  expect(called("move_to_cloud")).toEqual([]);
  cleanup();
  calls = [];
  // Recorded: the shell answers not due from now on.
  selfContainedRunning({ due: false });
  const next = await launch();
  await waitFor(() => expect(called("show_openbot")).toHaveLength(1));
  expect(next.queryByRole("heading", { name: "Move to OpenBot Cloud?" })).toBe(
    null,
  );
});

test("before the move, the apps that must be reconnected are listed by name, above the Move button", async () => {
  const view = await atConfirm();
  const counts = view.getByRole("list", { name: "What moves" });
  expect(
    [...counts.querySelectorAll("li")].map((li) => li.textContent),
  ).toEqual([
    "3 Bots",
    "9 skills",
    "42 conversations",
    "52 memories",
    "1 routine",
    "64 files",
  ]);
  const apps = view.getByRole("list", { name: "Apps to reconnect" });
  expect([...apps.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "Gmail, sam@example.comUsed by Inbox helper",
    "Slack",
    "Google Drive",
  ]);
  expect(view.getByText(/can't move safely/)).toBeTruthy();
  const move = view.getByRole("button", { name: "Move to OpenBot Cloud" });
  // The notice comes before the button a person presses.
  expect(
    apps.compareDocumentPosition(move) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    (
      view.getByRole("checkbox", {
        name: /Bring my AI key to OpenBot Cloud/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    view.getByText(
      /Removes about 18\.4 GB of OpenBot files\. Nothing is removed/,
    ),
  ).toBeTruthy();
});

test("a move that fails removes nothing, and Try again moves again", async () => {
  for (const kind of ["move-failed", "move-mismatch"]) {
    const view = await atConfirm();
    const said =
      kind === "move-failed"
        ? "OpenBot couldn't send your Bots to OpenBot Cloud. Check your internet connection and try again."
        : "OpenBot Cloud didn't get all of your conversations.";
    let attempts = 0;
    answers.move_to_cloud = () => {
      attempts += 1;
      if (attempts === 1) throw { said, kind };
      return new Promise(() => {});
    };
    await userEvent.click(
      view.getByRole("button", { name: "Move to OpenBot Cloud" }),
    );
    await view.findByText("Nothing was removed from this computer.");
    expect(view.getByText(said)).toBeTruthy();
    expect(
      view.getByRole("heading", {
        name:
          kind === "move-failed"
            ? "The move didn't finish"
            : "Not everything arrived",
      }),
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Keep OpenBot on this computer" }),
    ).toBeTruthy();
    expect(called("move_to_cloud")[0]?.args).toEqual({
      address: "https://api.open.bot",
      includeModelKeys: true,
    });
    await userEvent.click(view.getByRole("button", { name: "Try again" }));
    await view.findByRole("heading", { name: "Moving to OpenBot Cloud" });
    expect(called("move_to_cloud")).toHaveLength(2);
    cleanup();
    calls = [];
    listeners.clear();
  }
});

test("a move OpenBot Cloud stopped for a reason says that reason, with no try again of its own", async () => {
  const view = await atConfirm();
  // As `move_to_cloud` answers when the import says why it stopped (`Failure::Stopped`).
  const said =
    "\"Field Researcher\" has new messages on your computer, and was also carried on in OpenBot Cloud. OpenBot won't overwrite what was said in OpenBot Cloud, so the new messages can't move.";
  answers.move_to_cloud = () => {
    throw { said, detail: null, kind: "move-stopped" };
  };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByText("Nothing was removed from this computer.");
  expect(view.getByText(said)).toBeTruthy();
  expect(view.queryByText(/Try again in a moment/)).toBe(null);
  expect(view.queryByText(/You can try again/)).toBe(null);
  expect(
    view.getByText(
      "Your Bots and their work are on this computer, just as they were. You can keep using OpenBot here.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Technical details")).toBe(null);
  expect(
    view.getByRole("heading", { name: "The move didn't finish" }),
  ).toBeTruthy();
});

test("the move shows each stage, and Cancel while signing in goes back with nothing removed", async () => {
  const view = await atConfirm();
  let reject!: (error: unknown) => void;
  answers.move_to_cloud = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "Moving to OpenBot Cloud" });
  await emit({ stage: "sign-in", state: "running" });
  expect(view.getByText("Finish signing in in your browser.")).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(called("cancel_move")).toHaveLength(1);
  await act(async () =>
    reject({ said: "Signing in didn't finish.", kind: "sign-in" }),
  );
  await view.findByRole("button", { name: "Move to OpenBot Cloud" });
  expect(view.queryByText("Nothing was removed from this computer.")).toBe(
    null,
  );
  // Again, signed in: the stages done tick, and the one running says how far it got.
  answers.move_to_cloud = () => new Promise(() => {});
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "Moving to OpenBot Cloud" });
  await emit({ stage: "upload", state: "running", progress: 0.42 });
  const rows = view.getByRole("list", { name: "Move progress" });
  expect([...rows.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "✓Signing in to OpenBot CloudComplete",
    "✓Packing up your Bots and their workComplete",
    expect.stringMatching(/^Sending to OpenBot CloudIn progress.*42% sent\.$/),
    "Adding them to OpenBot Cloud",
    "Checking everything arrived",
    "Removing OpenBot from this computer",
  ]);
  expect(view.queryByRole("button", { name: "Cancel" })).toBe(null);
});

test("a finished move says what it removed and one Reconnect per app, each opening that app in OpenBot Cloud's connections", async () => {
  const view = await atConfirm();
  answers.move_to_cloud = { ...MOVED, connectAi: false };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  // The figure the move screen promised, said the same way.
  expect(view.getByText("18.4 GB of OpenBot files removed")).toBeTruthy();
  // The disk showed nearly all of it free: nothing more to say.
  expect(view.queryByText(/of that is free space on your disk/)).toBe(null);
  expect(view.getByText(MOVED.notes[0] as string)).toBeTruthy();
  const reconnect = view.getAllByRole("button", { name: /^Reconnect / });
  expect(reconnect.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Reconnect Gmail",
    "Reconnect Slack",
    "Reconnect Google Drive",
  ]);
  // Slack's own reconnect, which connects it and comes back to the list of the rest.
  await userEvent.click(reconnect[1] as HTMLElement);
  expect(called("open_moved_cloud").map((call) => call.args)).toEqual([
    { path: "/reconnect/slack" },
  ]);
  await userEvent.click(view.getByRole("button", { name: "Open OpenBot" }));
  // Opening already: the window is on its way to OpenBot Cloud.
  expect(called("open_moved_cloud")).toHaveLength(1);
});

test("Open OpenBot after a move that left apps to reconnect opens the list of them", async () => {
  const view = await atConfirm();
  answers.move_to_cloud = { ...MOVED, connectAi: null };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  expect(view.getAllByRole("button", { name: /^Reconnect / })).toHaveLength(3);
  await userEvent.click(view.getByRole("button", { name: "Open OpenBot" }));
  expect(called("open_moved_cloud").map((call) => call.args)).toEqual([
    { path: "/reconnect" },
  ]);
});

/**
 * The shell opens only a plain lowercase path of at most 100 characters (`relay::app_page`), and
 * anything else opens home. An app id it can't carry opens the list, never home.
 */
test("an app's reconnect is a path the shell will open, or the list", () => {
  const page = (appId: string) => reconnectPage({ appId, appName: appId });
  expect(page("gmail")).toBe("/reconnect/gmail");
  expect(page("google-drive")).toBe("/reconnect/google-drive");
  expect(page("google_calendar")).toBe("/reconnect/google_calendar");
  for (const appId of [
    "GitHub",
    "ms.teams",
    "a/b",
    "notion?x=1",
    "café",
    "",
    "x".repeat(100),
  ])
    expect(page(appId)).toBe("/reconnect");
});

/**
 * Seen on 1.2.0-rc.1: the result listed the apps with Reconnect and nothing else to do, so the
 * person read the move as done but for the apps. Reconnect landed on Connect your AI, which then
 * dropped them on home with no app connected. A person OpenBot Cloud still needs an AI from is taken
 * there first, and the apps wait as the step after it.
 */
test("a finished move that still needs the person's AI leads with Connect your AI, and no Reconnect skips it", async () => {
  const view = await atConfirm();
  answers.move_to_cloud = { ...MOVED, connectAi: true };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  expect(view.getByText("18.4 GB of OpenBot files removed")).toBeTruthy();
  const first = view.getByRole("heading", { name: "Connect your AI first" });
  const then = view.getByRole("heading", { name: "Then reconnect your apps" });
  expect(
    first.compareDocumentPosition(then) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The apps are still named, as what comes next, with nothing on them to press.
  const apps = view.getByRole("list", { name: "Apps to reconnect" });
  expect([...apps.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "Gmail, sam@example.comUsed by Inbox helper",
    "Slack",
    "Google Drive",
  ]);
  expect(
    view.getByText(/reconnect each one from a list in OpenBot Cloud/),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: /^Reconnect/ })).toBe(null);
  // No way past the step: Connect your AI is the one button.
  expect(view.queryByRole("button", { name: "Open OpenBot" })).toBe(null);
  expect(
    view.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["Connect your AI"]);
  // OpenBot Cloud runs Connect your AI first, then lands on the list of apps to reconnect.
  await userEvent.click(view.getByRole("button", { name: "Connect your AI" }));
  expect(called("open_moved_cloud").map((call) => call.args)).toEqual([
    { path: "/reconnect" },
  ]);
});

test("Open OpenBot opens OpenBot Cloud's home, and what couldn't be removed is said calmly", async () => {
  const view = await atConfirm();
  answers.move_to_cloud = {
    removedBytes: 640_000_000,
    diskGainedBytes: null,
    apps: [],
    notes: [],
    leftBehind: [
      "Some of OpenBot's software is still on this computer. You can remove it from Settings.",
    ],
  };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  expect(view.getByText("640 MB of OpenBot files removed")).toBeTruthy();
  expect(view.getByRole("status").textContent).toContain(
    "Some of OpenBot's software is still on this computer.",
  );
  expect(view.queryByRole("button", { name: /^Reconnect / })).toBe(null);
  await userEvent.click(view.getByRole("button", { name: "Open OpenBot" }));
  expect(called("open_moved_cloud").map((call) => call.args)).toEqual([
    { path: "/" },
  ]);
});

/**
 * Seen on a Mac: the move screen said "Frees about 20.2 GB", the result "4.5 GB freed". The result
 * says the figure the move screen said, and the disk's own figure under it, plainly, when the disk
 * shows much less of it free so far.
 */
test("the result says what the move screen said it removes, and what the disk shows free so far when that is much less", async () => {
  selfContainedRunning({ due: false, fromSettings: true });
  answers.move_preview = { ...PREVIEW, footprintBytes: 20_200_000_000 };
  const view = await launch();
  await view.findByText(
    /Removes about 20\.2 GB of OpenBot files\. Nothing is removed/,
  );
  answers.move_to_cloud = {
    ...MOVED,
    removedBytes: 20_200_000_000,
    diskGainedBytes: 4_500_000_000,
  };
  await waitFor(() =>
    expect(
      (
        view.getByRole("button", {
          name: "Move to OpenBot Cloud",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  expect(view.getByText("20.2 GB of OpenBot files removed")).toBeTruthy();
  expect(
    view.getByText(/So far, 4\.5 GB of that is free space on your disk\./),
  ).toBeTruthy();
  expect(view.queryByText(/freed/)).toBe(null);
});

test("counts keep the kinds there are words for, in order, and skip zeros; space reads in GB or MB", () => {
  expect(
    countLines([
      { kind: "files", count: 1 },
      { kind: "check-ins", count: 2 },
      { kind: "goals", count: 1 },
      { kind: "bots", count: 1 },
      { kind: "settings", count: 4 },
      // A Bot's tool steps are message records too: never a count a person reads.
      { kind: "messages", count: 39 },
      { kind: "something-new", count: 7 },
      { kind: "memories", count: 0 },
    ]).map((line) => line.said),
  ).toEqual(["1 Bot", "1 goal", "2 check-ins", "1 file"]);
  expect(formatSpace(18_449_999_999)).toBe("18.4 GB");
  expect(formatSpace(999_000_000)).toBe("999 MB");
  expect(formatSpace(1_000)).toBe("1 MB");
});
