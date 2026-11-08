/*
 * Appended to a copy of the fixture Recorder's service-worker.js, whose LAUNCHER_GLOBAL, held and
 * report it uses: Record asks OpenBot for the recording's capture pass from the offscreen document,
 * as the Recorder does, and keeps what OpenBot's answer was in `chrome.storage.local` as `pass`.
 *
 * Its worker reports nothing to OpenBot. The Recorder's worker sends nothing either when it is handed
 * the connection it holds already and then asked to record, so the capture pass is the first request
 * of this browser's Recorder to go through the computer's egress filter, as it is in the Recorder.
 */
report = async () => undefined;

const recordWithoutPass = globalThis[LAUNCHER_GLOBAL].record;
globalThis[LAUNCHER_GLOBAL].record = async (input) => {
  const answer = await recordWithoutPass(input);
  if (!answer.ok || input.action !== "start") return answer;
  const { connection } = await held();
  if (!(await chrome.offscreen.hasDocument()))
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["LOCAL_STORAGE"],
      justification:
        "Asks OpenBot for the capture pass, as the Recorder's document does.",
    });
  const status = await chrome.runtime.sendMessage({
    type: "pass",
    trajectoryId: answer.state.recordingId,
    openbotUrl: connection.openbotUrl,
    token: connection.token,
  });
  await chrome.storage.local.set({ pass: status });
  return answer;
};
