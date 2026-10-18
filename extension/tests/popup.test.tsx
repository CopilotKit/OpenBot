import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RecorderBot } from "@openbot/shared/recorder-api";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PASS_HINTS } from "../src/offscreen/grant";
import { Popup } from "../src/pages/popup/popup";
import { stripCaptureStatus } from "../src/pages/ui/capture-rows";
import {
  IDLE_STATE,
  type PageResponse,
  type PageStateResponse,
  type PageToBackground,
  type RecorderState,
} from "../src/protocol/messages";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

let originalMatchMedia: typeof window.matchMedia;
let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake();
  localStorage.clear();
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  fake.uninstall();
});

const learning = (state: RecorderBot["learning"]["state"]) => ({
  state,
  containerId: state === "assigned" ? "c1" : null,
});
const BOTS: RecorderBot[] = [
  { id: "b1", name: "Billing Bot", learning: learning("assigned") },
  { id: "b2", name: "Support Bot", learning: learning("unassigned") },
];

function stateResponse(
  over: Omit<Partial<PageStateResponse>, "state"> & {
    state?: Partial<RecorderState>;
  } = {},
): PageStateResponse {
  const { state, ...rest } = over;
  return {
    ok: true,
    state: { ...IDLE_STATE, ...state },
    connection: {
      openbotUrl: "https://openbot.example.test",
      user: { name: "Ada Lovelace", email: "ada@example.test" },
      via: "web",
    },
    me: {
      user: { id: "u1", name: "Ada Lovelace", email: "ada@example.test" },
      connectionId: "k1",
      capabilities: { transcription: true },
    } as PageStateResponse["me"],
    policy: { openbotUrl: null, invalid: false },
    notice: null,
    ...rest,
  };
}

function setup(
  response: PageStateResponse,
  options: {
    bots?: RecorderBot[];
    desktop?: boolean;
    prepared?: { ok: true } | { ok: false; reason: "permission" };
    answers?: Partial<Record<PageToBackground["type"], PageResponse>>;
    lastBotId?: string;
    /** What the service worker does with a message before it answers, for the next page.state to show. */
    onAsk?: (message: PageToBackground) => void;
  } = {},
) {
  const sent: PageToBackground[] = [];
  let prepareCalls = 0;
  const ask = async (message: PageToBackground): Promise<PageResponse> => {
    sent.push(message);
    options.onAsk?.(message);
    const fixed = options.answers?.[message.type];
    if (fixed) return fixed;
    // Chrome copies every message as JSON, so each answer is a new object, as the polling popup sees it.
    if (message.type === "page.state") return structuredClone(response);
    if (message.type === "page.bots")
      return { ok: true, bots: options.bots ?? BOTS };
    if (message.type === "page.desktop.available")
      return { ok: true, available: options.desktop ?? false };
    return { ok: true };
  };
  const view = render(
    <Popup
      deps={{
        ask: ask as never,
        prepare: async () => {
          prepareCalls += 1;
          return options.prepared ?? { ok: true };
        },
        activeTabId: async () => 7,
        lastBotId: async () => options.lastBotId,
      }}
    />,
  );
  return { sent, prepareCalls: () => prepareCalls, ...view };
}

const NOT_CONNECTED = { connection: null, me: null } as const;

test("not connected shows the connect instructions and no buttons by default", async () => {
  const { findByText, queryByRole } = setup(stateResponse(NOT_CONNECTED));
  await findByText("Connect the Recorder to OpenBot");
  await findByText(
    "Open OpenBot, go to Settings, Browsers, and choose Connect this browser.",
  );
  expect(queryByRole("button")).toBeNull();
});

test("a policy address adds an Open <host> button that opens its Browsers settings", async () => {
  const { findByText } = setup(
    stateResponse({
      ...NOT_CONNECTED,
      policy: { openbotUrl: "https://openbot.example.test", invalid: false },
    }),
  );
  fireEvent.click(await findByText("Open openbot.example.test"));
  await waitFor(() =>
    expect(fake.opened).toContain(
      "https://openbot.example.test/settings/browsers",
    ),
  );
});

test("an invalid policy address shows the IT sentence and no button", async () => {
  const { findByText, queryByRole, queryByText } = setup(
    stateResponse({
      ...NOT_CONNECTED,
      policy: { openbotUrl: "not a url", invalid: true },
    }),
  );
  await findByText(
    "Your organization's Recorder policy names an OpenBot address the Recorder cannot use. Ask your IT team.",
  );
  expect(queryByRole("button")).toBeNull();
  expect(queryByText(/Open invalid/)).toBeNull();
});

test("Connect with OpenBot Desktop is hidden unless Desktop answers available", async () => {
  const hidden = setup(stateResponse(NOT_CONNECTED), { desktop: false });
  await hidden.findByText("Connect the Recorder to OpenBot");
  await waitFor(() =>
    expect(hidden.sent.some((m) => m.type === "page.desktop.available")).toBe(
      true,
    ),
  );
  expect(hidden.queryByText("Connect with OpenBot Desktop")).toBeNull();
  cleanup();
  const shown = setup(stateResponse(NOT_CONNECTED), { desktop: true });
  fireEvent.click(await shown.findByText("Connect with OpenBot Desktop"));
  await waitFor(() =>
    expect(shown.sent.some((m) => m.type === "page.connect.desktop")).toBe(
      true,
    ),
  );
});

