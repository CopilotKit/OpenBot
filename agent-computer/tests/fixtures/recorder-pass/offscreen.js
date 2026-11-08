/*
 * The fixture Recorder's offscreen document: it asks OpenBot for a recording's capture pass, as the
 * Recorder's own document does (`fetchGrant` in extension/src/offscreen/grant.ts), and answers the
 * worker with the status OpenBot's answer came back with, or null when nothing came back.
 */
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== "pass") return false;
  const url = new URL(
    `/api/copilotkit/trajectory/${encodeURIComponent(message.trajectoryId)}/connect`,
    message.openbotUrl,
  );
  fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${message.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    redirect: "error",
    credentials: "omit",
  }).then(
    (response) => reply(response.status),
    () => reply(null),
  );
  return true;
});
