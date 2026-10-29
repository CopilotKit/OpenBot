import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import {
  RECORDER_CONNECT_STATUS,
  RECORDER_PAGE_MESSAGES,
  type RecorderConnectWait,
  type RecorderPageResult,
  type RecorderPageState,
  recorderPageMessageSchema,
} from "@openbot/shared/recorder-page";

/**
 * A STAND-IN FOR THE RECORDER IN THE BROWSER OPENBOT IS OPEN IN, answering a page's `chrome.runtime.sendMessage` as
 * the contract in shared/recorder-page.ts types it, while the Recorder's own side of that contract is another slice's
 * work.
 *
 * What it holds to, from the contract and from Chrome:
 * - Messages are checked with the contract's own strict schema; anything else, including any message type this
 *   Recorder does not know, is refused `{ ok: false, error: "invalid" }`, as the Recorder's router refuses one today.
 * - `openbot.state` tells a page that is not the connected OpenBot `{ connected: false }` and nothing more.
 * - `openbot.record` and `openbot.stop` answer `RecorderPageResult`; a refusal carries the Recorder's own sentence.
 * - `openbot.connect` connects a trusted OpenBot with no Connect page, answering `connected: true`, and leaves any
 *   other awaiting the person's Connect click (`confirm`), answering `awaitingConfirmation` and nothing about itself,
 *   as the Recorder does.
 * - `openbot.connect.status` says where that connect has got to: waiting, cancelled on the Connect page (`cancel`),
 *   that tab closed without a choice (`closeTab`), or none.
 * - Chrome answers an id with no extension behind it with `lastError` set and no answer, and answers asynchronously.
 *
 * `older` stands for a Recorder from before this contract: it knows ping and connect and refuses the rest.
 */
export class FakeRecorder {
  readonly id: string;
  /** Connected to the OpenBot this page is. */
  connected = false;
  /** This OpenBot is one the Recorder connects with no Connect page (policy-pinned, or OpenBot Desktop). */
  trusted = false;
  older = false;
  /** A connect waiting for the person's Connect click on the Recorder's page. */
  awaitingConfirmation = false;
  /** Where the last connect from this page has got to, as `openbot.connect.status` answers it. */
  private connectWait: RecorderConnectWait = "none";
  /** What `openbot.connect` is refused with, when it is. */
  refuseConnect: string | null = null;
  /** What `openbot.record` is refused with, when it is: the Recorder's own sentence ("Record from OpenBot's own tab."
   * when a frame inside another page asks). */
  refuseRecord: string | null = null;
  phase: "idle" | "starting" | "recording" | "stopping" = "idle";
  title?: string;
  startedAt?: number;
  actions = 0;
  phrases = 0;
  lastStopped?: Extract<RecorderPageState, { connected: true }>["lastStopped"];
  /** Every message it was sent, as sent. */
  readonly received: unknown[] = [];
  private recordings = 0;

  constructor(id: string = RECORDER_EXTENSION_ID) {
    this.id = id;
  }

  /** The person clicked Connect on the Recorder's Connect page. */
  confirm() {
    if (!this.awaitingConfirmation) return;
    this.awaitingConfirmation = false;
    this.connected = true;
    this.connectWait = "none";
  }

  /** The person clicked Cancel on the Recorder's Connect page. */
  cancel() {
    if (!this.awaitingConfirmation) return;
    this.awaitingConfirmation = false;
    this.connectWait = "cancelled";
  }

  /** The person closed the Recorder's Connect page without choosing. */
  closeTab() {
    if (!this.awaitingConfirmation) return;
    this.awaitingConfirmation = false;
    this.connectWait = "closed";
  }

