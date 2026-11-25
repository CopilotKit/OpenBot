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

/*
 * OpenBot for Business's booking calendar is never fetched from Calendly: its frame gets an empty
 * page, as `App.test.tsx` gives it, and a test of the window goes nowhere on the web.
 */
beforeAll(() =>
  GlobalRegistrator.register({
    settings: {
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ request, window }) =>
            new URL(request.url).hostname === "calendly.com"
              ? new window.Response("<!doctype html><title></title>", {
                  headers: { "content-type": "text/html" },
                })
              : undefined,
        },
      },
    },
  }),
);
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

/*
 * A Mac with two older installs of OpenBot on its disk: the question waited 15 seconds for the size
 * of OpenBot's files. The shell answers at once now, without the size, and measures it on its own.
 * The question shows straight away without it, and the size joins it once measured.
 */
test("the question shows at once without the size, and the size joins it once measured", async () => {
  selfContainedRunning({ due: true });
  answers.move_offer = { due: true, fromSettings: false, footprintBytes: null };
  let measured!: (bytes: number | null) => void;
  answers.move_footprint = new Promise((resolve) => {
    measured = resolve;
  });
  const view = await launch();
  await view.findByRole("heading", { name: "Move to OpenBot Cloud?" });
  const cloud = view.getByRole("radio", {
    name: /^OpenBot Cloud/,
  }) as HTMLInputElement;
  const said = () => cloud.closest("label")?.textContent ?? "";
  expect(said()).toContain(
    "Your Bots, conversations, memory, skills, routines and files move to your OpenBot Cloud account.",
  );
  expect(said()).not.toContain("This removes about");
  expect(called("move_footprint")).toHaveLength(1);
  await act(async () => measured(GB));
  await waitFor(() =>
    expect(said()).toContain(
      "This removes about 18.4 GB of OpenBot files from this computer.",
    ),
  );
});

/*
 * FOUND IN A MAC UPGRADE CHECK of 1.2: the choice and the next screen said two sizes for what the
 * move removes. Offered over the OpenBot running here, nothing starts or updates between them, so
 * the next screen says the figure the choice said, however its own measure rounds.
 */
