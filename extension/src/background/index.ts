import { restrictStorageToTrustedContexts } from "../shared/storage";
import { installConnection } from "./connection";
import { installLauncher } from "./launcher";
import { installRecording } from "./recording";
import { recoverInterruptedRecording } from "./recovery";
import { installRouter } from "./router";
import { installSecurityFloor } from "./security-floor";
import { installSetup } from "./setup";

// Every listener is registered synchronously at the top level: a service worker the browser wakes for an event only
// delivers it to listeners registered before its first turn ends.
// Below the security floor, the controller refuses to record and nothing is sent (security-floor.ts).
const floor = installSecurityFloor(installRecording());
const recording = floor.recording;
installRouter(recording);
// A connection that ends without the person's Disconnect (the keep-alive's sign-out, a policy move) also ends what it
// still has running: the recording controller stops the live recording and the document's streams for it. One OpenBot
// Desktop makes as the Recorder installs is followed up as an approved Connect is.
installConnection({
  connectionLost: recording.connectionLost,
  connected: recording.connected,
});
// A fresh install opens the page that asks for the microphone; website access came with the install itself.
installSetup();
// What the process that launched this browser calls, over its DevTools pipe, when OpenBot opened the browser itself:
// the connection, Record and Stop, and narration from outside. In this worker's own scope, with no message route to it.
installLauncher(recording);
// Recovery sends kept recordings, so it waits while the security floor holds this copy: the update's own start sends them.
// A browser start also reads the floor from its feed.
const recover = () => floor.whenAllowed(recoverInterruptedRecording);
chrome.runtime.onStartup.addListener(() => {
  void floor.refresh();
  void recover();
});
void restrictStorageToTrustedContexts();
void recover();
