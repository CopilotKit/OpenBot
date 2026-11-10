import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { deploymentKeys } from "@/lib/deployment/queries";
import { liveDictationSource, liveProblem } from "@/lib/dictation/live";
import * as recording from "@/lib/dictation/recording";
import type { DesktopSpeechEvent } from "@/lib/desktop/speech";
import { queryClient } from "@/query-client";
import { installChrome } from "./browser-narration.fixture";
import {
  type DesktopShellOptions,
  installDesktopShell,
  removeDesktopShell,
} from "./desktop-shell.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * DICTATION WITHOUT A TRANSCRIPTION PROVIDER. Every OpenBot shows the microphone: the Desktop window
 * listens through the desktop app's on-device recognizer (desktop/src-tauri/src/speech.rs, faked here by
 * the same channel contract the real commands keep), and a browser through its Web Speech API (replayed
 * from a recorded Chrome run). Words stream into the box; Stop or Enter stops listening and keeps them;
 * the next Enter sends.
 */

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://127.0.0.1/",
    settings: { navigator: { userAgent: MAC } },
  }),
);
afterEach(() => {
  cleanup();
  queryClient.clear();
  removeDesktopShell();
  const speech = globalThis as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  delete speech.SpeechRecognition;
  delete speech.webkitSpeechRecognition;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const said = (index: number, text: string, final = false) =>
  ({ type: "result", index, text, final }) satisfies DesktopSpeechEvent;

function noProvider() {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    transcription: false,
  });
}

function renderComposer(compact: boolean, sent: string[]) {
  const view = render(
    <Composer
      compact={compact}
      initialValue="Existing draft"
      onSubmit={(draft) => {
        sent.push(draft.text);
      }}
    />,
  );
  const box = () => view.getByRole("textbox", { name: "Message" });
  const enter = () => fireEvent.keyDown(box(), { key: "Enter" });
  return { view, box, enter };
}

const desktop: DesktopShellOptions = {
  heard: [said(0, "book a"), said(0, "book a table"), said(1, "for two")],
  atStop: [said(1, "for two tonight", true)],
};

for (const compact of [true, false]) {
  test(`${compact ? "compact" : "default"} desktop: words stream in, Enter stops and keeps them, the next Enter sends`, async () => {
    noProvider();
    const { calls } = installDesktopShell(desktop);
    const sent: string[] = [];
    const { view, box, enter } = renderComposer(compact, sent);

    // The microphone shows with text already in the box.
    fireEvent.click(
      await view.findByRole("button", { name: "Dictate a message" }),
    );
    // The microphone is now Stop, and the box stays on screen with the words in it.
    await waitFor(() =>
      expect(box().textContent).toBe("Existing draft book a table for two"),
    );
    expect(view.getByRole("button", { name: "Stop dictation" })).toBeDefined();
    expect(
      view.queryByRole("button", { name: "Dictate a message" }),
    ).toBeNull();
    expect(calls.map((call) => call.command)).toEqual([
      "plugin:openbot-desktop|speech_available",
      "plugin:openbot-desktop|speech_start",
    ]);
    expect(calls[1]?.args?.language).toBe(navigator.language);

    // Enter while listening stops, and sends nothing.
    enter();
    await waitFor(() =>
      expect(box().textContent).toBe(
        "Existing draft book a table for two tonight",
      ),
    );
    await view.findByRole("button", { name: "Dictate a message" });
    expect(sent).toEqual([]);
    expect(calls.at(-1)?.command).toBe("plugin:openbot-desktop|speech_stop");

    // The next Enter sends what is in the box.
    enter();
    await waitFor(() =>
      expect(sent).toEqual(["Existing draft book a table for two tonight"]),
    );
  });
}

test("desktop: Stop keeps the words in the box and sends nothing", async () => {
  noProvider();
  installDesktopShell(desktop);
  const sent: string[] = [];
  const { view, box } = renderComposer(true, sent);
  fireEvent.click(
    await view.findByRole("button", { name: "Dictate a message" }),
  );
  fireEvent.click(await view.findByRole("button", { name: "Stop dictation" }));
  await view.findByRole("button", { name: "Dictate a message" });
  expect(box().textContent).toBe("Existing draft book a table for two tonight");
  expect(sent).toEqual([]);
});

