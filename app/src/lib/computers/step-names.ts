/**
 * What each browser step on a Bot's computer is called, in one place, so the conversation's step
 * line, the computer's step log and an approval card for the same step all say the same words.
 */

/** A step that happened, as a whole phrase like the ones below: "Filled in a field". */
export const BROWSER_STEP_DONE: Record<string, string> = {
  computer_navigate: "Opened a page",
  computer_read: "Read the page",
  computer_snapshot: "Inspected the page",
  computer_click: "Clicked on the page",
  computer_type: "Filled in a field",
  computer_key: "Pressed a key",
  computer_scroll: "Scrolled the page",
};

/**
 * The same steps as what they would do: waiting on the person, declined, blocked or cut off. Whole
 * phrases, because they also sit inside sentences ("Allow it to fill in a field, or decline").
 */
export const BROWSER_STEP_PLAIN: Record<string, string> = {
  computer_navigate: "Open a page",
  computer_read: "Read the page",
  computer_snapshot: "Inspect the page",
  computer_click: "Click on the page",
  computer_type: "Fill in a field",
  computer_key: "Press a key",
  computer_scroll: "Scroll the page",
};
