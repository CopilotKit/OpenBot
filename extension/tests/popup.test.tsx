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
import { Popup } from "../src/pages/popup/popup";
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
    prepared?:
      | { ok: true; microphone: boolean }
      | { ok: false; reason: "permission" };
    answers?: Partial<Record<PageToBackground["type"], PageResponse>>;
    microphone?: "granted" | "prompt" | "denied";
    lastBotId?: string;
  } = {},
) {
  const sent: PageToBackground[] = [];
  let prepareCalls = 0;
  const ask = async (message: PageToBackground): Promise<PageResponse> => {
    sent.push(message);
    const fixed = options.answers?.[message.type];
    if (fixed) return fixed;
    if (message.type === "page.state") return response;
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
          return options.prepared ?? { ok: true, microphone: true };
        },
        activeTabId: async () => 7,
        microphoneState: async () => options.microphone ?? "granted",
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
      "Records this tab's screen, your voice, clicks, typing and the network calls behind each page. Passwords and secrets stay in your browser.",
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

test("Record prepares, then sends page.record with the Bot, title, tab and microphone and no stream id", async () => {
  const { findByLabelText, getByRole, sent, prepareCalls } = setup(
    stateResponse(),
    { prepared: { ok: true, microphone: false } },
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
      microphone: false,
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

test("the no-transcription line appears only when the OpenBot cannot transcribe", async () => {
  const line =
    "This OpenBot does not transcribe voice. The screen recording still keeps the sound.";
  const off = setup(
    stateResponse({
      me: {
        user: { id: "u1", name: "Ada", email: "a@example.test" },
        connectionId: "k1",
        capabilities: { transcription: false },
      } as PageStateResponse["me"],
    }),
  );
  await off.findByText(line);
  cleanup();
  const on = setup(stateResponse());
  await on.findByText("Ada Lovelace");
  expect(on.queryByText(line)).toBeNull();
});

test("Allow microphone shows only while the microphone is not granted and opens microphone.html", async () => {
  const granted = setup(stateResponse(), { microphone: "granted" });
  await granted.findByText("Ada Lovelace");
  expect(granted.queryByText("Allow microphone")).toBeNull();
  cleanup();
  const prompt = setup(stateResponse(), { microphone: "prompt" });
  fireEvent.click(await prompt.findByText("Allow microphone"));
  await waitFor(() => expect(fake.opened.join()).toContain("microphone.html"));
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
      microphone: true,
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
