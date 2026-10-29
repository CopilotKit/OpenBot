/**
 * What each browser step on a Bot's computer is called, in one place, so the conversation's step
 * line, the computer's step log and an approval card for the same step all say the same words.
 */

/** A step that happened. */
export const BROWSER_STEP_DONE: Record<string, string> = {
  computer_navigate: "Opened page",
  computer_read: "Read page",
  computer_snapshot: "Inspected page",
  computer_click: "Clicked on page",
  computer_type: "Filled in field",
  computer_key: "Pressed key",
  computer_scroll: "Scrolled page",
};

/** The same steps as what they would do: waiting on the person, declined, blocked or cut off. */
export const BROWSER_STEP_PLAIN: Record<string, string> = {
  computer_navigate: "Open page",
  computer_read: "Read page",
  computer_snapshot: "Inspect page",
  computer_click: "Click on page",
  computer_type: "Fill in field",
  computer_key: "Press key",
  computer_scroll: "Scroll page",
};
