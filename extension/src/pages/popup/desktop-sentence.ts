/** Why Connect with OpenBot Desktop did not connect this browser, one plain sentence per code: OpenBot Desktop's own
 * error codes, and the Recorder's (no answer, the policy, an address it cannot use, OpenBot not taking Desktop's code). */
const SENTENCES: Record<string, string> = {
  "origin-not-allowed":
    "OpenBot Desktop does not recognise this copy of the Recorder. Connect from OpenBot in your browser instead.",
  "not-installed":
    "OpenBot Desktop has not set up OpenBot on this computer yet. Finish setting it up in OpenBot Desktop, then try again.",
  "not-running":
    "OpenBot is not running in OpenBot Desktop. Open OpenBot Desktop, then try again.",
  "not-signed-in":
    "OpenBot Desktop is not signed in to your organization. Sign in again in OpenBot Desktop, then try again.",
  "organization-unavailable":
    "OpenBot Desktop cannot hand over your organization sign-in right now. Try again later.",
  "handoff-failed":
    "OpenBot did not give OpenBot Desktop a code to connect with. Try again.",
  "timed-out": "OpenBot Desktop did not answer in time. Try again.",
  "no-answer": "OpenBot Desktop did not answer. Open it, then try again.",
  "host-failed":
    "OpenBot Desktop ran into a problem while answering. Try again, or connect from OpenBot in your browser.",
  "unknown-message":
    "This version of OpenBot Desktop does not understand the Recorder. Update OpenBot Desktop, then try again.",
  "policy-invalid":
    "Your organization's Recorder policy names an OpenBot address the Recorder cannot use. Ask your IT team.",
  "pinned-elsewhere":
    "Your organization connects the Recorder to a different OpenBot. Connect from that OpenBot instead.",
  "invalid-address":
    "OpenBot Desktop answered with an address the Recorder cannot use. Connect from OpenBot in your browser instead.",
  "exchange-refused":
    "OpenBot did not accept the code OpenBot Desktop gave the Recorder. Try again.",
  "openbot-unreachable":
    "OpenBot did not answer. Make sure OpenBot is running in OpenBot Desktop, then try again.",
};

const UNKNOWN =
  "OpenBot Desktop could not connect this browser. Try again, or connect from OpenBot in your browser.";

export function desktopSentence(code: string): string {
  return Object.hasOwn(SENTENCES, code) ? (SENTENCES[code] as string) : UNKNOWN;
}