test("Connect with OpenBot Desktop is a secondary button even when it is the only action", async () => {
  const { findByText } = setup(stateResponse(NOT_CONNECTED), { desktop: true });
  const button = await findByText("Connect with OpenBot Desktop");
  expect(button.className).toContain("bg-secondary");
  expect(button.className).not.toContain("bg-primary");
});

test("connected and idle shows the person, the host, the form copy and Record disabled", async () => {
  const { findByText, getByText, getByRole } = setup(stateResponse());
  await findByText("Ada Lovelace");
  expect(getByText("openbot.example.test")).toBeTruthy();
  expect(
    getByText(
      "Records your clicks, typing, the pages you open and the network calls behind them. Passwords and secrets stay in your browser.",
    ),
  ).toBeTruthy();
  expect(
    (getByRole("button", { name: "Record" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("Record is disabled without a Bot even with a title", async () => {
  const { findByLabelText, getByRole } = setup(stateResponse(), { bots: [] });
  await userEvent.type(
    await findByLabelText("What are you about to do?"),
    "Refund an order",
  );
  expect(
    (getByRole("button", { name: "Record" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("Record prepares, then sends page.record with the Bot, title and tab", async () => {
  const { findByLabelText, getByRole, sent, prepareCalls } = setup(
    stateResponse(),
  );
  await userEvent.type(
    await findByLabelText("What are you about to do?"),
    "Refund an order",
  );
  await waitFor(() =>
    expect(
      (getByRole("button", { name: "Record" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(getByRole("button", { name: "Record" }));
  await waitFor(() =>
    expect(sent.find((m) => m.type === "page.record")).toEqual({
      type: "page.record",
      botId: "b1",
      title: "Refund an order",
      tabId: 7,
    }),
  );
  expect(prepareCalls()).toBe(1);
});

test("a Record refused for website access does not send page.record", async () => {
  const { findByLabelText, getByRole, findByText, sent } = setup(
    stateResponse(),
    { prepared: { ok: false, reason: "permission" } },
  );
  await userEvent.type(
    await findByLabelText("What are you about to do?"),
    "Refund an order",
  );
  await waitFor(() =>
    expect(
      (getByRole("button", { name: "Record" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(getByRole("button", { name: "Record" }));
  await findByText(/Allow website access/);
  expect(sent.some((m) => m.type === "page.record")).toBe(false);
});

test("the last used Bot is preselected", async () => {
  const { findByText, getByRole } = setup(stateResponse(), {
    lastBotId: "b2",
  });
  await findByText(
    "Learning will not see this recording: this Bot has no Learning space. It still saves to OpenBot.",
  );
  expect(getByRole("combobox", { name: "Bot" }).textContent).toContain(
    "Support Bot",
  );
});

const SENTENCES: [RecorderBot["learning"]["state"], string | null][] = [
  ["assigned", null],
  [
    "unassigned",
    "Learning will not see this recording: this Bot has no Learning space. It still saves to OpenBot.",
  ],
  [
    "missing",
    "Learning will not see this recording: this Bot's Learning space does not exist in Intelligence. Ask an administrator to fix it in Admin, Automatic Learning. It still saves to OpenBot.",
  ],
  [
    "learning-off",
    "Learning may not see this recording: Intelligence's Learning delivery is off or unavailable, so OpenBot could not check this Bot's Learning space. It still saves to OpenBot.",
  ],
  [
    "unverified",
    "Learning may not see this recording: OpenBot could not check this Bot's Learning space with Intelligence just now. It still saves to OpenBot.",
  ],
];
for (const [kind, sentence] of SENTENCES) {
  test(`a Bot whose Learning space is ${kind} ${sentence ? "says so" : "says nothing"} under the picker`, async () => {
    const { findByRole, container } = setup(stateResponse(), {
      bots: [{ id: "b1", name: "Only Bot", learning: learning(kind) }],
    });
    await findByRole("combobox", { name: "Bot" });
    if (sentence) {
      await waitFor(() => expect(container.textContent).toContain(sentence));
    } else {
      expect(container.textContent).not.toContain("Learning will not");
      expect(container.textContent).not.toContain("Learning may not");
    }
  });
}

test("the popup asks for nothing about the screen or the microphone", async () => {
  const { findByText, container, queryByRole } = setup(stateResponse());
  await findByText("Ada Lovelace");
  expect(container.textContent).not.toMatch(/microphone|screen|voice/i);
  expect(queryByRole("button", { name: "Allow microphone" })).toBeNull();
});

test("each notice renders its sentence and dismisses", async () => {
  const notices = [
    [
      { kind: "interrupted", at: 1 },
      "Your last recording stopped when the browser closed. Everything recorded until then was saved.",
    ],
    [
      { kind: "signed-out", at: 1 },
      "This browser was disconnected from OpenBot. Connect it again.",
    ],
    [
      { kind: "signed-out", at: 1, reason: "organization" },
      "Your organization sign-in ended. Connect this browser to OpenBot again.",
    ],
    [
      { kind: "policy-moved", at: 1, origin: "https://moved.example.test" },
      "Your organization moved the Recorder to https://moved.example.test. Connect it again from OpenBot.",
    ],
  ] as const;
  for (const [notice, sentence] of notices) {
    const { findByText, getByText, sent, unmount } = setup(
      stateResponse({ notice: notice as never }),
    );
    await findByText(sentence);
    fireEvent.click(getByText("Dismiss"));
    await waitFor(() =>
      expect(sent.some((m) => m.type === "page.notice.dismiss")).toBe(true),
    );
    unmount();
  }
});

test("a signed-out notice with kept recordings says they are kept and sent on reconnect", async () => {
  const { findByText } = setup(
    stateResponse({
      notice: { kind: "signed-out", at: 1 },
      state: {
        kept: {
          recordings: 1,
          events: 4,
          reason: "x",
          parked: false,
          waitingFor: { name: "Ada Lovelace", recordings: 1 },
        },
      },
    }),
  );
  await findByText(
    "Your recordings are kept in this browser and sent when you connect again.",
  );
});

test("an error shows the server's sentence, and an open recording offers Stop the open recording with replaceOpen", async () => {
  const { findByLabelText, getByRole, findByText, sent } = setup(
    stateResponse({
      state: { openRecording: { demonstrationId: "d1" }, botId: "b1" },
    }),
    {
      answers: {
        "page.record": {
          ok: false,
          error: "You already have a recording open for this Bot.",
        },
      },
    },
  );
  await userEvent.type(
    await findByLabelText("What are you about to do?"),
    "Refund an order",
  );
  await waitFor(() =>
    expect(
      (getByRole("button", { name: "Record" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(getByRole("button", { name: "Record" }));
  await findByText("You already have a recording open for this Bot.");
  fireEvent.click(await findByText("Stop the open recording"));
  await waitFor(() =>
    expect(sent.filter((m) => m.type === "page.record").at(-1)).toMatchObject({
      botId: "b1",
      replaceOpen: true,
    }),
  );
});

const OPEN_ERROR = "You already have a recording open for this Bot.";

test("an open recording offers Stop the open recording in a fresh popup that made no Record click", async () => {
  const { findByText, findByLabelText, getByRole, sent } = setup(
    stateResponse({
      state: {
        openRecording: { demonstrationId: "d1" },
        botId: "b2",
        error: OPEN_ERROR,
      } as Partial<RecorderState>,
    }),
  );
  await findByText(OPEN_ERROR);
  const stop = getByRole("button", {
    name: "Stop the open recording",
  }) as HTMLButtonElement;
  expect(stop.disabled).toBe(true);
  expect(getByRole("combobox", { name: "Bot" }).textContent).toContain(
    "Support Bot",
  );
  await userEvent.type(
    await findByLabelText("What are you about to do?"),
    "Refund an order",
  );
  await waitFor(() => expect(stop.disabled).toBe(false));
  fireEvent.click(stop);
  await waitFor(() =>
    expect(sent.filter((m) => m.type === "page.record").at(-1)).toEqual({
      type: "page.record",
      botId: "b2",
      title: "Refund an order",
      tabId: 7,
      replaceOpen: true,
    }),
  );
});

test("Stop the open recording and the refusal belong to the Bot whose Record was refused, not to whichever Bot is picked", async () => {
  const {
    findByText,
    findByLabelText,
    findByRole,
    getByRole,
    queryByRole,
    queryByText,
    sent,
  } = setup(
    stateResponse({
      state: {
        openRecording: { demonstrationId: "d1" },
        botId: "b2",
        error: OPEN_ERROR,
      } as Partial<RecorderState>,
    }),
  );
  await findByText(OPEN_ERROR);
  getByRole("button", { name: "Stop the open recording" });
  await userEvent.type(
    await findByLabelText("What are you about to do?"),
    "Refund an order",
  );

  const user = userEvent.setup({ document });
  await user.click(getByRole("combobox", { name: "Bot" }));
  await user.click(await findByRole("option", { name: "Billing Bot" }));
  await waitFor(() =>
    expect(
      queryByRole("button", { name: "Stop the open recording" }),
    ).toBeNull(),
  );
  expect(queryByText(OPEN_ERROR)).toBeNull();
  expect(sent.some((m) => m.type === "page.record")).toBe(false);

  await user.click(getByRole("combobox", { name: "Bot" }));
  await user.click(await findByRole("option", { name: "Support Bot" }));
  await findByText(OPEN_ERROR);
  getByRole("button", { name: "Stop the open recording" });
});

const CAPTURE = {
  intelligence: "streaming",
  network: "debugger",
} as const;
const recording = (
  state: Partial<RecorderState> = {},
  over: Omit<Partial<PageStateResponse>, "state"> = {},
) =>
  stateResponse({
    ...over,
    state: {
      phase: "recording",
      demonstrationId: "d7",
      botId: "b1",
      title: "Refund an order",
      startedAt: Date.now() - 65_000,
      steps: 12,
      capture: { ...CAPTURE },
      ...state,
    },
  });

test("the recording view shows the time, the step count and the Learning capture and Network rows only", async () => {
  const { findByText, getByText, queryByText, queryByRole } = setup(
    recording(),
  );
  await findByText("1:05 · 12 steps");
  for (const title of ["Learning capture", "Network"]) {
    expect(getByText(title)).toBeTruthy();
  }
  for (const title of ["Screen", "Voice"])
    expect(queryByText(title)).toBeNull();
  expect(getByText("Streaming to Intelligence")).toBeTruthy();
  expect(queryByRole("button", { name: "Record" })).toBeNull();
  expect(queryByRole("button", { name: "Record screen" })).toBeNull();
});

test("Stop and Start over send page.stop and page.restart", async () => {
  const { findByRole, getByRole, sent } = setup(recording());
  fireEvent.click(await findByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(sent.some((m) => m.type === "page.stop")).toBe(true),
  );
  fireEvent.click(getByRole("button", { name: "Start over" }));
  await waitFor(() =>
    expect(sent.some((m) => m.type === "page.restart")).toBe(true),
  );
});

/** The controller closes the notice on any choice (`page.notice`), as the next page.state then says. */
const closesNotice =
  (response: PageStateResponse) => (message: PageToBackground) => {
    if (message.type === "page.notice") response.state.noticeOpen = false;
  };

test("the 50-step card shows only while the controller says the notice is open", async () => {
  const closed = setup(
    recording({ steps: 50, noticeShown: true, noticeOpen: false }),
  );
  await closed.findByText("1:05 · 50 steps");
  expect(closed.queryByText("You have recorded 50 steps")).toBeNull();
  expect(closed.queryByRole("button", { name: "Keep going" })).toBeNull();
  closed.unmount();
  const open = setup(
    recording({ steps: 50, noticeShown: true, noticeOpen: true }),
  );
  await open.findByText("You have recorded 50 steps");
  expect(open.getByRole("button", { name: "Keep going" })).toBeTruthy();
});

test("Keep going on the page takes the card out of the popup at the next page.state", async () => {
  const response = recording({
    steps: 50,
    noticeShown: true,
    noticeOpen: true,
  });
  const { findByText, getByRole, queryByText, sent } = setup(response);
  await findByText("You have recorded 50 steps");
  // The person answers the overlay in the tab: the controller closes the notice, and the popup's poll sees it.
  response.state.noticeOpen = false;
  await waitFor(
    () => expect(queryByText("You have recorded 50 steps")).toBeNull(),
    { timeout: 3000 },
  );
  expect(sent.some((m) => m.type === "page.notice")).toBe(false);
  expect(getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("at 50 steps with the notice open the popup repeats its three choices, and Keep going hides the card", async () => {
  const response = recording({
    steps: 50,
    noticeShown: true,
    noticeOpen: true,
  });
  const { findByText, getByRole, queryByText, sent } = setup(response, {
    onAsk: closesNotice(response),
  });
  await findByText("You have recorded 50 steps");
  fireEvent.click(getByRole("button", { name: "Keep going" }));
  await waitFor(() =>
    expect(sent.filter((m) => m.type === "page.notice").at(-1)).toMatchObject({
      choice: "continue",
    }),
  );
  await waitFor(() =>
    expect(queryByText("You have recorded 50 steps")).toBeNull(),
  );
  expect(getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("the 50-step card's Stop and Start over hide it too", async () => {
  for (const [name, choice] of [
    ["Stop", "stop"],
    ["Start over", "restart"],
  ] as const) {
    const response = recording({
      steps: 52,
      noticeShown: true,
      noticeOpen: true,
    });
    const { findByText, getAllByRole, queryByText, sent, unmount } = setup(
      response,
      { onAsk: closesNotice(response) },
    );
    const card = (await findByText("You have recorded 52 steps")).closest(
      "[data-slot=item]",
    ) as HTMLElement;
    const button = getAllByRole("button", { name }).find((candidate) =>
      card.contains(candidate),
    ) as HTMLElement;
    fireEvent.click(button);
    await waitFor(() =>
      expect(sent.filter((m) => m.type === "page.notice").at(-1)).toMatchObject(
        { choice },
      ),
    );
    await waitFor(() =>
      expect(queryByText("You have recorded 52 steps")).toBeNull(),
    );
    unmount();
  }
});

test("Keep going hides the card for that recording only: the next one to reach 50 steps shows it again", async () => {
  const response = recording({
    steps: 50,
    noticeShown: true,
    noticeOpen: true,
  });
  const { findByText, getByRole, queryByText } = setup(response, {
    onAsk: closesNotice(response),
  });
  await findByText("You have recorded 50 steps");
  fireEvent.click(getByRole("button", { name: "Keep going" }));
  await waitFor(() =>
    expect(queryByText("You have recorded 50 steps")).toBeNull(),
  );
  // The popup polls page.state while a recording runs: the next answer is another recording whose notice opened.
  Object.assign(response.state, {
    demonstrationId: "d8",
    steps: 51,
    noticeOpen: true,
  });
  await findByText("You have recorded 51 steps", {}, { timeout: 3000 });
});

test("held and parked capture say so, with the reason and the kept-events line", async () => {
  const held = setup(
    recording({
      capture: {
        ...CAPTURE,
        intelligence: "held",
        intelligenceReason:
          "Learning capture is paused: Intelligence refused the capture pass (503).",
      },
    }),
  );
  await held.findByText("Learning capture is paused");
  expect(
    held.getByText("Intelligence refused the capture pass (503)."),
  ).toBeTruthy();
  expect(
    held.getByText(
      "Your events are kept in this browser and sent when Intelligence accepts them; it tries again every 5 minutes.",
    ),
  ).toBeTruthy();
  cleanup();
  const parked = setup(
    recording({
      capture: {
        ...CAPTURE,
        intelligence: "parked",
        intelligenceReason:
          "Learning capture is off: Intelligence refused the capture pass.",
      },
    }),
  );
  await parked.findByText("Learning capture is off");
  expect(
    parked.getByText(
      "Your events are kept in this browser. The Recorder tries again when the browser next starts.",
    ),
  ).toBeTruthy();
});

test("a recording outside a Learning space says Not into a Learning space with the sentence", async () => {
  const { findByText, getByText } = setup(
    recording({ learning: { state: "missing", containerId: "c9" } }),
  );
  await findByText("Not into a Learning space");
  expect(
    getByText(/this Bot's Learning space does not exist in Intelligence/),
  ).toBeTruthy();
});

const BUSY_REASON =
  "Intelligence is busy or unreachable. Retrying; nothing is lost.";
const UNJOINED_SENTENCE =
  "Learning did not see this recording: OpenBot could not choose its Learning space in time. It still saves to OpenBot.";
const HELD_LINE =
  "Your events are kept in this browser and sent when Intelligence accepts them; it tries again every 5 minutes.";
const PARKED_LINE =
  "Your events are kept in this browser. The Recorder tries again when the browser next starts.";

test("outside a Learning space the Learning capture row still says its status and reason", async () => {
  const { findByText, getByText, queryByText } = setup(
    recording({
      learning: { state: "unassigned", containerId: null },
      capture: {
        ...CAPTURE,
        intelligence: "retrying",
        intelligenceReason: BUSY_REASON,
      },
    }),
  );
  // The reason already says it is retrying, so the status word is not said twice.
  await findByText(BUSY_REASON);
  expect(queryByText(/^Retrying\./)).toBeNull();
  expect(getByText("Learning capture")).toBeTruthy();
  expect(getByText("Not into a Learning space")).toBeTruthy();
  expect(getByText(/this Bot has no Learning space/)).toBeTruthy();
});

test("a retrying status whose reason does not say so keeps the status word", async () => {
  const { findByText } = setup(
    recording({
      capture: {
        ...CAPTURE,
        intelligence: "retrying",
        intelligenceReason: "Intelligence answered 502.",
      },
    }),
  );
  await findByText("Retrying. Intelligence answered 502.");
});

test("while a recording is starting, the capture rows wait until it is live", async () => {
  const { findByText, queryByText } = setup(
    recording({ phase: "starting", capture: IDLE_STATE.capture }),
  );
  await findByText("Starting the recording");
  expect(queryByText("Learning capture")).toBeNull();
  expect(queryByText("Network")).toBeNull();
  expect(queryByText("Screen")).toBeNull();
  expect(queryByText("Voice")).toBeNull();
  expect(queryByText("Off")).toBeNull();
});

test("a held recording outside a Learning space keeps the pause, its reason and the kept line beside Not into a Learning space", async () => {
  const { findByText, getByText } = setup(
    recording({
      learning: { state: "unjoined", containerId: null },
      capture: {
        ...CAPTURE,
        intelligence: "held",
        intelligenceReason: PASS_HINTS.IDENTITY_REQUIRED,
      },
    }),
  );
  await findByText("Learning capture is paused");
  expect(
    getByText("OpenBot could not tell Intelligence who you are."),
  ).toBeTruthy();
  expect(getByText(HELD_LINE)).toBeTruthy();
  expect(getByText("Not into a Learning space")).toBeTruthy();
  expect(getByText(UNJOINED_SENTENCE)).toBeTruthy();
});

test("a parked recording outside a Learning space says Not into a Learning space too", async () => {
  const { findByText, getByText } = setup(
    recording({
      learning: { state: "missing", containerId: "c9" },
      capture: {
        ...CAPTURE,
        intelligence: "parked",
        intelligenceReason: PASS_HINTS.NOT_FOUND,
      },
    }),
  );
  await findByText("Learning capture is off");
  expect(
    getByText("This recording is no longer open in OpenBot."),
  ).toBeTruthy();
  expect(getByText(PARKED_LINE)).toBeTruthy();
  expect(getByText("Not into a Learning space")).toBeTruthy();
});

test("a reason that goes on in lower case after its status reads as a sentence of its own", async () => {
  const { findByText } = setup(
    recording({
      capture: {
        ...CAPTURE,
        intelligence: "parked",
        intelligenceReason: PASS_HINTS.INTELLIGENCE_RUNTIME_REQUIRED,
      },
    }),
  );
  await findByText("This OpenBot is not connected to Intelligence.");
});

test("every pass sentence loses its status phrase and starts with a capital", () => {
  for (const hint of Object.values(PASS_HINTS)) {
    const line = stripCaptureStatus(hint);
    expect(line).not.toMatch(/^Learning capture is/);
    expect(line[0]).toBe(line[0]?.toUpperCase());
    expect(hint.endsWith(line.slice(1))).toBe(true);
  }
  expect(
    stripCaptureStatus("This browser was disconnected from OpenBot."),
  ).toBe("This browser was disconnected from OpenBot.");
});

test("unjoined, learning-off and unverified each show their sentence while streaming", async () => {
  const unjoined = setup(
    recording({ learning: { state: "unjoined", containerId: null } }),
  );
  await unjoined.findByText(
    "Learning did not see this recording: OpenBot could not choose its Learning space in time. It still saves to OpenBot.",
  );
  cleanup();
  const off = setup(
    recording({ learning: { state: "learning-off", containerId: null } }),
  );
  await off.findByText(
    /Intelligence's Learning delivery is off or unavailable/,
  );
  expect(off.getByText("Streaming to Intelligence")).toBeTruthy();
  cleanup();
  const unverified = setup(
    recording({ learning: { state: "unverified", containerId: null } }),
  );
  await unverified.findByText(
    /could not check this Bot's Learning space with Intelligence just now/,
  );
});

test("refused and dropped events are counted in the Learning capture row", async () => {
  const { findByText, getByText } = setup(
    recording({
      capture: {
        ...CAPTURE,
        events: { sent: 10, pending: 0, rejected: 3, dropped: 1 },
      },
    }),
  );
  await findByText("3 events were refused by Intelligence");
  expect(getByText("1 event could not be sent")).toBeTruthy();
});

const STOPPED = {
  lastStopped: {
    demonstrationId: "d1",
    botId: "b1",
    openbotUrl: "https://openbot.example.test",
  },
};
const SENDING =
  "Sending the last of the recording to Intelligence and OpenBot. You can keep browsing.";

test("after stop the saved line links to the Bot's Demonstrations page", async () => {
  const { findByRole, findByText } = setup(stateResponse({ state: STOPPED }));
  await findByText("Saved");
  await findByText("Review it in OpenBot to draft the Skill.");
  const link = await findByRole("link");
  expect(link.getAttribute("href")).toBe(
    "https://openbot.example.test/bots/b1/demonstrations",
  );
  fireEvent.click(link);
  await waitFor(() =>
    expect(fake.opened).toContain(
      "https://openbot.example.test/bots/b1/demonstrations",
    ),
  );
});

test("after stop with nothing still sending, the saved line carries the recording's Learning sentence", async () => {
  const { findByText, getByText, queryByText } = setup(
    stateResponse({
      state: {
        ...STOPPED,
        learning: { state: "unjoined", containerId: null },
        draining: 0,
      },
    }),
  );
  await findByText("Review it in OpenBot to draft the Skill.");
  expect(getByText(UNJOINED_SENTENCE)).toBeTruthy();
  expect(queryByText(SENDING)).toBeNull();
});

// What the controller sends after Stop: "finished" puts capture back to IDLE_STATE's, and offscreen.status is ignored
// while idle, so only `draining` and `kept` (from the drains) say what is still sending.
const AFTER_STOP_CAPTURE = IDLE_STATE.capture;

test("after stop with nothing kept, what is still sending says it is sending, never Off", async () => {
  const { findByText, getByText, queryByText } = setup(
    stateResponse({
      state: {
        ...STOPPED,
        capture: AFTER_STOP_CAPTURE,
        draining: 1,
        learning: { state: "unassigned", containerId: null },
      },
    }),
  );
  await findByText(SENDING);
  expect(getByText("Learning capture")).toBeTruthy();
  expect(
    getByText("Sending the rest of this recording to Intelligence"),
  ).toBeTruthy();
  expect(getByText(/this Bot has no Learning space/)).toBeTruthy();
  expect(queryByText("Off")).toBeNull();
  expect(queryByText(/Learning capture is (off|paused)/)).toBeNull();
});

test("after stop, a parked recording still to send says Learning capture is off, why, and that it tries at the next browser start", async () => {
  const { findByText, getByText, queryByText } = setup(
    stateResponse({
      state: {
        ...STOPPED,
        capture: AFTER_STOP_CAPTURE,
        draining: 1,
        kept: {
          recordings: 1,
          events: 12,
          reason: PASS_HINTS.INTELLIGENCE_RUNTIME_REQUIRED,
          parked: true,
        },
        learning: { state: "unassigned", containerId: null },
      },
    }),
  );
  await findByText("Learning capture is off");
  expect(
    getByText("This OpenBot is not connected to Intelligence."),
  ).toBeTruthy();
  expect(getByText(PARKED_LINE)).toBeTruthy();
  expect(getByText(/this Bot has no Learning space/)).toBeTruthy();
  expect(queryByText("Off")).toBeNull();
  // Every drain is kept: nothing is streaming right now.
  expect(queryByText(SENDING)).toBeNull();
});

test("after stop, a held recording still to send says Learning capture is paused, why, and that it tries every 5 minutes", async () => {
  const { findByText, getByText, queryByText } = setup(
    stateResponse({
      state: {
        ...STOPPED,
        capture: AFTER_STOP_CAPTURE,
        draining: 2,
        kept: {
          recordings: 1,
          events: 40,
          reason: PASS_HINTS.TRAJECTORIES_NOT_ENABLED,
          parked: false,
        },
      },
    }),
  );
  await findByText("Learning capture is paused");
  expect(
    getByText(
      "Intelligence says this organization's licence does not include Product Trajectories, that its billing is blocked, or that it could not check right now.",
    ),
  ).toBeTruthy();
  expect(getByText(HELD_LINE)).toBeTruthy();
  expect(queryByText("Off")).toBeNull();
  // One of the two drains is not kept, so it is still streaming.
  expect(getByText(SENDING)).toBeTruthy();
});

const KEPT = {
  recordings: 2,
  events: 40,
  reason: PASS_HINTS.REFUSED.replace("<status>", "503"),
  parked: false,
};

test("kept events are discarded only after the dialog confirms, and Cancel sends nothing", async () => {
  const { findByText, getByRole, queryByText, sent } = setup(
    stateResponse({ state: { ...STOPPED, kept: KEPT, draining: 2 } }),
  );
  await findByText(
    "40 events from 2 recordings are kept in this browser: Intelligence refused the capture pass (503).",
  );
  fireEvent.click(getByRole("button", { name: "Discard kept events" }));
  await findByText(
    /Intelligence will never receive them\. Your recordings in OpenBot stay as they are\./,
  );
  expect(queryByText(/Discard them\?/)).toBeNull();
  fireEvent.click(getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(queryByText(/Intelligence will never receive them/)).toBeNull(),
  );
  expect(sent.some((m) => m.type === "page.kept.discard")).toBe(false);
  fireEvent.click(getByRole("button", { name: "Discard kept events" }));
  fireEvent.click(await findByText("Discard"));
  await waitFor(() =>
    expect(sent.some((m) => m.type === "page.kept.discard")).toBe(true),
  );
});

test("the kept sentence leaves out the status phrase and starts its reason with a capital", async () => {
  const { findByText } = setup(
    stateResponse({
      state: {
        kept: {
          recordings: 1,
          events: 1,
          reason: PASS_HINTS.INTELLIGENCE_RUNTIME_REQUIRED,
          parked: true,
        },
        draining: 1,
      },
    }),
  );
  await findByText(
    "1 event from 1 recording is kept in this browser: This OpenBot is not connected to Intelligence.",
  );
});

const WAITING = (recordings: number, events: number) => ({
  recordings,
  events,
  reason: "This browser was disconnected from OpenBot.",
  parked: true,
  waitingFor: { name: "Ada Lovelace", recordings },
});

test("kept events waiting on a sign-out name the person and how to send them", async () => {
  const { findByText } = setup(
    stateResponse({ state: { kept: WAITING(2, 40), draining: 2 } }),
  );
  await findByText(
    "40 events from 2 recordings by Ada Lovelace are kept in this browser. Connect this browser to OpenBot again as Ada Lovelace to send them.",
  );
});

test("the waiting sentence agrees with one event, and leaves out an event count of 0", async () => {
  const cases = [
    [
      WAITING(1, 1),
      "1 event from 1 recording by Ada Lovelace is kept in this browser. Connect this browser to OpenBot again as Ada Lovelace to send them.",
    ],
    [
      WAITING(1, 0),
      "1 recording by Ada Lovelace is kept in this browser. Connect this browser to OpenBot again as Ada Lovelace to send them.",
    ],
    [
      WAITING(2, 0),
      "2 recordings by Ada Lovelace are kept in this browser. Connect this browser to OpenBot again as Ada Lovelace to send them.",
    ],
  ] as const;
  for (const [kept, sentence] of cases) {
    const { findByText, unmount } = setup(
      stateResponse({ state: { kept, draining: kept.recordings } }),
    );
    await findByText(sentence);
    unmount();
  }
});

test("signed out with recordings kept, the popup says how to send them and Discard asks before it sends page.kept.discard", async () => {
  // What a sign-out leaves (reduceRecorder's "finished", then markWaiting): no connection, the notice, the drain kept.
  const { findByText, getByRole, queryByRole, queryByText, sent } = setup(
    stateResponse({
      ...NOT_CONNECTED,
      notice: { kind: "signed-out", reason: "revoked", at: 1 },
      state: {
        ...STOPPED,
        error:
          "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser until you connect again.",
        kept: WAITING(1, 12),
        draining: 1,
      },
    }),
  );
  await findByText("Connect the Recorder to OpenBot");
  await findByText(
    "12 events from 1 recording by Ada Lovelace are kept in this browser. Connect this browser to OpenBot again as Ada Lovelace to send them.",
  );
  // OpenBot has not heard of the stop yet and nothing can send while signed out: no Saved row, no link, no sending row.
  expect(queryByText("Saved")).toBeNull();
  expect(queryByRole("link")).toBeNull();
  expect(queryByText(SENDING)).toBeNull();
  fireEvent.click(getByRole("button", { name: "Discard kept events" }));
  await findByText(/Intelligence will never receive them/);
  expect(sent.some((m) => m.type === "page.kept.discard")).toBe(false);
  fireEvent.click(getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(queryByText(/Intelligence will never receive them/)).toBeNull(),
  );
  expect(sent.some((m) => m.type === "page.kept.discard")).toBe(false);
  fireEvent.click(getByRole("button", { name: "Discard kept events" }));
  fireEvent.click(await findByText("Discard"));
  await waitFor(() =>
    expect(sent.some((m) => m.type === "page.kept.discard")).toBe(true),
  );
});

const STOP_PENDING =
  "Stopping: OpenBot did not answer yet. Your steps are kept in this browser and sent when it does.";

test("signed out, a Start-over drain that is not kept shows only the kept row: nothing is sending", async () => {
  const { findByText, queryByText } = setup(
    stateResponse({
      ...NOT_CONNECTED,
      state: { draining: 2, kept: WAITING(1, 12) },
    }),
  );
  await findByText(
    "12 events from 1 recording by Ada Lovelace are kept in this browser. Connect this browser to OpenBot again as Ada Lovelace to send them.",
  );
  expect(queryByText(SENDING)).toBeNull();
  expect(queryByText("Learning capture")).toBeNull();
  expect(queryByText(/Sending the rest/)).toBeNull();
});

test("after a Start over that could not open the new recording, the popup shows the failure and nothing as saved", async () => {
  // What the controller leaves (reduceRecorder's "finished" with no lastStopped): the old recording drains to be deleted.
  const failure = "OpenBot is busy. Try again.";
  const { findByText, getByRole, queryByRole, queryByText } = setup(
    stateResponse({ state: { botId: "b1", error: failure, draining: 1 } }),
  );
  await findByText(failure);
  expect(queryByText("Saved")).toBeNull();
  expect(queryByText("Review it in OpenBot to draft the Skill.")).toBeNull();
  expect(queryByRole("link")).toBeNull();
  expect(getByRole("button", { name: "Record" })).toBeTruthy();
});

test("after stop, a pending stop says it is sending only while Intelligence is still sent the recording", async () => {
  const pending = {
    ...STOPPED,
    capture: AFTER_STOP_CAPTURE,
    error: STOP_PENDING,
    draining: 1,
  };
  // Still streaming: the sending lines stay beside the stop sentence.
  const streaming = setup(stateResponse({ state: pending }));
  await streaming.findByText(STOP_PENDING);
  expect(streaming.getByText(SENDING)).toBeTruthy();
  expect(
    streaming.getByText("Sending the rest of this recording to Intelligence"),
  ).toBeTruthy();
  streaming.unmount();
  // Intelligence has all of it and only OpenBot's answer to the stop is owed: the stop sentence says so, alone.
  const waiting = setup(stateResponse({ state: { ...pending, streamed: 1 } }));
  await waiting.findByText(STOP_PENDING);
  expect(waiting.queryByText(SENDING)).toBeNull();
  expect(waiting.queryByText(/Sending the rest/)).toBeNull();
  expect(waiting.queryByText("Learning capture")).toBeNull();
  expect(waiting.queryByText("Saved")).toBeNull();
});

test("a pending stop shows its sentence and no Record button when its Bot is the only one", async () => {
  const { findByText, queryByRole, queryByText } = setup(
    stateResponse({ state: { ...STOPPED, botId: "b1", error: STOP_PENDING } }),
    { bots: [BOTS[0] as RecorderBot] },
  );
  await findByText(STOP_PENDING);
  expect(queryByText("Saved")).toBeNull();
  expect(queryByRole("button", { name: "Record" })).toBeNull();
});

test("a pending stop holds back Record only for its own Bot: another Bot still offers Record", async () => {
  const { findByText, findByRole, getByRole, queryByRole, queryByText } = setup(
    stateResponse({ state: { ...STOPPED, botId: "b1", error: STOP_PENDING } }),
    { lastBotId: "b1" },
  );
  await findByText(STOP_PENDING);
  expect(queryByText("Saved")).toBeNull();
  const picker = await findByRole("combobox", { name: "Bot" });
  await waitFor(() => expect(picker.textContent).toContain("Support Bot"));
  expect(getByRole("button", { name: "Record" })).toBeTruthy();
  const user = userEvent.setup({ document });
  await user.click(picker);
  await findByRole("option", { name: "Support Bot" });
  expect(queryByRole("option", { name: "Billing Bot" })).toBeNull();
});
