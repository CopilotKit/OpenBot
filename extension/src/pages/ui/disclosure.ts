/**
 * The Chrome Web Store's prominent disclosure, in the Recorder's own pages, where a person reads it before anything is
 * collected: the setup page a fresh install opens, and the Record form. The store's User Data policy asks for one in the
 * extension's own interface, seen before collection, saying what is collected and how it is used, and its Limited Use
 * policy for web browsing activity to serve only a feature the interface describes:
 * https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
 * https://developer.chrome.com/docs/webstore/program-policies/limited-use
 *
 * The sentences are OpenBot's own (@openbot/shared/recorder-disclosure), so the Recorder and OpenBot's Settings, Browsers
 * never say different things: the lead says when it records and where it goes, the list (RecorderCollectsRows) what a
 * recording holds, and the short form fits under the Record form's task name.
 */
export {
  RECORDER_COLLECTS_SHORT as DISCLOSURE_SHORT,
  RECORDER_DISCLOSURE as DISCLOSURE,
  RECORDER_DISCLOSURE_TITLE as DISCLOSURE_TITLE,
} from "@openbot/shared/recorder-disclosure";