test("desktop: waits while the system asks for permission, then listens", async () => {
  noProvider();
  let asked = 0;
  installDesktopShell({
    ...desktop,
    availability: () => (asked++ < 2 ? "downloading" : "available"),
  });
  const { view, box } = renderComposer(true, []);
  fireEvent.click(
    await view.findByRole("button", { name: "Dictate a message" }),
  );
  await view.findByText(
    "Waiting for permission to use the microphone and speech recognition.",
  );
  await waitFor(
    () => expect(box().textContent).toBe("Existing draft book a table for two"),
    { timeout: 3_000 },
  );
  expect(
    view.queryByText(
      "Waiting for permission to use the microphone and speech recognition.",
    ),
  ).toBeNull();
});

test("desktop: a refused permission says where to turn it on, and the draft is untouched", async () => {
  noProvider();
  installDesktopShell({ fails: "not-allowed" });
  const { view, box } = renderComposer(true, []);
  fireEvent.click(
    await view.findByRole("button", { name: "Dictate a message" }),
  );
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(liveProblem("not-allowed", "mac") ?? "");
  expect(alert.textContent).toContain("System Settings");
  expect(box().textContent).toBe("Existing draft");
  expect(view.getByRole("button", { name: "Dictate a message" })).toBeDefined();
});

test("desktop: typing while listening stops listening and keeps what is in the box", async () => {
  noProvider();
  const { calls } = installDesktopShell(desktop);
  const { view, box } = renderComposer(true, []);
  fireEvent.click(
    await view.findByRole("button", { name: "Dictate a message" }),
  );
  await waitFor(() =>
    expect(box().textContent).toBe("Existing draft book a table for two"),
  );
  box().textContent = "Existing draft book a table for two, please";
  fireEvent.input(box());
  await view.findByRole("button", { name: "Dictate a message" });
  expect(calls.at(-1)?.command).toBe("plugin:openbot-desktop|speech_abort");
  // Nothing the recognizer said later writes over the typing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(box().textContent).toBe("Existing draft book a table for two, please");
});

test("web: Chrome's Web Speech API streams into the box, and Enter stops it without sending", async () => {
  noProvider();
  const recognitions = installChrome(null);
  const sent: string[] = [];
  const { view, box, enter } = renderComposer(false, sent);
  fireEvent.click(
    await view.findByRole("button", { name: "Dictate a message" }),
  );
  await waitFor(() =>
    expect(box().textContent).toBe(
      "Existing draft I am opening the expenses page",
    ),
  );
  const recognition = recognitions[0];
  expect(recognition?.continuous).toBe(true);
  expect(recognition?.interimResults).toBe(true);
  enter();
  await view.findByRole("button", { name: "Dictate a message" });
  expect(box().textContent).toBe(
    "Existing draft I am opening the expenses page",
  );
  expect(sent).toEqual([]);
  enter();
  await waitFor(() =>
    expect(sent).toEqual(["Existing draft I am opening the expenses page"]),
  );
});

test("web: a browser without the Web Speech API shows no microphone", async () => {
  noProvider();
  expect(liveDictationSource()).toBeNull();
  const { view } = renderComposer(false, []);
  await view.findByRole("button", { name: "Send message" });
  expect(view.queryByRole("button", { name: "Dictate a message" })).toBeNull();
});

test("a configured transcription provider still records and transcribes, even where speech recognition exists", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    transcription: true,
  });
  const recognitions = installChrome(null);
  const { calls } = installDesktopShell(desktop);
  const supported = spyOn(recording, "recordingSupported").mockReturnValue(
    true,
  );
  const start = spyOn(recording, "startRecording").mockResolvedValue({
    finish: async () => new Blob(["audio"], { type: "audio/webm" }),
    cancel() {},
  });
  try {
    const { view } = renderComposer(true, []);
    fireEvent.click(
      await view.findByRole("button", { name: "Dictate a message" }),
    );
    await view.findByRole("button", { name: "Stop and transcribe" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(recognitions).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    supported.mockRestore();
    start.mockRestore();
  }
});

test("the Desktop window on Windows listens through the desktop app, and on Linux shows no microphone", () => {
  installDesktopShell();
  const agent = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(navigator),
    "userAgent",
  );
  const as = (userAgent: string) =>
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => userAgent,
    });
  try {
    as("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/142");
    expect(liveDictationSource()?.platform).toBe("windows");
    as("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
    expect(liveDictationSource()).toBeNull();
  } finally {
    delete (navigator as { userAgent?: string }).userAgent;
    if (agent) expect(navigator.userAgent).toBe(MAC);
  }
});
