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
import { desktopSentence } from "../src/pages/popup/desktop-sentence";
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
    prepared?:
      | { ok: true }
      | { ok: false; reason: "permission" }
      | { ok: false; reason: "microphone" };
    answers?: Partial<Record<PageToBackground["type"], PageResponse>>;
    lastBotId?: string;
    pageLanguage?: string | null;
    browserLanguage?: string;
    microphone?: PermissionState | null;
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
        pageLanguage: async (tabId) =>
          tabId === 7 ? (options.pageLanguage ?? null) : null,
        browserLanguage: () => options.browserLanguage ?? "en-GB",
        microphoneState: async () => options.microphone ?? null,
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

test("a Desktop connect that fails after a good ping shows a plain sentence for the host's code", async () => {
  const { findByText, findByRole } = setup(stateResponse(NOT_CONNECTED), {
    desktop: true,
    answers: {
      "page.connect.desktop": {
        ok: true,
        offered: false,
        reason: "not-signed-in",
      },
    },
  });
  fireEvent.click(await findByText("Connect with OpenBot Desktop"));
  expect((await findByRole("alert")).textContent).toBe(
    "OpenBot Desktop is not signed in to your organization. Sign in again in OpenBot Desktop, then try again.",
  );
});

test("every code OpenBot Desktop or the Recorder can give has a sentence of its own", () => {
  const general = desktopSentence("something-new");
  const codes = [
    "origin-not-allowed",
    "not-installed",
    "not-running",
    "not-signed-in",
    "organization-unavailable",
    "handoff-failed",
    "timed-out",
    "host-failed",
    "unknown-message",
    "no-answer",
    "policy-invalid",
    "pinned-elsewhere",
    "invalid-address",
  ];
  const sentences = codes.map(desktopSentence);
  for (const sentence of sentences) expect(sentence).not.toBe(general);
  expect(new Set(sentences).size).toBe(codes.length);
  expect(desktopSentence("toString")).toBe(general);
});

