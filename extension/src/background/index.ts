import { restrictStorageToTrustedContexts } from "../shared/storage";
import { installConnection } from "./connection";
import { installRecording } from "./recording";
import { recoverInterruptedRecording } from "./recovery";
import { installRouter } from "./router";

// Every listener is registered synchronously at the top level: a service worker the browser wakes for an event only
// delivers it to listeners registered before its first turn ends.
installRouter(installRecording());
installConnection();
chrome.runtime.onStartup.addListener(recoverInterruptedRecording);
void restrictStorageToTrustedContexts();
void recoverInterruptedRecording();