  state(): RecorderPageState {
    if (!this.connected) return { connected: false };
    return {
      connected: true,
      phase: this.phase,
      ...(this.title !== undefined ? { title: this.title } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      actions: this.actions,
      ...(this.lastStopped ? { lastStopped: this.lastStopped } : {}),
    };
  }

  answer(raw: unknown): unknown {
    this.received.push(raw);
    const type = (raw as { type?: unknown } | null)?.type;
    if (type === "openbot.ping")
      return this.connected
        ? { ok: true, version: "1.0.0", installId: "c".repeat(32) }
        : { ok: true };
    if (type === "openbot.connect") return this.connect(raw);
    if (this.older) return { ok: false, error: "invalid" };
    if (type === RECORDER_CONNECT_STATUS)
      return { ok: true, connect: this.connectWait };
    const message = recorderPageMessageSchema.safeParse(raw);
    if (!message.success) return { ok: false, error: "invalid" };
    switch (message.data.type) {
      case RECORDER_PAGE_MESSAGES.state:
        return this.state();
      case RECORDER_PAGE_MESSAGES.record:
        return this.record(message.data.title);
      case RECORDER_PAGE_MESSAGES.stop:
        return this.stop();
    }
  }

  private connect(raw: unknown) {
    const code = (raw as { code?: unknown }).code;
    if (typeof code !== "string" || !code.startsWith("obc_"))
      return { ok: false, error: "invalid" };
    if (this.refuseConnect) return { ok: false, error: this.refuseConnect };
    if (this.trusted) {
      this.connected = true;
      return {
        ok: true,
        version: "1.0.0",
        installId: "c".repeat(32),
        connected: true,
      };
    }
    // Nothing about the Recorder while its Connect page waits: any site can ask to connect.
    this.awaitingConfirmation = true;
    this.connectWait = "waiting";
    return { ok: true, awaitingConfirmation: true };
  }

  private record(title: string): RecorderPageResult {
    if (!this.connected)
      return { ok: false, error: "Connect the Recorder to OpenBot first." };
    if (this.refuseRecord) return { ok: false, error: this.refuseRecord };
    if (this.phase !== "idle")
      return { ok: false, error: "The Recorder is already recording." };
    this.phase = "recording";
    this.title = title;
    this.startedAt = Date.now();
    this.actions = 0;
    this.phrases = 0;
    return { ok: true, state: this.state() };
  }

  private stop(): RecorderPageResult {
    if (!this.connected)
      return { ok: false, error: "Connect the Recorder to OpenBot first." };
    if (this.phase !== "recording")
      return { ok: false, error: "Nothing is being recorded." };
    this.recordings += 1;
    this.lastStopped = {
      recordingId: `rec-${this.recordings}`,
      title: this.title ?? "",
      stoppedAt: Date.now(),
      actions: this.actions,
      phrases: this.phrases,
    };
    this.phase = "idle";
    this.title = undefined;
    this.startedAt = undefined;
    return { ok: true, state: this.state() };
  }
}

type Reply = (answer: unknown) => void;
type Runtime = {
  sendMessage: (id: string, message: unknown, reply: Reply) => void;
  lastError?: unknown;
};

const globals = globalThis as { chrome?: unknown };

/**
 * Gives the page Chrome's `chrome.runtime.sendMessage`, as Chrome does while an extension in it lists the page in its
 * `externally_connectable`, answered by `recorders` (none: another extension is what gave the page the API). Returns
 * a function that takes it away again.
 */
export function installChromeRuntime(
  recorders: FakeRecorder[],
  extra: Record<string, unknown> = {},
): () => void {
  const had = "chrome" in globals;
  const saved = globals.chrome;
  const runtime: Runtime = {
    sendMessage: (id, message, reply) => {
      const recorder = recorders.find((r) => r.id === id);
      // Chrome answers on a later task, never inside the call.
      setTimeout(() => {
        if (!recorder) {
          runtime.lastError = {
            message:
              "Could not establish connection. Receiving end does not exist.",
          };
          reply(undefined);
          runtime.lastError = undefined;
          return;
        }
        reply(recorder.answer(message));
      }, 0);
    },
  };
  globals.chrome = { ...extra, runtime };
  return () => {
    if (had) globals.chrome = saved;
    else delete globals.chrome;
  };
}

/** The brands a browser reports in `navigator.userAgentData`, as Chrome 156 and Edge 155 report them (captured
 * headless on macOS, 2026-10-23), or none (Safari and Firefox have no `userAgentData`). Returns the undo. */
export function setBrowserBrands(
  brands: "chrome" | "edge" | "chromium" | null,
  options: { mobile?: boolean } = {},
): () => void {
  const named = {
    chrome: ["Not:A-Brand", "Chromium", "Google Chrome"],
    edge: ["Microsoft Edge", "Chromium", "Not(A:Brand"],
    chromium: ["Chromium", "Not=A?Brand"],
  };
  const descriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "userAgentData",
  );
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: brands
      ? {
          brands: named[brands].map((brand) => ({ brand, version: "156" })),
          mobile: options.mobile ?? false,
          platform: "macOS",
        }
      : undefined,
  });
  return () => {
    if (descriptor)
      Object.defineProperty(navigator, "userAgentData", descriptor);
    else delete (navigator as { userAgentData?: unknown }).userAgentData;
  };
}
