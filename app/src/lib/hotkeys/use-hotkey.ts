import { useEffect, useRef } from "react";
import type { HotkeyId } from "./hotkeys";
import { getHotkey, matchesHotkey } from "./hotkeys";

/**
 * Whether the keystroke belongs to whatever the person is typing into.
 *
 * A combo without a modifier is also just a character: Shift+N is how "New York" starts. A
 * shortcut that fires mid-word steals the letter and throws away the composer the person was
 * writing in, so anything editable — inputs, textareas, contenteditable transcripts — swallows
 * the event as far as un-modified hotkeys are concerned.
 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * Runs `handler` when the registered combo for `id` is pressed anywhere on the page.
 *
 * The combo itself lives in the registry, not at the call site, so the settings page and the
 * listener can never disagree about what the key is. The handler rides in a ref: it closes over
 * render-time state, and re-binding a window listener on every render is churn the ref avoids.
 */
export function useHotkey(id: HotkeyId, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const { combo } = getHotkey(id);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesHotkey(event, combo)) {
        return;
      }
      if (!combo.mod && !combo.alt && isEditable(event.target)) {
        return;
      }
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [id]);
}
