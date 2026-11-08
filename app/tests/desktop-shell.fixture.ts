import type { ShellIpc } from "@/lib/desktop/shell";
import type { DesktopSpeechEvent } from "@/lib/desktop/speech";

/**
 * THE OPENBOT DESKTOP WINDOW, AS THE PAGE SEES IT: Tauri's `__TAURI_INTERNALS__`, with the desktop app's speech
 * commands (desktop/src-tauri/src/desktop_page.rs) answering as they do. A channel is a callback registered with
 * `transformCallback` and passed as `__CHANNEL__:<id>`; the desktop calls it with `{ message, index }` per event and
 * `{ end: true, index }` once it lets the channel go (tauri/src/ipc/channel.rs, Tauri 2.12). The events are the shapes
 * `speech::Event` serialises to, pinned on the Rust side (`events_are_shaped_as_the_page_reads_them`).
 */

export type ShellCall = { command: string; args?: Record<string, unknown> };

export type DesktopShellOptions = {
  /** What `speech_available` answers; a function to answer per call. Rejects when null: a desktop app without it. */
  availability?: string | null | ((language: string) => string);
  /** What the desktop hears once listening starts, after its start. */
  heard?: DesktopSpeechEvent[];
  /** What it hands over when asked to stop, before its end. */
  atStop?: DesktopSpeechEvent[];
  /**
   * The problem the desktop answers each start with while set, as on a computer with no microphone
   * (`audio-capture`): its error, then its end, and never a start (speech.rs, `Emitter::fail`). Read at each start,
   * so a test can plug a microphone in.
   */
  fails?: string;
  /** Deliver each pair of channel messages the wrong way round, as two evaluations may land. */
  reorder?: boolean;
};

type Internals = { __TAURI_INTERNALS__?: ShellIpc };

export function installDesktopShell(options: DesktopShellOptions = {}) {
  const calls: ShellCall[] = [];
  const callbacks = new Map<number, (message: unknown) => void>();
  let nextCallback = 1;
  let nextSession = 1;
  const sessions = new Map<
    number,
    { callback: number; index: number; ended: boolean }
  >();

  function deliver(session: number, events: DesktopSpeechEvent[], end = false) {
    const open = sessions.get(session);
    if (!open || open.ended) return;
    const messages: unknown[] = events.map((message) => ({
      message,
      index: open.index++,
    }));
    if (end) {
      messages.push({ message: { type: "end" }, index: open.index++ });
      messages.push({ end: true, index: open.index++ });
      open.ended = true;
    }
    if (options.reorder)
      for (let at = 0; at + 1 < messages.length; at += 2)
        [messages[at], messages[at + 1]] = [messages[at + 1], messages[at]];
    const callback = callbacks.get(open.callback);
    setTimeout(() => {
      for (const message of messages) callback?.(message);
    }, 0);
  }

  const shell: ShellIpc = {
    transformCallback(callback) {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    async invoke(command, args) {
      calls.push({ command, args });
      const name = command.replace("plugin:openbot-desktop|", "");
      switch (name) {
        case "speech_available": {
          const answer = options.availability;
          if (answer === null) throw new Error("command not found");
          if (typeof answer === "function")
            return answer(String(args?.language));
          return answer ?? "available";
        }
        case "speech_start": {
          const channel = String(args?.onEvent ?? "");
          const callback = Number(channel.replace("__CHANNEL__:", ""));
          if (!channel.startsWith("__CHANNEL__:") || !callbacks.has(callback))
            throw new Error("invalid channel");
          const session = nextSession++;
          sessions.set(session, { callback, index: 0, ended: false });
          if (options.fails)
            deliver(session, [{ type: "error", error: options.fails }], true);
          else deliver(session, [{ type: "start" }, ...(options.heard ?? [])]);
          return session;
        }
        case "speech_stop":
          deliver(Number(args?.session), options.atStop ?? [], true);
          return null;
        case "speech_abort":
          deliver(Number(args?.session), [], true);
          return null;
        default:
          return null;
      }
    },
  };
  (window as Internals).__TAURI_INTERNALS__ = shell;
  return { shell, calls };
}

export function removeDesktopShell() {
  delete (window as Internals).__TAURI_INTERNALS__;
}
