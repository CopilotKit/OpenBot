import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { RECORDER_COLLECTS } from "@openbot/shared/recorder-disclosure";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SetupPage, type SetupPageDeps } from "../src/pages/setup/setup-page";
import { DISCLOSURE } from "../src/pages/ui/disclosure";
import {
  fakeSpeech,
  type OnDeviceModel,
  onDeviceModel,
} from "./support/fake-speech";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

let originalMatchMedia: typeof window.matchMedia;
beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

type Options = {
  /** What Chrome reports before any request, then after each one. */
  states?: PermissionState[];
  /** What each getUserMedia call throws (a DOMException name), or null to hand back a stream. */
  refusals?: (string | null)[];
  edge?: boolean;
  /** The person's narration choice as the Recorder keeps it: on, as for someone who chose it, unless a test says. */
  narration?: "on" | "off" | null;
  /** What the browser can recognise on the computer; null for one with no on-device recognition at all. */
  onDevice?: OnDeviceModel | null;
};

function setup(options: Options = {}) {
  const states = [...(options.states ?? ["prompt", "granted"])];
  const refusals = [...(options.refusals ?? [null])];
  const calls: string[] = [];
  let stopped = 0;
  const deps: SetupPageDeps = {
    getUserMedia: async (constraints) => {
      calls.push(`getUserMedia ${JSON.stringify(constraints)}`);
      const refusal = refusals.length > 1 ? refusals.shift() : refusals[0];
      if (refusal) throw new DOMException("no", refusal);
      return {
        getTracks: () => [{ stop: () => stopped++ }],
      } as unknown as MediaStream;
    },
    microphoneState: async () =>
      (states.length > 1 ? states.shift() : states[0]) ?? null,
    isEdge: () => options.edge ?? false,
    Recognition: fakeSpeech(
      options.onDevice === undefined
        ? onDeviceModel({ "en-US": "installed" }, { unmasked: true })
        : options.onDevice,
    ).Recognition,
    language: () => "en-US",
    narration: async () =>
      options.narration === undefined ? "on" : options.narration,
    setNarration: async (on) => {
      choices.push(on);
    },
    downloadPollMs: 10,
  };
  const choices: boolean[] = [];
  return {
    calls,
    choices,
    stopped: () => stopped,
    ...render(<SetupPage deps={deps} />),
  };
}