test("a Desktop code the Recorder does not know gets the general sentence", async () => {
  const { findByText, findByRole } = setup(stateResponse(NOT_CONNECTED), {
    desktop: true,
    answers: {
      "page.connect.desktop": {
        ok: true,
        offered: false,
        reason: "something-new",
      },
    },
  });
  fireEvent.click(await findByText("Connect with OpenBot Desktop"));
  expect((await findByRole("alert")).textContent).toBe(
    "OpenBot Desktop could not connect this browser. Try again, or connect from OpenBot in your browser.",
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
      "Records your clicks, typing, the pages you open, the network calls behind them and what you say as you go. Passwords and secrets stay in your browser.",
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

test("Record prepares, then sends page.record with the Bot, title, tab and the page's language", async () => {
  const { findByLabelText, getByRole, sent, prepareCalls } = setup(
    stateResponse(),
    { pageLanguage: "de-DE" },
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
      language: "de-DE",
    }),
  );
  expect(prepareCalls()).toBe(1);
});

test("a page that declares no usable language narrates in the browser's", async () => {
  for (const pageLanguage of [null, "", "x-klingon"]) {
    const { findByLabelText, getByRole, sent, unmount } = setup(
      stateResponse(),
      { pageLanguage, browserLanguage: "fr-CA" },
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
      expect(sent.find((m) => m.type === "page.record")).toMatchObject({
        language: "fr-CA",
      }),
    );
    unmount();
  }
});

test("the first Record that opens the microphone page says to allow it there and records nothing yet", async () => {
  const { findByLabelText, getByRole, findByText, sent } = setup(
    stateResponse(),
    { prepared: { ok: false, reason: "microphone" } },
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
  await findByText(
    "Allow the microphone in the tab that opened, then press Record again.",
  );
  expect(sent.some((m) => m.type === "page.record")).toBe(false);
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
    "Learning will not see this recording: this Bot has no Learning space. It still goes to Intelligence.",
  );
  expect(getByRole("combobox", { name: "Bot" }).textContent).toContain(
    "Support Bot",
  );
});

const SENTENCES: [RecorderBot["learning"]["state"], string | null][] = [
  ["assigned", null],
  [
    "unassigned",
    "Learning will not see this recording: this Bot has no Learning space. It still goes to Intelligence.",
  ],
  [
    "missing",
    "Learning will not see this recording: this Bot's Learning space does not exist in Intelligence. Ask an administrator to fix it in Admin, Automatic Learning. It still goes to Intelligence.",
  ],
  [
    "learning-off",
    "Learning may not see this recording: Intelligence's Learning delivery is off or unavailable, so OpenBot could not check this Bot's Learning space. It still goes to Intelligence.",
  ],
  [
    "unverified",
    "Learning may not see this recording: OpenBot could not check this Bot's Learning space with Intelligence just now. It still goes to Intelligence.",
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

test("after Stop the Learning sentence shows once, in the sent row, not again under the picker", async () => {
  const sentence = SENTENCES.find(([kind]) => kind === "learning-off")?.[1];
  const off = learning("learning-off");
  const { findByText, container } = setup(
    stateResponse({
      state: {
        lastStopped: { recordingId: "r1", botId: "b1" },
        learning: off,
      },
    }),
    {
      bots: [{ id: "b1", name: "Refund Clerk", learning: off }],
      lastBotId: "b1",
    },
  );
  await findByText("Sent to Intelligence");
  await findByText("Recorded for Refund Clerk.");
  expect(container.textContent?.split(sentence ?? "").length).toBe(2);
});

test("the popup asks for nothing about the screen, and offers the microphone page only when Chrome refused it", async () => {
  for (const microphone of [null, "granted", "prompt"] as const) {
    const { findByText, container, queryByRole, unmount } = setup(
      stateResponse(),
      { microphone },
    );
    await findByText("Ada Lovelace");
    expect(container.textContent).not.toMatch(/microphone|screen/i);
    expect(queryByRole("button", { name: "Allow microphone" })).toBeNull();
    unmount();
  }
  const { findByRole } = setup(stateResponse(), {
    microphone: "denied",
  });
  fireEvent.click(await findByRole("button", { name: "Allow microphone" }));
  expect(fake.opened).toEqual([chrome.runtime.getURL("microphone.html")]);
});

test("each notice renders its sentence and dismisses", async () => {
  const notices = [
    [
      { kind: "interrupted", at: 1 },
      "Your last recording stopped when the browser closed. Everything recorded until then goes to Intelligence.",
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
      recordingId: "r7",
      botId: "b1",
      title: "Refund an order",
      startedAt: Date.now() - 65_000,
      actions: 12,
      capture: { ...CAPTURE },
      ...state,
    },
  });

test("the recording view shows the time, the action count and the Learning capture and Network rows, and Voice only for a recording with voice", async () => {
  const { findByText, getByText, queryByText, queryByRole } = setup(
    recording(),
  );
  await findByText("1:05 · 12 actions");
  for (const title of ["Learning capture", "Network"]) {
    expect(getByText(title)).toBeTruthy();
  }
  for (const title of ["Screen", "Voice"])
    expect(queryByText(title)).toBeNull();
  expect(getByText("Streaming to Intelligence")).toBeTruthy();
  expect(queryByRole("button", { name: "Record" })).toBeNull();
  expect(queryByRole("button", { name: "Record screen" })).toBeNull();
});

const voiceRecording = (
  voice: NonNullable<RecorderState["capture"]["voice"]>,
) => recording({ capture: { ...CAPTURE, voice } });

test("while listening the Voice row says so, shows the last words heard, and its switch mutes the narration", async () => {
  const { findByText, getByText, getByRole, sent } = setup(
    voiceRecording({
      state: "listening",
      heard: "I am opening the order page",
    }),
  );
  await findByText("Voice");
  expect(getByText("Listening")).toBeTruthy();
  expect(getByText("“I am opening the order page”")).toBeTruthy();
  const toggle = getByRole("switch", { name: "Voice" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(sent.find((m) => m.type === "page.voice")).toEqual({
      type: "page.voice",
      muted: true,
    }),
  );
});

test("listening to speech that never comes back as words, the Voice row says so and stays on", async () => {
  const sentence =
    "This browser is not turning your speech into words. Recording carries on without narration.";
  const { findByText, getByText, getByRole } = setup(
    voiceRecording({ state: "listening", reason: sentence }),
  );
  await findByText(sentence);
  expect(getByText("Listening")).toBeTruthy();
  expect(
    getByRole("switch", { name: "Voice" }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("muted, the switch is off and turning it on unmutes; starting shows it on", async () => {
  const muted = setup(voiceRecording({ state: "muted" }));
  await muted.findByText("Muted. Turn it on to narrate what you do.");
  const toggle = muted.getByRole("switch", { name: "Voice" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(muted.sent.find((m) => m.type === "page.voice")).toEqual({
      type: "page.voice",
      muted: false,
    }),
  );
  muted.unmount();
  const starting = setup(voiceRecording({ state: "starting" }));
  await starting.findByText("Starting the microphone");
  expect(
    starting
      .getByRole("switch", { name: "Voice" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("a microphone Chrome refused says so in a plain sentence and offers the microphone page; other failures say theirs", async () => {
  const refused = setup(
    voiceRecording({
      state: "failed",
      problem: "microphone",
      reason:
        "Chrome has not let the Recorder use the microphone. Recording goes on without your voice.",
      heard: "stale words",
    }),
  );
  await refused.findByText(
    "Chrome has not let the Recorder use the microphone. Recording goes on without your voice.",
  );
  expect(refused.queryByText(/stale words/)).toBeNull();
  expect(
    refused.getByRole("switch", { name: "Voice" }).getAttribute("aria-checked"),
  ).toBe("false");
  fireEvent.click(refused.getByRole("button", { name: "Allow microphone" }));
  expect(fake.opened).toEqual([chrome.runtime.getURL("microphone.html")]);
  refused.unmount();

  const network = setup(
    voiceRecording({
      state: "failed",
      problem: "network",
      reason:
        "Chrome's speech service cannot be reached. Recording goes on, and voice tries again in a moment.",
    }),
  );
  await network.findByText(
    "Chrome's speech service cannot be reached. Recording goes on, and voice tries again in a moment.",
  );
  expect(
    network.queryByRole("button", { name: "Allow microphone" }),
  ).toBeNull();
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

test("the 50-action card shows only while the controller says the notice is open", async () => {
  const closed = setup(
    recording({
      actions: 50,
      noticeShown: true,
      noticeOpen: false,
      noticeAt: 50,
    }),
  );
  await closed.findByText("1:05 · 50 actions");
  expect(closed.queryByText("You have recorded 50 or more actions")).toBeNull();
  expect(closed.queryByRole("button", { name: "Keep going" })).toBeNull();
  closed.unmount();
  const open = setup(
    recording({
      actions: 50,
      noticeShown: true,
      noticeOpen: true,
      noticeAt: 50,
    }),
  );
  await open.findByText("You have recorded 50 or more actions");
  expect(open.getByRole("button", { name: "Keep going" })).toBeTruthy();
});

test("Keep going on the page takes the card out of the popup at the next page.state", async () => {
  const response = recording({
    actions: 50,
    noticeShown: true,
    noticeOpen: true,
    noticeAt: 50,
  });
  const { findByText, getByRole, queryByText, sent } = setup(response);
  await findByText("You have recorded 50 or more actions");
  // The person answers the overlay in the tab: the controller closes the notice, and the popup's poll sees it.
  response.state.noticeOpen = false;
  await waitFor(
    () =>
      expect(queryByText("You have recorded 50 or more actions")).toBeNull(),
    { timeout: 3000 },
  );
  expect(sent.some((m) => m.type === "page.notice")).toBe(false);
  expect(getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("at 50 actions with the notice open the popup repeats its three choices, and Keep going hides the card", async () => {
  const response = recording({
    actions: 50,
    noticeShown: true,
    noticeOpen: true,
    noticeAt: 50,
  });
  const { findByText, getByRole, queryByText, sent } = setup(response, {
    onAsk: closesNotice(response),
  });
  await findByText("You have recorded 50 or more actions");
  fireEvent.click(getByRole("button", { name: "Keep going" }));
  await waitFor(() =>
    expect(sent.filter((m) => m.type === "page.notice").at(-1)).toMatchObject({
      choice: "continue",
    }),
  );
  await waitFor(() =>
    expect(queryByText("You have recorded 50 or more actions")).toBeNull(),
  );
  expect(getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("the 50-action card's Stop and Start over hide it too", async () => {
  for (const [name, choice] of [
    ["Stop", "stop"],
    ["Start over", "restart"],
  ] as const) {
    const response = recording({
      actions: 52,
      noticeShown: true,
      noticeOpen: true,
      noticeAt: 50,
    });
    const { findByText, getAllByRole, queryByText, sent, unmount } = setup(
      response,
      { onAsk: closesNotice(response) },
    );
    const card = (
      await findByText("You have recorded 50 or more actions")
    ).closest("[data-slot=item]") as HTMLElement;
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
      expect(queryByText("You have recorded 50 or more actions")).toBeNull(),
    );
    unmount();
  }
});

test("Keep going hides the card for that recording only: the next one to reach 50 actions shows it again", async () => {
  const response = recording({
    actions: 50,
    noticeShown: true,
    noticeOpen: true,
    noticeAt: 50,
  });
  const { findByText, getByRole, queryByText } = setup(response, {
    onAsk: closesNotice(response),
  });
  await findByText("You have recorded 50 or more actions");
  fireEvent.click(getByRole("button", { name: "Keep going" }));
  await waitFor(() =>
    expect(queryByText("You have recorded 50 or more actions")).toBeNull(),
  );
  // The popup polls page.state while a recording runs: the next answer is another recording whose notice opened.
  Object.assign(response.state, {
    recordingId: "r8",
    actions: 50,
    noticeOpen: true,
  });
  await findByText(
    "You have recorded 50 or more actions",
    {},
    {
      timeout: 3000,
    },
  );
});

test("Stop and Start over are pinned to the bottom of the popup, so a tall notice never pushes them past Chrome's 600px", async () => {
  const { findByText, getAllByRole } = setup(
    recording({
      actions: 50,
      noticeShown: true,
      noticeOpen: true,
      noticeAt: 50,
    }),
  );
  await findByText("You have recorded 50 or more actions");
  const stop = getAllByRole("button", { name: "Stop" }).at(-1) as HTMLElement;
  const bar = stop.parentElement as HTMLElement;
  expect(bar.className).toContain("sticky");
  expect(bar.className).toContain("bottom-0");
  expect(bar.className).toContain("bg-background");
  expect(bar.textContent).toBe("StopStart over");
});

test("the card says the count the notice opened at, in the page notice's words, while the count goes on", async () => {
  const { findByText, getByText } = setup(
    recording({
      actions: 147,
      noticeShown: true,
      noticeOpen: true,
      noticeAt: 50,
    }),
  );
  await findByText("You have recorded 50 or more actions");
  expect(getByText("1:05 · 147 actions")).toBeTruthy();
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
  expect(queryByText("Off")).toBeNull();
});

test("a held recording outside a Learning space keeps the pause, its reason and the kept line beside Not into a Learning space", async () => {
  const { findByText, getByText } = setup(
    recording({
      learning: { state: "unassigned", containerId: null },
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
  expect(getByText(/this Bot has no Learning space/)).toBeTruthy();
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
    getByText("OpenBot does not offer you this recording's Bot any more."),
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

test("learning-off and unverified each show their sentence while streaming", async () => {
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

const STOPPED = { lastStopped: { recordingId: "r1", botId: "b1" } };
const SENDING =
  "The rest of the recording is on its way. You can keep browsing.";

test("after stop with nothing still sending, the popup says the recording went to Intelligence and into the Bot's Learning space", async () => {
  const { findByText, getByText, queryByText, queryByRole } = setup(
    stateResponse({
      state: { ...STOPPED, learning: learning("assigned"), draining: 0 },
    }),
  );
  await findByText("Sent to Intelligence");
  await findByText("Recorded for Billing Bot.");
  expect(getByText("It goes into this Bot's Learning space.")).toBeTruthy();
  expect(queryByText(SENDING)).toBeNull();
  // Nothing about OpenBot keeping it or drafting from it, and nothing to open there.
  expect(queryByText(/Review it in OpenBot|Saved|draft/)).toBeNull();
  expect(queryByRole("link")).toBeNull();
});

test("after stop, a Bot outside a Learning space says Learning will not see the recording, and that it still went to Intelligence", async () => {
  const { findByText, getByText } = setup(
    stateResponse({
      state: {
        lastStopped: { recordingId: "r1", botId: "b2" },
        learning: learning("unassigned"),
        draining: 0,
      },
    }),
  );
  await findByText("Sent to Intelligence");
  await findByText("Recorded for Support Bot.");
  expect(
    getByText(
      "Learning will not see this recording: this Bot has no Learning space. It still goes to Intelligence.",
    ),
  ).toBeTruthy();
});

// What the controller sends after Stop: "finished" puts capture back to IDLE_STATE's, and offscreen.status is ignored
// while idle, so only `draining` and `kept` (from the drains) say what is still sending.
const AFTER_STOP_CAPTURE = IDLE_STATE.capture;

test("after stop with nothing kept, what is still sending says it is sending to Intelligence, never Off", async () => {
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
  await findByText("Sending to Intelligence");
  expect(getByText(SENDING)).toBeTruthy();
  expect(getByText(/this Bot has no Learning space/)).toBeTruthy();
  expect(queryByText("Sent to Intelligence")).toBeNull();
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
  await findByText("Intelligence will never receive them.");
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
  // Nothing can send while signed out: no sent row, no sending row.
  expect(queryByText("Sent to Intelligence")).toBeNull();
  expect(queryByText("Sending to Intelligence")).toBeNull();
  expect(queryByRole("link")).toBeNull();
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
  expect(queryByText("Sending to Intelligence")).toBeNull();
});
