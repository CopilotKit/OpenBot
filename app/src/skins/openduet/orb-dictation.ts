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
 * The names below are OpenBot's (`dictation-controls.tsx`); `tests/skins-openduet-orb.test.tsx`
 * renders the real controls and holds these to them.
 */

/** The composer's mic button, drawn only where this deployment can transcribe. */
export const DICTATE_SELECTOR = 'button[aria-label="Dictate a message"]';
/** Drawn by the composer for as long as a recording is open. */
export const RECORDING_SELECTOR = 'button[aria-label="Cancel dictation"]';
/** Ends the recording and puts the words in the draft. */
export const STOP_SELECTOR = 'button[aria-label="Stop and transcribe"]';
/** The composer's editor. */
export const EDITOR_SELECTOR = '[aria-label="Message"]';

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
 * Whether the composer inside `root` is listening, and a count that moves on each keystroke in its
 * editor, for the orb to look down at what is being typed.
 */
export function useComposerPresence(root: HTMLElement | null) {
  const [recording, setRecording] = useState(false);
  const [typing, setTyping] = useState(false);
  const [keystrokes, setKeystrokes] = useState(0);

  useEffect(() => {
    if (!root) return;
    // The transcript mutates on every streamed word; only a change in recording is news.
    let last: boolean | null = null;
    const read = () => {
      const now = root.querySelector(RECORDING_SELECTOR) !== null;
      if (now === last) return;
      last = now;
      setRecording(now);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true });
    const inEditor = (target: EventTarget | null) =>
      target instanceof Element && target.closest(EDITOR_SELECTOR) !== null;
    const onFocusIn = (event: FocusEvent) => {
      if (inEditor(event.target)) setTyping(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (inEditor(event.target)) setTyping(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (inEditor(event.target)) setKeystrokes((count) => count + 1);
    };
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("keydown", onKey);
    };
  }, [root]);

  return { recording, typing, keystrokes };
}
