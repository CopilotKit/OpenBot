import type { KeyboardEvent } from "react";

/**
 * Whether a keydown belongs to a character an input method is still composing.
 *
 * Japanese, Chinese and Korean are typed through an input method, and Enter is how the character
 * being built is confirmed. That press still arrives as a keydown with `key === "Enter"`: Chromium
 * marks it `isComposing`, and WebKit sends it after `compositionend` with the key code 229 instead.
 * A field that acts on Enter without asking this acts on text the person has not finished typing.
 *
 * The same two checks the libraries under this app already make: `prompt-area`, which draws the chat
 * composer, and the questionnaire primitive both skip a keydown either one describes.
 */
export function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
