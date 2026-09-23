import { expect, test } from "bun:test";
import { getHotkey, matchesHotkey } from "@/lib/hotkeys/hotkeys";

/**
 * The New chat shortcut on a keyboard layout that does not write Latin letters.
 *
 * Settings shows it as Shift+N, and `matchesHotkey` compared `KeyboardEvent.key`. That is right for
 * a layout that moves the letter, such as Dvorak: the key a person presses when told "N" is the one
 * that writes an N. A layout that writes another script has no key that writes an N at
 * all. Shift and the N key write "Т" on Russian and "Ν" (Greek capital nu, not a Latin N) on Greek,
 * so the shortcut Settings lists never fired for anybody with one of those layouts selected.
 */

const combo = getHotkey("new-chat").combo;

/** A keydown as a browser reports it: `key` from the layout, `code` from the physical key. */
function keydown(
  key: string,
  code: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "shiftKey" | "ctrlKey" | "metaKey" | "altKey">
  > = {},
): KeyboardEvent {
  return {
    key,
    code,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

test("Shift and the N key start a new chat on a layout that writes another script", () => {
  const pressed = [
    ["Russian", keydown("Т", "KeyN", { shiftKey: true })],
    ["Greek", keydown("Ν", "KeyN", { shiftKey: true })],
  ] as const;

  expect(
    pressed.map(([layout, event]) => [layout, matchesHotkey(event, combo)]),
  ).toEqual([
    ["Russian", true],
    ["Greek", true],
  ]);
});

test("a layout that writes Latin letters still goes by the letter, wherever its key is", () => {
  // Dvorak writes N on the key QWERTY calls L, and B on the key QWERTY calls N.
  expect(matchesHotkey(keydown("N", "KeyL", { shiftKey: true }), combo)).toBe(
    true,
  );
  expect(matchesHotkey(keydown("B", "KeyN", { shiftKey: true }), combo)).toBe(
    false,
  );
});

test("the modifiers are still exact on the physical key", () => {
  expect(matchesHotkey(keydown("т", "KeyN"), combo)).toBe(false);
  expect(
    matchesHotkey(
      keydown("Т", "KeyN", { shiftKey: true, ctrlKey: true, metaKey: true }),
      combo,
    ),
  ).toBe(false);
  // A character from another script on some other key is not N, and neither is one on a key that
  // has no letter of its own, nor the Shift key itself.
  expect(matchesHotkey(keydown("Ь", "KeyM", { shiftKey: true }), combo)).toBe(
    false,
  );
  expect(
    matchesHotkey(keydown("Ё", "Backquote", { shiftKey: true }), combo),
  ).toBe(false);
  expect(
    matchesHotkey(keydown("Shift", "ShiftLeft", { shiftKey: true }), combo),
  ).toBe(false);
});
