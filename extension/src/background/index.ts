import { restrictStorageToTrustedContexts } from "../shared/storage";
import { installConnection } from "./connection";
import { installRecording } from "./recording";
import { recoverInterruptedRecording } from "./recovery";
import { installRouter } from "./router";
import { installSetup } from "./setup";

// Every listener is registered synchronously at the top level: a service worker the browser wakes for an event only
// delivers it to listeners registered before its first turn ends.
const recording = installRecording();
installRouter(recording);
// A connection that ends without the person's Disconnect (the keep-alive's sign-out, a policy move) also ends what it
// still has running: the recording controller stops the live recording and the document's streams for it.
installConnection({ connectionLost: recording.connectionLost });
// A fresh install opens the page that asks for the microphone; website access came with the install itself.
installSetup();
chrome.runtime.onStartup.addListener(recoverInterruptedRecording);
void restrictStorageToTrustedContexts();
void recoverInterruptedRecording();
