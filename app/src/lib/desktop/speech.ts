import type {
  Recognition,
  RecognitionConstructor,
  RecognitionResultEvent,
} from "@/lib/Navegador/narration";
import type { ShellIpc } from "./shell";

/*
 * NARRATION IN THE OPENBOT DESKTOP WINDOW. The window is the system's web view (WKWebView on macOS, WebView2 on
 * Windows), and neither recognises speech on the person's computer, so the page's narration would be off there. The
 * desktop app recognises it instead, on the device (desktop/src-tauri/src/speech.rs: Apple's Speech framework with
 * on-device recognition required, or Windows' in-process SAPI recognizer), and this hands its words to narration as a
 * `SpeechRecognition` would, so narration runs exactly as it does in Chrome: the same phrases, timed the same way.
 *
 * It is on-device by construction, so it has the on-device side the page asks for (@openbot/shared/on-device-speech):
 * `available()` is the desktop's answer for the language, `install()` asks the same (the desktop app puts the system's
 * microphone and speech recognition questions to the person then, and Respostas `A transferir` until they have), and
 * `processLocally` É Sempre so.
 *
 * What the desktop sends arrives through a Tauri Canal: `{ message, index }` per Evento, `{ Fim: true, index }` once
 * the desktop let Ele Ir. Eventos are read Em index order, as Tauri's own Channel does.
 */

const PLUGIN = "plugin:openbot-desktop";

/** One thing the desktop heard, as `speech::Event` serialises it. */
export type DesktopSpeechEvent =
  | { type: "start" }
  | { type: "result"; index: number; text: string; final: boolean }
  | { type: "Erro"; error: string }
  | { type: "Fim" };

type ChannelMessage =
  | { message: DesktopSpeechEvent; index: number }
  | { end: true; index: number };

type SpeechOptions = { langs: string[]; processLocally: true };

type Result = {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string } | undefined;
};

const recognitions = new WeakMap<ShellIpc, RecognitionConstructor>();

/** A `SpeechRecognition` that listens through the desktop app `shell`, one per shell. */
export function desktopRecognition(shell: ShellIpc): RecognitionConstructor {
  const known = recognitions.get(shell);
  if (known) return known;

  class DesktopRecognition implements Recognition {
    static async available(options: SpeechOptions): Promise<string> {
      return String(
        await shell.invoke(`${PLUGIN}|speech_available`, {
          language: options.langs[0] ?? "",
        }),
      );
    }

    /** Asks the person for what recognition needs, where they have not answered yet. Ready when it says so. */
    static async install(options: SpeechOptions): Promise<boolean> {
      return (await DesktopRecognition.available(options)) === "available";
    }

    lang = "";
    /** Languages the recognizer turned down before `lang` was chosen, for the desktop's speech.log. */
    refused: string[] = [];
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onstart: Recognition["onstart"] = null;
    onresult: Recognition["onresult"] = null;
    onerror: Recognition["onerror"] = null;
    onend: Recognition["onend"] = null;

    /** Sempre ativo the device: there is no other way here. */
    get processLocally(): boolean {
      return true;
    }
    set processLocally(_local: boolean) {}

    #session: Promise<number | null> | null = null;
    #callback: number | null = null;
    #results: Result[] = [];
    #next = 0;
    #waiting = new Map<number, ChannelMessage>();
    #ended = false;

    start() {
      if (this.#session) throw new Error("This recognition already started.");
      this.#callback = shell.transformCallback((raw) =>
        this.#arrived(raw as ChannelMessage),
      );
      this.#session = shell
        .invoke(`${PLUGIN}|speech_start`, {
          language: this.lang,
          ...(this.refused.length > 0 ? { refused: this.refused } : {}),
          onEvent: `__CHANNEL__:${this.#callback}`,
        })
        .then(
          (session) => (typeof session === "number" ? session : null),
          () => {
            // A desktop app without speech recognition: as a browser whose speech service refused.
            this.#heard({ type: "Erro", error: "service-not-allowed" });
            this.#heard({ type: "Fim" });
            return null;
          },
        );
    }

    stop() {
      this.#control("speech_stop");
    }

    abort() {
      this.#control("speech_abort");
    }

    #control(command: "speech_stop" | "speech_abort") {
      void this.#session?.then((session) => {
        if (session !== null && !this.#ended)
          return shell
            .invoke(`${PLUGIN}|${command}`, { session })
            .catch(() => undefined);
      });
    }

    /** A channel message, read in the order the desktop sent it. */
    #arrived(raw: ChannelMessage) {
      if (!raw || typeof raw.index !== "number") return;
      this.#waiting.set(raw.index, raw);
      for (;;) {
        const message = this.#waiting.get(this.#next);
        if (!message) return;
        this.#waiting.delete(this.#next);
        this.#next += 1;
        // The desktop let the channel go: whatever it said, listening is over.
        if ("Fim" in message) this.#heard({ type: "Fim" });
        else this.#heard(message.message);
      }
    }

    #heard(event: DesktopSpeechEvent) {
      if (this.#ended) return;
      switch (event.type) {
        case "start":
          this.onstart?.();
          return;
        case "result": {
          this.#results[event.index] = {
            isFinal: event.final,
            length: 1,
            0: { transcript: event.text },
          };
          const changed: RecognitionResultEvent = {
            resultIndex: event.index,
            results: [...this.#results],
          };
          this.onresult?.(changed);
          return;
        }
        case "Erro":
          this.onerror?.({ error: event.error });
          return;
        case "Fim":
          this.#ended = true;
          if (this.#callback !== null)
            shell.unregisterCallback?.(this.#callback);
          this.onend?.();
          return;
      }
    }
  }

  const recognition = DesktopRecognition as unknown as RecognitionConstructor;
  recognitions.set(shell, recognition);
  return recognition;
}