test("offered over OpenBot running, the next screen says the size the choice said", async () => {
  selfContainedRunning({ due: true });
  answers.move_preview = { ...PREVIEW, footprintBytes: GB + 120_000_000 };
  const view = await launch();
  await view.findByRole("heading", { name: "Move to OpenBot Cloud?" });
  const cloud = view.getByRole("radio", { name: /^OpenBot Cloud/ });
  expect(cloud.closest("label")?.textContent).toContain(
    "This removes about 18.4 GB of OpenBot files from this computer.",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await view.findByText("3 Bots");
  expect(
    view.getByText(
      /Removes about 18\.4 GB of OpenBot files\. Nothing is removed/,
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("18.5 GB");
});

/*
 * A company that wants OpenBot on its own cloud learns it can, on the move screen too: OpenBot for
 * Business, between OpenBot Cloud and OpenBot (Self-Contained), as the first screen draws it. It
 * books a demo and moves nothing. Before, the move screen offered only the other two.
 */
test("the move screen offers OpenBot for Business between Cloud and Self-Contained, which books a demo and moves nothing", async () => {
  selfContainedRunning({ due: true });
  const view = await launch();
  await view.findByRole("heading", { name: "Move to OpenBot Cloud?" });
  // Three choices, in this order on screen, for the keyboard and for a screen reader.
  const names = view
    .getAllByRole("radio")
    .map(
      (radio) =>
        radio.closest("label")?.querySelector(".tile-name")?.textContent,
    );
  expect(names).toEqual([
    "OpenBot Cloud Recommended",
    "OpenBot for Business",
    "OpenBot (Self-Contained)",
  ]);
  const cloud = view.getByRole("radio", {
    name: /^OpenBot Cloud/,
  }) as HTMLInputElement;
  const business = view.getByRole("radio", {
    name: /^OpenBot for Business/,
  }) as HTMLInputElement;
  expect(cloud.checked).toBe(true);
  expect(business.checked).toBe(false);
  // The first screen's row: its words and the clouds it runs on.
  const row = business.closest("label") as HTMLElement;
  expect(row.textContent).toContain("Your own cloud or on-prem. Book a demo.");
  expect(
    [...row.querySelectorAll(".cloud-mark img")].map((mark) =>
      mark.getAttribute("alt"),
    ),
  ).toEqual(["AWS", "Azure", "Google Cloud", "Kubernetes"]);
  expect(view.queryByTitle("Booking calendar")).toBeNull();

  // Picked: what it adds and the calendar to book a demo, and nothing that moves or keeps.
  await userEvent.click(business);
  expect(business.checked).toBe(true);
  expect(
    view.getByText(
      "Deploy in your own VPC on AWS, Azure or GCP, on-prem, or on OpenBot Cloud",
    ),
  ).toBeTruthy();
  expect(view.getByRole("heading", { name: "Book a demo" })).toBeTruthy();
  expect(view.getByTitle("Booking calendar")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(
    view.queryByRole("button", { name: "Keep OpenBot on this computer" }),
  ).toBeNull();
  expect(view.queryByText(/Nothing is removed/)).toBeNull();
  expect(
    view.queryByText("You can still move to OpenBot Cloud later in Settings."),
  ).toBeNull();

  // OpenBot Cloud again: Continue and the promise, exactly as before, and no calendar.
  await userEvent.click(cloud);
  expect(view.queryByTitle("Booking calendar")).toBeNull();
  expect(view.getByRole("button", { name: "Continue" })).toBeTruthy();
  view.getByText(
    "Nothing is removed from this computer until everything has arrived in OpenBot Cloud and been checked.",
  );
  // OpenBot (Self-Contained): Keep and its note, as before.
  await userEvent.click(
    view.getByRole("radio", { name: /^OpenBot \(Self-Contained\)/ }),
  );
  expect(view.queryByTitle("Booking calendar")).toBeNull();
  expect(
    view.getByRole("button", { name: "Keep OpenBot on this computer" }),
  ).toBeTruthy();
  view.getByText("You can still move to OpenBot Cloud later in Settings.");
  // Looking at OpenBot for Business moved, kept and started nothing.
  expect(called("move_preview")).toEqual([]);
  expect(called("move_to_cloud")).toEqual([]);
  expect(called("keep_self_contained")).toEqual([]);
  expect(called("show_openbot")).toEqual([]);
});

/*
 * Where OpenBot for Business runs is the first thing in its list, not a big line over it: somebody
 * looking down the list for running it in their own VPC found it missing, because the eye skips a
 * large heading of that sort. The screen keeps a short heading. Governance and the audit trail lead
 * "In control", and custom agents and harnesses are listed for the whole organization.
 */
test("OpenBot for Business lists where it runs first, governance and the audit trail first in control, and custom agents", async () => {
  selfContainedRunning({ due: true });
  const view = await launch();
  await view.findByRole("heading", { name: "Move to OpenBot Cloud?" });
  await userEvent.click(
    view.getByRole("radio", { name: /^OpenBot for Business/ }),
  );
  const booker = document.querySelector(".business-booker") as HTMLElement;
  expect(booker).toBeTruthy();
  // A short heading, and the booker is named by it.
  const heading = booker.querySelector<HTMLElement>(".business-deploy");
  expect(heading?.textContent).toBe("OpenBot for Business");
  expect(
    document.getElementById(booker.getAttribute("aria-labelledby") ?? ""),
  ).toBe(heading);
  // Each group as drawn: its heading, then its items in order.
  const groups = [...booker.querySelectorAll(".business-group")].map(
    (group) => [
      group.querySelector("h3")?.textContent,
      [...group.querySelectorAll("li")].map((item) => item.textContent),
    ],
  );
  expect(groups).toEqual([
    [
      "For your whole organization",
      [
        "Deploy in your own VPC on AWS, Azure or GCP, on-prem, or on OpenBot Cloud",
        "Sign-in with Google, Microsoft or custom SSO",
        "People, roles and admins",
        "Bots shared with your whole organization",
        "Learning shared across your organization",
        "Deploy custom agents built with any agent stack, or bring your own custom harness, with a great user experience and governance",
      ],
    ],
    [
      "Where your Bots work",
      ["Bots in Slack and Microsoft Teams", "A computer for each Bot"],
    ],
    [
      "In control",
      [
        "Top-to-bottom enterprise governance",
        "A full audit trail, with export",
        "Controls over models, apps and networks",
        "Rules every Bot follows",
        "Policies in plain English, tested on past activity",
      ],
    ],
  ]);
  // Every item has its icon.
  for (const item of booker.querySelectorAll(".business-list li")) {
    expect(item.querySelector(".business-icon svg")).toBeTruthy();
  }
  expect(view.queryByText("Governance for everyone")).toBeNull();
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
  expect(
    view.getByText("Sign-ins can't move, so you'll sign in to each one again."),
  ).toBeTruthy();
  // An older shell names no apps that move connected: none is said.
  expect(view.queryByText("These apps come across connected")).toBe(null);
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

const FIREFLIES = {
  appId: "fireflies",
  appName: "Fireflies",
  botNames: ["Standup"],
};
const POSTHOG = { appId: "posthog", appName: "PostHog" };
/** OpenBot Cloud's sentence for a carried app its organization doesn't allow. */
const NOT_ALLOWED =
  "Your organization doesn't allow Team wiki yet. Ask an admin to approve it, then connect it here.";

/**
 * Reported in dogfooding: after moving, a person reconnected about 20 apps, over an hour, because
 * the move said every app connection had to be connected again. Apps connected with a key now come
 * across connected, and the move says which, apart from the apps the person signs in to again.
 */
test("before the move, the apps that come across connected are said apart from those to sign in to again", async () => {
  selfContainedRunning({ due: false, fromSettings: true });
  answers.move_preview = { ...PREVIEW, carried: [FIREFLIES, POSTHOG] };
  const view = await launch();
  const carried = await view.findByRole("list", {
    name: "Apps that move connected",
  });
  expect(
    [...carried.querySelectorAll("li")].map((li) => li.textContent),
  ).toEqual(["FirefliesUsed by Standup", "PostHog"]);
  expect(
    view.getByRole("heading", { name: "These apps come across connected" }),
  ).toBeTruthy();
  expect(
    view.getByText(
      "Their keys are sealed so only your OpenBot Cloud account can read them.",
    ),
  ).toBeTruthy();
  const reconnect = view.getByRole("list", { name: "Apps to reconnect" });
  expect(
    [...reconnect.querySelectorAll("li")].map(
      (li) => li.querySelector(".move-app-name")?.textContent,
    ),
  ).toEqual(["Gmail, sam@example.com", "Slack", "Google Drive"]);
  expect(
    view.getByRole("heading", {
      name: "You'll reconnect these apps in OpenBot Cloud",
    }),
  ).toBeTruthy();
  // What the person acts on first: the apps to sign in to again, then the AI key, then the apps
  // that come across connected, with nothing to do for them.
  const follows = (first: Node, then: Node) =>
    Boolean(
      first.compareDocumentPosition(then) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const key = view.getByRole("checkbox", {
    name: /Bring my AI key to OpenBot Cloud/,
  });
  expect(follows(reconnect, key)).toBe(true);
  expect(follows(key, carried)).toBe(true);
  // Without the AI key, the apps still come across connected: the move is asked as before.
  await userEvent.click(
    view.getByRole("checkbox", { name: /Bring my AI key to OpenBot Cloud/ }),
  );
  answers.move_to_cloud = () => new Promise(() => {});
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  expect(called("move_to_cloud")[0]?.args).toEqual({
    address: "https://api.open.bot",
    includeModelKeys: false,
  });
});

test("a finished move says which apps came across connected, and one it couldn't connect says why, with its Reconnect", async () => {
  const view = await atConfirm();
  answers.move_to_cloud = {
    ...MOVED,
    connectAi: false,
    carried: [FIREFLIES],
    apps: [
      ...APPS,
      { appId: "team-wiki", appName: "Team wiki", reason: NOT_ALLOWED },
    ],
  };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  const carried = view.getByRole("list", {
    name: "Apps that came across connected",
  });
  expect(
    [...carried.querySelectorAll("li")].map((li) => li.textContent),
  ).toEqual(["FirefliesUsed by Standup"]);
  expect(
    view.getByRole("heading", { name: "These apps came across connected" }),
  ).toBeTruthy();
  expect(
    view.getByText("Your Bots can use them in OpenBot Cloud as before."),
  ).toBeTruthy();
  // Nothing to press on an app that came across connected.
  expect(carried.querySelectorAll("button")).toHaveLength(0);
  const reconnect = view.getByRole("list", { name: "Apps to reconnect" });
  const wiki = [...reconnect.querySelectorAll("li")].find((li) =>
    li.textContent?.startsWith("Team wiki"),
  );
  expect(wiki?.querySelector("[data-move-app-reason]")?.textContent).toBe(
    NOT_ALLOWED,
  );
  expect(
    view.getByText("Sign-ins can't move, so sign in to each one again."),
  ).toBeTruthy();
  // The apps to reconnect first, then the ones that came across connected, then the notices.
  expect(
    reconnect.compareDocumentPosition(carried) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    carried.compareDocumentPosition(view.getByText(MOVED.notes[0] as string)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    view
      .getAllByRole("button", { name: /^Reconnect / })
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([
    "Reconnect Gmail",
    "Reconnect Slack",
    "Reconnect Google Drive",
    "Reconnect Team wiki",
  ]);
  await userEvent.click(
    view.getByRole("button", { name: "Reconnect Team wiki" }),
  );
  expect(called("open_moved_cloud").map((call) => call.args)).toEqual([
    { path: "/reconnect/team-wiki" },
  ]);
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

/**
 * Seen on 1.2.0-rc.3: after a move the person found nothing that said where OpenBot Cloud was or
 * which account held their Bots, went to the website, signed in with another account and found an
 * empty OpenBot. The result names the account and organization the move went into, says where
 * OpenBot Cloud is in a browser, and opens it there.
 */
test("a finished move names the account and organization it went into, and opens OpenBot Cloud in the browser", async () => {
  const view = await atConfirm();
  answers.move_to_cloud = {
    ...MOVED,
    connectAi: false,
    account: { email: "sam@example.com", organization: "Sam's organization" },
  };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  expect(
    view.getByText(
      /You're signed in as sam@example\.com, in Sam's organization\./,
    ),
  ).toBeTruthy();
  expect(
    view.getByText(
      "In a browser, OpenBot Cloud is at my.open.bot. Sign in there as sam@example.com.",
    ),
  ).toBeTruthy();
  const browser = view.getByRole("link", { name: "Open in browser" });
  expect(browser.getAttribute("href")).toBe("https://my.open.bot");
  await userEvent.click(browser);
  expect(called("plugin:opener|open_url").map((call) => call.args)).toEqual([
    { url: "https://my.open.bot" },
  ]);
  // The window's own way on is still there, and the browser didn't take it.
  expect(called("open_moved_cloud")).toHaveLength(0);
  expect(view.getByRole("button", { name: "Open OpenBot" })).toBeTruthy();
});

test("a finished move an older shell answered without the account still says where OpenBot Cloud is", async () => {
  const view = await atConfirm();
  answers.move_to_cloud = { ...MOVED, connectAi: false };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  expect(view.queryByText(/You're signed in as/)).toBe(null);
  expect(
    view.getByText("In a browser, OpenBot Cloud is at my.open.bot."),
  ).toBeTruthy();
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
    view.getByText(
      "Sign-ins can't move. Once your AI is connected, you'll reconnect each one from a list in OpenBot Cloud.",
    ),
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

/** The person's own organization on OpenBot Cloud and their company's, as `move_destinations` says. */
const SAMS_OWN = {
  id: "org_mine",
  name: "Sam's organization",
  personal: true,
  canMoveIn: true,
};
const ACME = { id: "org_acme", name: "Acme", personal: false, canMoveIn: true };

function radioNames(view: ReturnType<typeof render>) {
  return view
    .getAllByRole("radio")
    .map(
      (radio) =>
        radio.closest("label")?.querySelector(".tile-name")?.textContent,
    );
}

/*
 * A person in their own organization on OpenBot Cloud and their company's. Before, the move put
 * everything in their own and never asked, and nothing let them move it across after. Signed in,
 * they choose where their Bots go, their own first and picked to begin with, and the move goes there.
 */
test("a person in two organizations chooses where their Bots go, and they move there", async () => {
  const view = await atConfirm();
  // OpenBot Cloud lists the company's first; the person's own still comes first on screen.
  answers.move_destinations = [ACME, SAMS_OWN];
  answers.move_to_cloud = {
    ...MOVED,
    connectAi: false,
    account: { email: "sam@example.com", organization: "Acme" },
  };
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "Where should your Bots go?" });
  expect(called("move_destinations").map((call) => call.args)).toEqual([
    { address: "https://api.open.bot" },
  ]);
  // Nothing moves until they choose.
  expect(called("move_to_cloud")).toEqual([]);
  expect(radioNames(view)).toEqual(["Sam's organization", "Acme"]);
  const own = view.getByRole("radio", {
    name: /^Sam's organization/,
  }) as HTMLInputElement;
  const acme = view.getByRole("radio", { name: /^Acme/ }) as HTMLInputElement;
  expect(own.checked).toBe(true);
  expect(acme.disabled).toBe(false);
  expect(
    view.getByText(
      "Nothing is removed from this computer until everything has arrived in OpenBot Cloud and been checked.",
    ),
  ).toBeTruthy();
  await userEvent.click(acme);
  expect(acme.checked).toBe(true);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await view.findByRole("heading", { name: "You're on OpenBot Cloud" });
  expect(called("move_to_cloud").map((call) => call.args)).toEqual([
    {
      address: "https://api.open.bot",
      includeModelKeys: true,
      organization: "org_acme",
    },
  ]);
  // The result names the organization they chose.
  expect(
    view.getByText(/You're signed in as sam@example\.com, in Acme\./),
  ).toBeTruthy();
});

test("a person in one organization isn't asked: the move goes straight on into it", async () => {
  const view = await atConfirm();
  answers.move_destinations = [ACME];
  answers.move_to_cloud = () => new Promise(() => {});
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await waitFor(() => expect(called("move_to_cloud")).toHaveLength(1));
  expect(called("move_to_cloud")[0]?.args).toEqual({
    address: "https://api.open.bot",
    includeModelKeys: true,
    organization: "org_acme",
  });
  expect(
    view.getByRole("heading", { name: "Moving to OpenBot Cloud" }),
  ).toBeTruthy();
  expect(
    view.queryByRole("heading", { name: "Where should your Bots go?" }),
  ).toBe(null);
});

/*
 * An organization that doesn't let the person use Bots is shown, so they know why it isn't theirs
 * to pick, and can't be picked. If the shell refuses one anyway (OpenBot Cloud changed its mind),
 * the move stopped with nothing removed, and Try again asks again, their last choice picked.
 */
test("an organization that doesn't let the person use Bots is shown but can't be picked, and a refused move removed nothing", async () => {
  const view = await atConfirm();
  answers.move_destinations = [
    SAMS_OWN,
    { ...ACME, canMoveIn: false },
    {
      id: "org_lab",
      name: "Research Lab",
      personal: false,
      canMoveIn: true,
    },
  ];
  await userEvent.click(
    view.getByRole("button", { name: "Move to OpenBot Cloud" }),
  );
  await view.findByRole("heading", { name: "Where should your Bots go?" });
  expect(radioNames(view)).toEqual([
    "Sam's organization",
    "Acme",
    "Research Lab",
  ]);
  const acme = view.getByRole("radio", { name: /^Acme/ }) as HTMLInputElement;
  expect(acme.disabled).toBe(true);
  expect(acme.closest("label")?.textContent).toContain(
    "An admin of this organization hasn't let you use Bots here.",
  );
  await userEvent.click(acme.closest("label") as HTMLElement);
  expect(acme.checked).toBe(false);
  expect(
    (
      view.getByRole("radio", {
        name: /^Sam's organization/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);

  // Research Lab, which the shell then refuses: nothing moved.
  const said =
    "An admin of Research Lab hasn't let you use Bots there. Ask them to let you, or choose another organization.";
  answers.move_to_cloud = () => {
    throw { said, detail: null, kind: "move-not-allowed" };
  };
  await userEvent.click(view.getByRole("radio", { name: /^Research Lab/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await view.findByRole("heading", { name: "Your Bots can't move there" });
  expect(view.getByText(said)).toBeTruthy();
  expect(
    view.getByText("Nothing was removed from this computer."),
  ).toBeTruthy();
  expect(called("move_to_cloud")[0]?.args).toEqual({
    address: "https://api.open.bot",
    includeModelKeys: true,
    organization: "org_lab",
  });
  // Try again asks where once more, their last choice picked.
  await userEvent.click(view.getByRole("button", { name: "Try again" }));
  await view.findByRole("heading", { name: "Where should your Bots go?" });
  expect(called("move_destinations")).toHaveLength(2);
  expect(
    (view.getByRole("radio", { name: /^Research Lab/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
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
