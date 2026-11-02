/**
 * WHAT A RECORDING HOLDS, in the one set of sentences every place that describes it reads: the Recorder's setup page and
 * Record form, OpenBot's Settings, Browsers (before the first Connect) and its Browser page. A recording is more than the
 * person's clicks and typing: a step that saves something carries the request it sent and the answer that came back
 * (extension/src/background/steps.ts), a page whose AI assistant speaks AG-UI has its conversation recorded, the person's
 * own messages included (extension/src/background/agent/events.ts), and narration is kept as text. Saying less than
 * that would be a disclosure that understates what is collected, which the Chrome Web Store's User Data policy forbids:
 * https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
 *
 * Plain strings rather than markup, so the Recorder's pages and OpenBot's draw them with their own components.
 */

export const RECORDER_DISCLOSURE_TITLE = "What the Recorder collects";

/**
 * Where a recording goes, in the one sentence every place that says it reads. The Recorder streams it from the browser
 * straight to the organization's own Intelligence, with a pass the organization's OpenBot hands out for each recording
 * (extension/src/offscreen/grant.ts, streamer.ts); OpenBot itself only hears what the Recorder is doing, for its Browser
 * button (`recorderActivitySchema` in recorder-api.ts: the phase, the recording's name, when it started and how many
 * steps). "Through OpenBot" would say the recording passes through it, which it never does.
 */
export const RECORDER_DESTINATION =
  "What you record goes straight from your browser to your organization's own Intelligence, with a pass from your organization's OpenBot. OpenBot is told that you are recording, the task's name, when it started and how many steps it has, and when you record in a browser shown inside OpenBot, your narration passes through it to the Recorder without being stored.";

/** The disclosure's lead: when it records, where it goes, and what for. */
export const RECORDER_DISCLOSURE = `When you press Record, the Recorder records what you do in every tab you use until you stop, and each tab it records shows that it is. ${RECORDER_DESTINATION} Your recordings are used only for your organization's Skills, evaluations and insights.`;

export type RecorderCollectedKind =
  | "steps"
  | "saves"
  | "assistants"
  | "narration"
  | "masking"
  | "sites";

/** Each thing a recording holds, and the two things the person should know about it, in the order a page lists them. */
export const RECORDER_COLLECTS: readonly {
  kind: RecorderCollectedKind;
  title: string;
  description: string;
}[] = [
  {
    kind: "steps",
    title: "Your steps",
    description:
      "The pages you open and what is on them, and your clicks and typing.",
  },
  {
    kind: "saves",
    title: "What each step saves",
    description:
      "For a step that saves something, like a form you submit, the request it sent and the answer that came back.",
  },
  {
    kind: "assistants",
    title: "AI assistant conversations",
    description:
      "On a page whose AI assistant uses AG-UI, as OpenBot's own chat does, the conversation, including the messages you send.",
  },
  {
    kind: "narration",
    title: "Your narration",
    description:
      "When narration is on, what you say, turned into text on your own computer. Your voice never leaves it.",
  },
  /*
   * What the masking takes, as it takes it (recorder-masking.ts, `scrubText` and the secret-field rules, run on every
   * string a recording sends, and the CopilotKit capture's `cleanLabel` for a clicked control's name), and no more: a
   * phone number, a name or an amount is not masked, so it says so.
   */
  {
    kind: "masking",
    title: "Secrets masked first",
    description:
      "Masked in your browser before anything leaves it: passwords, one-time codes and anything else typed into a secret field, card numbers, email addresses, and keys and sign-in tokens. Web addresses are also taken out of the names of the buttons and links you click. Other details on a page or in a request, such as names, phone numbers and amounts, can still be included.",
  },
  {
    kind: "sites",
    title: "Sites you leave out",
    description:
      "Each recorded tab shows that it is being recorded, with a button that stops recording that site, now and in every later recording.",
  },
];

/** The same, in one sentence, where there is room for no more: under the Record form's task name. */
export const RECORDER_COLLECTS_SHORT =
  "Records every tab you use until you stop: the pages and what is on them, your clicks and typing, what each step saves, AI assistant conversations, and your narration when it is on. Passwords, card numbers, email addresses and tokens are masked in your browser first.";
