/**
 * Every app-wide keyboard shortcut, in one place.
 *
 * One place on purpose: the binding a listener matches against and the combo the settings page
 * shows a person are the same entry, so they cannot drift apart. Adding a shortcut is adding an
 * entry here and one `useHotkey` call where it acts; the settings list picks it up by itself.
 *
 * Browsers reserve their own combos. Cmd/Ctrl+N — the obvious key for "new chat" — opens a new
 * browser window before the page ever sees the keystroke, and `preventDefault` is ignored for
 * reserved shortcuts, so no entry here can use one. Plain Shift+letter combos work everywhere,
 * at the cost that they are also just how capital letters are typed — which is why `useHotkey`
 * ignores them while focus is in anything editable.
 */

export type HotkeyCombo = {
  /** KeyboardEvent.key, lowercase. */
  key: string;
  shift?: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  alt?: boolean;
};

export type Hotkey = {
  id: string;
  /** What the shortcut does, as the settings page says it. */
  label: string;
  description: string;
  combo: HotkeyCombo;
};

export const HOTKEYS = [
  {
    id: "new-chat",
    label: "New chat",
    description: "Start a new chat from anywhere in the app.",
    combo: { key: "n", shift: true },
  },
] as const satisfies readonly Hotkey[];

export type HotkeyId = (typeof HOTKEYS)[number]["id"];

export function getHotkey(id: HotkeyId): Hotkey {
  const hotkey = HOTKEYS.find((candidate) => candidate.id === id);
  if (!hotkey) {
    throw new Error(`Unknown hotkey "${id}".`);
  }
  return hotkey;
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Whether this keystroke is this combo — exactly, not at-least.
 *
 * Every modifier is compared, including the ones the combo does not ask for: Shift+N must not
 * fire on Cmd+Shift+N, or the combo would shadow whatever that means to the browser. `mod` is
 * Cmd on a Mac and Ctrl elsewhere, and the one it is not still has to be up.
 */
export function matchesHotkey(
  event: KeyboardEvent,
  combo: HotkeyCombo,
): boolean {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const otherMod = isMac ? event.ctrlKey : event.metaKey;
  return (
    event.key.toLowerCase() === combo.key &&
    event.shiftKey === Boolean(combo.shift) &&
    mod === Boolean(combo.mod) &&
    !otherMod &&
    event.altKey === Boolean(combo.alt)
  );
}

/**
 * The combo as a person's keyboard writes it, one part per key: symbols on a Mac (["⇧", "N"]),
 * names everywhere else (["Shift", "N"]). One entry per physical key so each can be drawn as
 * its own keycap.
 */
export function formatHotkey(combo: HotkeyCombo): string[] {
  const parts: string[] = [];
  if (combo.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (combo.alt) parts.push(isMac ? "⌥" : "Alt");
  if (combo.shift) parts.push(isMac ? "⇧" : "Shift");
  parts.push(combo.key.toUpperCase());
  return parts;
}
