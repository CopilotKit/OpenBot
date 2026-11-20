import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  canRecogniseOnDevice,
  installOnDeviceSpeech,
  onDeviceSpeech,
} from "@openbot/shared/on-device-speech";
import {
  browserNarrationDeps,
  type NarrationStatus,
  narrationRecognition,
  type Phrase,
  speechRecognition,
  startNarration,
} from "@/lib/browser/narration";
import type { DesktopSpeechEvent } from "@/lib/desktop/speech";
import { installChrome } from "./browser-narration.fixture";
import {
  type DesktopShellOptions,
  installDesktopShell,
  removeDesktopShell,
} from "./desktop-shell.fixture";

/**
 * Narration in the OpenBot Desktop window. The window's web view (WKWebView, WebView2) has no on-device speech
 * recognition, so narration listens through the desktop app's (desktop/src-tauri/src/speech.rs) there, and through the
 * browser's own anywhere else; either way the Recorder gets the same phrases, timed by the same rule.
 */

const speech = globalThis as {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

// The page finds the Desktop window on `window`.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

afterEach(() => {
  removeDesktopShell();
  delete speech.SpeechRecognition;
  delete speech.webkitSpeechRecognition;
});

const said = (index: number, text: string, final = false) =>
  ({ type: "result", index, text, final }) satisfies DesktopSpeechEvent;

/** Narration through the desktop app, as the page starts it, until `stop` resolves. */
async function narrate(options: DesktopShellOptions) {
  const { calls } = installDesktopShell(options);
  const phrases: Phrase[] = [];
  const speaking: (number | null)[] = [];
  const statuses: NarrationStatus[] = [];
  const narration = startNarration(
    {
      language: "en-US",
      muted: false,
      phrase: (phrase) => phrases.push(phrase),
      speaking: (since) => speaking.push(since),
      status: (status) => statuses.push(status),
    },
    browserNarrationDeps(),
  );
  const listening = async () => {
    for (let wait = 0; wait < 100; wait++) {
      if (statuses.some((status) => status.state !== "starting")) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await listening();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { narration, phrases, speaking, statuses, calls };
}

describe("which recognition narration listens with", () => {
  test("in the Desktop window, the desktop app's, even where the web view has a recognition of its own", () => {
    installChrome(null);
    expect(narrationRecognition()).toBe(speechRecognition());
    installDesktopShell();
    const desktop = narrationRecognition();
    expect(desktop).not.toBeNull();
    expect(desktop).not.toBe(speechRecognition());
    // One recognition per window, so the page's checks of it agree with each other.
    expect(narrationRecognition()).toBe(desktop);
    removeDesktopShell();
    expect(narrationRecognition()).toBe(speechRecognition());
  });

  test("the desktop app's is on the device, as narration requires, and asks the desktop about the language", async () => {
    const { calls } = installDesktopShell({
      availability: (language) =>
        language === "en-US" ? "available" : "unavailable",
    });
    const Recognition = narrationRecognition();
    expect(canRecogniseOnDevice(Recognition)).toBe(true);
    expect(await onDeviceSpeech(Recognition, "en-US")).toBe("available");
    expect(await onDeviceSpeech(Recognition, "tlh")).toBe("unavailable");
    expect(await installOnDeviceSpeech(Recognition, "en-US")).toBe(true);
    expect(calls).toContainEqual({
      command: "plugin:openbot-desktop|speech_available",
      args: { language: "en-US" },
    });
  });

  test("while the person answers the system's questions, narration waits, as for a download", async () => {
    const Recognition = (() => {
      installDesktopShell({ availability: "downloading" });
      return narrationRecognition();
    })();
    expect(await onDeviceSpeech(Recognition, "en-US")).toBe("downloading");
    expect(await installOnDeviceSpeech(Recognition, "en-US")).toBe(false);
  });

  test("a desktop app without speech recognition leaves narration off, never listening off the device", async () => {
    const { statuses, calls } = await narrate({ availability: null });
    expect(statuses.at(-1)).toEqual({ state: "failed", problem: "language" });
    expect(calls.some((call) => call.command.endsWith("|speech_start"))).toBe(
      false,
    );
  });
});

describe("what the desktop hears reaches the Recorder as the browser's does", () => {
  test("each phrase, final once, timed from its first words, and Stop hands over the phrase being said", async () => {
    const { narration, phrases, speaking, statuses, calls } = await narrate({
      heard: [
        said(0, "I am"),
        said(0, "I am opening the expenses"),
        said(0, "I am opening the expenses page.", true),
        said(1, "Now I add"),
      ],
      atStop: [said(1, "Now I add the receipt.", true)],
    });
    expect(statuses).toContainEqual({ state: "listening" });
    const start = calls.find((call) => call.command.endsWith("|speech_start"));
    expect(start?.args).toMatchObject({
      language: "en-US",
      onEvent: expect.stringMatching(/^__CHANNEL__:\d+$/),
    });
    expect(phrases.map((phrase) => phrase.text)).toEqual([
      "I am opening the expenses page.",
    ]);

    await narration.stop();
    expect(calls.at(-1)).toEqual({
      command: "plugin:openbot-desktop|speech_stop",
      args: { session: 1 },
    });
    expect(phrases.map((phrase) => phrase.text)).toEqual([
      "I am opening the expenses page.",
      "Now I add the receipt.",
    ]);
    const [first, second] = phrases;
    expect(first?.startedAt ?? 0).toBeLessThanOrEqual(first?.endedAt ?? 0);
    // The second never starts before the first ended.
    expect(second?.startedAt ?? 0).toBeGreaterThanOrEqual(first?.endedAt ?? 0);
    // A phrase begins, is handed over, and the hold is let go, twice.
    expect(speaking.map((since) => since !== null)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(speaking[0]).toBe(first?.startedAt ?? -1);
    expect(speaking[2]).toBe(second?.startedAt ?? -1);
  });

  test("messages that land out of order are read in the order the desktop sent them", async () => {
    const { narration, phrases } = await narrate({
      reorder: true,
      heard: [
        said(0, "open"),
        said(0, "open the menu", true),
        said(1, "then settings"),
        said(1, "then settings.", true),
      ],
    });
    await narration.stop();
    expect(phrases.map((phrase) => phrase.text)).toEqual([
      "open the menu",
      "then settings.",
    ]);
  });

  test("a refused microphone turns narration off, as the browser's refusal does", async () => {
    const { statuses } = await narrate({
      heard: [{ type: "error", error: "not-allowed" }, { type: "end" }],
    });
    expect(statuses.at(-1)).toEqual({
      state: "failed",
      problem: "not-allowed",
    });
  });
});
