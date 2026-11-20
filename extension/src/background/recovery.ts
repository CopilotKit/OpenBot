// Finishes what a browser restart or a service-worker restart cut short (Task 9's Recovery, Review Focus 3): a recording
// the browser closed on is sent to Intelligence with an interrupted outcome, a Stop is finished, a live recording picks
// up again, and every drain of the connected person is sent; drains of anyone else wait for their person (Decision 19),
// for at most KEPT_FOR_PERSON_MS.
import { readLocal } from "../shared/storage";
import { hasOffscreenDocument } from "./offscreen-document";
import { type RecordingRecovery, recordingRecovery } from "./recording";

let running: { recording: RecordingRecovery; done: Promise<void> } | null =
  null;

/** Single-flight: a call made while one is running returns the running one's promise (index.ts top level and
 * runtime.onStartup both call it at a browser start). A controller installed since (a restarted service worker) starts
 * its own. Never rejects: a failure is logged. */
export function recoverInterruptedRecording(): Promise<void> {
  const recording = recordingRecovery();
  if (!recording) return Promise.resolve();
  if (running?.recording === recording) return running.done;
  const done = recover(recording)
    .catch((error) =>
      console.error("Recorder: recovering after a restart failed", error),
    )
    .finally(() => {
      if (running?.done === done) running = null;
    });
  running = { recording, done };
  return done;
}

async function recover(recording: RecordingRecovery): Promise<void> {
  const phase = await recording.loadedPhase();
  // A browser restart closes the document; a service-worker restart leaves it running, still sending what it holds.
  const hadDocument = await hasOffscreenDocument();
  // A discard the restart interrupted is finished first: a document that outlived the service worker still holds that
  // recording's events and keeps retrying them. With no document nothing sends them, and sendDrains below finishes it
  // before anything goes out; opening one here would hide from the phase below that the document was gone, and a live
  // recording or a stop would never resume it on its session.
  // A document that never comes back must not stop the rest of recovery: the live recording still has to resume, and
  // sendDrains (no document) or the next start finishes the discard, which no path here sends.
  if (hadDocument)
    await recording
      .finishDiscards()
      .catch((error) =>
        console.error(
          "Recorder: finishing a discard after a restart failed",
          error,
        ),
      );
  switch (phase) {
    case "idle":
      // storage.session is empty after a browser restart: a recording left in storage.local was interrupted.
      await recording.interrupt();
      break;
    case "starting":
      await recording.abandonStart();
      break;
    case "stopping": {
      const stopped = await recording.resumeStop();
      if (stopped && hadDocument) await recording.recoverDrain(stopped);
      break;
    }
    case "recording":
      await recording.resumeRecording();
      break;
  }
  // The document that held the drains is gone: a new one recovers them from the outbox.
  if (!hadDocument && ((await readLocal("drains")) ?? []).length > 0)
    await recording.sendDrains();
  // Last, so the phases above see the document as the restart left it: what has waited too long for its person goes.
  await recording.expireWaiting();
}
