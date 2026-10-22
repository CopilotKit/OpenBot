/**
 * The Chrome Web Store's prominent disclosure, in the Recorder's own pages, where a person reads it before anything is
 * collected: the setup page a fresh install opens, and the Record form. The store's User Data policy asks for one in the
 * extension's own interface, seen before collection, saying what is collected and how it is used, and its Limited Use
 * policy for web browsing activity to serve only a feature the interface describes:
 * https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
 * https://developer.chrome.com/docs/webstore/program-policies/limited-use
 *
 * One sentence set, so the two pages never say different things. It names what a recording holds (every step in every
 * tab used, what is on the page, typing with secrets masked first, what a step saves, narration) and where it goes.
 */
export const DISCLOSURE_TITLE = "What the Recorder collects";

export const DISCLOSURE =
  "When you press Record, the Recorder records each step you take in every tab you use until you stop: the pages you open and what is on them, your clicks and typing, what each step saves, and what you say as you go. Passwords and secrets are masked in your browser first. It all goes to your organization's own Intelligence through your organization's OpenBot, only while you record, and is used only for your organization's Skills, evaluations and insights.";
