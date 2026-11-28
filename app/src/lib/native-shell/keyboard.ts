import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * The phone's keyboard, inside the phone app's native shell (`shell.ts`). The shell ends the web
 * view at the keyboard's top edge and dismisses it on a drag down; the page puts it away when the
 * person is plainly done typing:
 *
 * - moving to another page, so the keyboard never stays up over a page that has no field;
 * - a tap on a part of the page that does nothing, as a native app does. On iOS a web page keeps
 *   the keyboard up there: WebKit sends no mousedown for a tap on something that is not clickable,
 *   so the field never loses focus. A drag that scrolls is not a tap (the browser cancels the
 *   pointer), so reading back up the conversation keeps the keyboard.
 *
 * Opening a menu, a select or a sheet needs nothing here: each moves focus into itself as it opens.
 * Sending a message keeps the keyboard up, as a chat app does: the message box keeps its focus.
 */

/** Where a phone shows its keyboard: a text field, a text area or an editable box. */
export function isTextField(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element instanceof HTMLTextAreaElement)
    return true;
  return (
    element instanceof HTMLInputElement &&
    ![
      "button",
      "checkbox",
      "color",
      "file",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(element.type)
  );
}

/** Puts the keyboard away: takes the focus off the text field that has it, if one does. */
export function dropKeyboard(): void {
  const focused = document.activeElement;
  if (isTextField(focused)) focused.blur();
}

/**
 * What a tap may land on and keep the keyboard: anything that does something, any open menu or
 * popup, and the parts of a field drawn around it (the message box's surface and buttons, a search
 * field's icon, the chips beside the To field).
 */
export const KEEPS_KEYBOARD = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  "[contenteditable]",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="slider"]',
  "[data-base-ui-portal]",
  '[data-slot="composer"]',
  '[data-slot="input-group"]',
  '[data-slot="combobox-chips"]',
].join(", ");

/** How far a finger may move and how long it may rest and still be a tap. */
const TAP_SLOP_PX = 10;
const TAP_MS = 500;

/** Mounted once, by the shell's frame. */
export function useShellKeyboard(): void {
  const router = useRouter();
  useEffect(() => {
    // Before the next page renders, so a field it focuses as it opens keeps that focus.
    const off = router.subscribe("onBeforeNavigate", (event) => {
      if (event.pathChanged) dropKeyboard();
    });
    let down: { x: number; y: number; at: number } | null = null;
    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (
        !start ||
        Math.abs(event.clientX - start.x) > TAP_SLOP_PX ||
        Math.abs(event.clientY - start.y) > TAP_SLOP_PX ||
        event.timeStamp - start.at > TAP_MS
      )
        return;
      const target = event.target;
      if (target instanceof Element && target.closest(KEEPS_KEYBOARD)) return;
      dropKeyboard();
    };
    const onCancel = () => {
      down = null;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    return () => {
      off();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel, true);
    };
  }, [router]);
}