test("says what the Recorder collects and where it goes, first, whatever the browser answers about the microphone", async () => {
  // The Chrome Web Store's prominent disclosure: the page a fresh install opens, read before anything is recorded.
  for (const states of [
    ["prompt", "granted"],
    ["granted"],
    ["denied"],
  ] as PermissionState[][]) {
    const { getByText, getByRole, findByText, container } = setup({ states });
    const title = getByText("What the Recorder collects");
    const disclosure = getByText(DISCLOSURE);
    expect(disclosure.textContent).toContain("When you press Record");
    // Where it goes: straight to the organization's own Intelligence, with OpenBot's pass, never through OpenBot.
    expect(disclosure.textContent).toContain(
      "What you record goes straight from your browser to your organization's own Intelligence, with a pass from your organization's OpenBot. OpenBot is told that you are recording, the task's name, when it started and how many steps it has, and when you record in a browser shown inside OpenBot, your narration passes through it to the Recorder without being stored. Your recordings are used only for your organization's Skills, evaluations and insights.",
    );
    // Then everything a recording holds, the saves and AI assistant conversations among them, before the microphone.
    for (const { title: held, description } of RECORDER_COLLECTS) {
      expect(getByText(held)).toBeTruthy();
      expect(getByText(description)).toBeTruthy();
    }
    expect(
      getByText(/the request it sent and the answer that came back/),
    ).toBeTruthy();
    expect(getByText(/including the messages you send/)).toBeTruthy();
    // The first thing on the page, as its heading, above everything about the microphone: end-to-end run 8 found it
    // under "Allow the microphone" and its explanation.
    expect(getByRole("heading", { level: 1 }).textContent).toBe(
      "What the Recorder collects",
    );
    expect(container.textContent).toStartWith(
      `What the Recorder collects${DISCLOSURE}`,
    );
    for (const microphone of [
      getByText("Narration", { selector: "h2" }),
      getByText(/^Talk through what you do while you record,/),
      await findByText("Microphone"),
    ])
      expect(
        title.compareDocumentPosition(microphone) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    await findByText(states.at(-1) === "denied" ? /^Blocked\./ : /^Allowed\./);
    cleanup();
  }
});

test("says the words are turned into text on the person's own computer, and how to answer the prompt", async () => {
  // A prompt answered for this visit only: the page still says how to answer it.
  const { getByText, findByText } = setup({ states: ["prompt", "prompt"] });
  expect(getByText("Narration", { selector: "h2" })).toBeTruthy();
  expect(
    getByText(
      /Your browser turns your words into text on your own computer: your voice never leaves it, and the Recorder keeps no recording of it\./,
    ),
  ).toBeTruthy();
  expect(
    await findByText(
      "Chrome turns your American English speech into text on your computer. Your voice never leaves it.",
    ),
  ).toBeTruthy();
  expect(await findByText(/choose Allow while visiting the site/)).toBeTruthy();
  await findByText(/^Allowed for this visit only,/);
});

test("with no choice made, nothing is asked for until the person chooses, and Not now keeps the microphone closed", async () => {
  const view = setup({ narration: null });
  expect(
    await view.findByText(
      "Choose whether the Recorder listens to you while you record. You can change it before any recording.",
    ),
  ).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.calls).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  expect(view.choices).toEqual([false]);
  expect(
    await view.findByText("Off. The Recorder never opens your microphone."),
  ).toBeTruthy();
  expect(view.calls).toEqual([]);
  expect(
    view
      .getByRole("switch", { name: "Narration" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("Turn on narration asks, on that one click, for the speech recognition and the microphone", async () => {
  // Chrome answers downloadable for any language this origin has not asked for yet, and downloads only on a click.
  const model = onDeviceModel({ "en-US": "downloadable" });
  document.addEventListener(
    "click",
    () => {
      model.activation = true;
    },
    { capture: true, once: true },
  );
  const view = setup({ narration: null, onDevice: model });
  fireEvent.click(
    await view.findByRole("button", { name: "Turn on narration" }),
  );
  expect(view.choices).toEqual([true]);
  expect(model.installs).toEqual(["en-US"]);
  expect(
    await view.findByText(
      "Downloading Chrome's American English speech recognition to your computer",
    ),
  ).toBeTruthy();
  await view.findByText(/^Allowed\./);
  expect(view.calls).toEqual([
    `getUserMedia ${JSON.stringify({ audio: true })}`,
  ]);
  // Asked again while it downloads; once it is on the computer the row says so.
  model.finishDownloads();
  expect(
    await view.findByText(
      "Chrome turns your American English speech into text on your computer. Your voice never leaves it.",
    ),
  ).toBeTruthy();
});

test("a language still to be downloaded offers Download; a browser that cannot keep speech on the computer says so", async () => {
  const model = onDeviceModel({ "en-US": "downloadable" });
  const pack = setup({ onDevice: model });
  await pack.findByText(
    "Chrome has to download its American English speech recognition to your computer first. Choose Download.",
  );
  model.activation = true;
  fireEvent.click(pack.getByRole("button", { name: "Download" }));
  expect(model.installs).toEqual(["en-US"]);
  pack.unmount();

  const none = setup({ onDevice: null });
  expect(
    await none.findByText(
      "This version of Chrome cannot turn speech into text on your computer, so the Recorder cannot narrate here. It still records.",
    ),
  ).toBeTruthy();
  none.unmount();

  const welsh = setup({ onDevice: onDeviceModel({ "fr-FR": "installed" }) });
  expect(
    await welsh.findByText(
      "Chrome cannot turn American English speech into text on your computer, so the Recorder cannot narrate here. It still records.",
    ),
  ).toBeTruthy();
});

test("in Edge, whose prompt shows only Block and Allow, it says to choose Allow", async () => {
  const { findByText } = setup({
    states: ["prompt", "prompt"],
    edge: true,
  });
  expect(
    await findByText(
      "When Edge asks, choose Allow: the Recorder listens from a page you do not see, which can use only a lasting grant.",
    ),
  ).toBeTruthy();
  await findByText(
    "Allowed for this visit only, so the Recorder could not listen while you record. Choose Allow microphone and pick Allow.",
  );
});

test("asks as soon as it opens, with no click: granted lets go of the microphone and says so", async () => {
  const { findByText, calls, stopped, queryByRole } = setup();
  expect(
    await findByText(
      "Allowed. You can close this tab and press Record in the Recorder whenever you are ready.",
    ),
  ).toBeTruthy();
  expect(calls).toEqual([`getUserMedia ${JSON.stringify({ audio: true })}`]);
  expect(stopped()).toBe(1);
  expect(queryByRole("button", { name: "Allow microphone" })).toBeNull();
});

test("already allowed: says so without opening the microphone again", async () => {
  const { findByText, calls } = setup({ states: ["granted"] });
  await findByText(/^Allowed\./);
  expect(calls).toEqual([]);
});

test("a dismissed prompt says nothing is allowed yet, and the button asks again", async () => {
  const { findByText, getByRole, calls } = setup({
    states: ["prompt", "prompt", "granted"],
    refusals: ["NotAllowedError", null],
  });
  await findByText(
    "Not allowed yet. Choose Allow microphone and answer the browser's prompt.",
  );
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  await findByText(/^Allowed\./);
  expect(calls).toHaveLength(2);
});

test("visit-only: a grant that reads prompt afterwards says so and offers the button", async () => {
  const { findByText, getByRole } = setup({ states: ["prompt", "prompt"] });
  await findByText(
    "Allowed for this visit only, so the Recorder could not listen while you record. Choose Allow microphone and pick Allow while visiting the site.",
  );
  expect(getByRole("button", { name: "Allow microphone" })).toBeTruthy();
});

test("blocked: names the browser's own settings page, Chrome's or Edge's", async () => {
  for (const [edge, scheme] of [
    [false, "chrome"],
    [true, "edge"],
  ] as const) {
    const { findByText, getByRole, queryByText, calls, unmount } = setup({
      states: ["denied"],
      refusals: ["NotAllowedError"],
      edge,
    });
    await findByText(
      `Blocked. Open ${scheme}://settings/content/microphone, allow OpenBot Recorder, then choose Allow microphone.`,
    );
    // A blocked microphone shows no prompt, so the page does not ask on its own, nor says how to answer one.
    expect(calls).toEqual([]);
    expect(queryByText(/asks, choose Allow/)).toBeNull();
    await waitFor(() =>
      expect(
        (
          getByRole("button", {
            name: "Allow microphone",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    unmount();
  }
});

test("no microphone: says so in plain words", async () => {
  const { findByText } = setup({
    states: ["prompt", "prompt"],
    refusals: ["NotFoundError"],
  });
  await findByText(
    "No microphone was found, or another app is using it. Connect one, then choose Allow microphone.",
  );
});
