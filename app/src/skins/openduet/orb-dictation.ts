import { useEffect, useState } from "react";

/*
 * THE ORB TALKS THROUGH THE COMPOSER'S OWN DICTATION, IT DOES NOT HAVE ONE OF ITS OWN.
 *
 * OpenBot's composer owns dictation end to end (`components/channels/composer/use-dictation.ts`):
 * the recording, the transcription, the waveform, Retry, and where the words land, which is that
 * composer's draft. A second session in the header would have to put text into an editor it does
 * not own, and would race the composer's own. So the orb presses the composer's own control, by
 * the name OpenBot gives it, and reads the composer's own controls back to know it is listening.
 * Everything a person sees while they talk is OpenBot's.
 *
 * Every part of the composer is found by the `data-slot` hooks OpenBot gives skins, never by its
 * classes or its words; `tests/skins-openduet-orb.test.tsx` renders the real composer and holds
 * every one of these to it.
 */

/** The composer's mic button, drawn only where this deployment can transcribe. */
export const DICTATE_SELECTOR = '[data-slot="composer-dictate"]';
/** Drawn by the composer for as long as a recording is open. */
export const RECORDING_SELECTOR = '[data-slot="composer-dictate-cancel"]';
/** Ends the recording and puts the words in the draft. */
export const STOP_SELECTOR = '[data-slot="composer-dictate-stop"]';
/**
 * Drawn by the composer for as long as the Bot's turn runs in this conversation: the most direct
 * word OpenBot has that the Bot is working, and it needs no round trip through the server.
 */
export const WORKING_SELECTOR = '[data-slot="composer-stop"]';
/**
 * How long the Stop control has to stay before the orb reads the Bot as working. Opening a
 * conversation shows it for a moment while OpenBot checks for a turn already running, and an orb
 * that thought for that moment on every open would be a flicker, not news. A real turn runs far
 * longer than this.
 */
export const WORKING_SETTLE_MS = 700;
/** The composer's input, around its editor. */
export const INPUT_SELECTOR = '[data-slot="composer-input"]';
/** The editor itself, which takes the focus. */
export const EDITOR_SELECTOR = `${INPUT_SELECTOR} [contenteditable="true"]`;

function enabled(button: Element | null): HTMLButtonElement | null {
  return button instanceof HTMLButtonElement && !button.disabled
    ? button
    : null;
}

export type OrbPress = "started" | "stopped" | "none";

/**
 * Press the orb over `root`: stop a recording that is open, start one in the composer on screen, or
 * report that there is no composer here to talk into.
 */
export function pressOrb(root: ParentNode): OrbPress {
  const stop = enabled(root.querySelector(STOP_SELECTOR));
  if (stop) {
    stop.click();
    return "stopped";
  }
  if (root.querySelector(RECORDING_SELECTOR)) return "none";
  const dictate = enabled(root.querySelector(DICTATE_SELECTOR));
  if (dictate) {
    dictate.click();
    return "started";
  }
  return "none";
}

/**
 * Start dictating in the composer once it is drawn: after the orb took the person to Chat from a
 * screen with no composer, the next one to mount is the one they meant. Gives up after `timeoutMs`,
 * leaving them in Chat with the composer in front of them.
 */
export function pressOrbWhenReady(
  root: () => ParentNode | null,
  timeoutMs = 3_000,
): () => void {
  const until = Date.now() + timeoutMs;
  let frame = 0;
  const attempt = () => {
    const node = root();
    if (node && pressOrb(node) === "started") return;
    if (Date.now() < until) frame = requestAnimationFrame(attempt);
  };
  frame = requestAnimationFrame(attempt);
  return () => cancelAnimationFrame(frame);
}

/**
 * Whether the composer inside `root` is listening, whether the Bot it talks to is working, and
 * whether the person is typing in it.
 */
export function useComposerPresence(root: HTMLElement | null) {
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (!root) return;
    // The transcript mutates on every streamed word; only a change in either is news.
    let lastRecording: boolean | null = null;
    let lastWorking: boolean | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const isRecording = root.querySelector(RECORDING_SELECTOR) !== null;
      const isWorking = root.querySelector(WORKING_SELECTOR) !== null;
      if (isRecording !== lastRecording) {
        lastRecording = isRecording;
        setRecording(isRecording);
      }
      if (isWorking !== lastWorking) {
        lastWorking = isWorking;
        clearTimeout(settle);
        if (isWorking)
          settle = setTimeout(() => setWorking(true), WORKING_SETTLE_MS);
        else setWorking(false);
      }
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true });
    const inEditor = (target: EventTarget | null) =>
      target instanceof Element && target.closest(INPUT_SELECTOR) !== null;
    const onFocusIn = (event: FocusEvent) => {
      if (inEditor(event.target)) setTyping(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (inEditor(event.target)) setTyping(false);
    };
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, [root]);

  return { recording, working, typing };
}
