/**
 * What OpenBot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({
  onStart,
  local,
}: {
  onStart: () => void;
  /**
   * When this build can run Intelligence on this computer, Install sets up both here. Local is the
   * default, and Install is the one button that asks for attention. Hosted is a quiet second button
   * for somebody who already knows local is not for them, so they need not fail at it first.
   */
  local?: { onInstall: () => void; onHosted: () => void };
}) {
  if (local) {
    return (
      <div className="sheet">
        <div className="lockup">
          <div className="orb" aria-hidden="true" />
          <span>OpenBot</span>
        </div>
        <h1>Set up OpenBot</h1>
        <p className="lede big">
          Installs OpenBot and CopilotKit Intelligence on this computer. The
          first setup takes about 10 minutes.
        </p>
        <div className="row">
          <button type="button" onClick={local.onInstall}>
            Install
          </button>
          <button type="button" className="quiet" onClick={local.onHosted}>
            Use CopilotKit's hosted service instead
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sheet">
      <div className="lockup">
        <div className="orb" aria-hidden="true" />
        <span>OpenBot</span>
      </div>
      <h1>Your own AI coworkers, on this computer.</h1>
      <p className="lede big">
        They answer questions, use the tools you connect, and can work in a
        browser for you.
      </p>
      <div className="row">
        <button type="button" onClick={onStart}>
          Set up OpenBot
        </button>
      </div>
      <p className="footnote">
        Takes a few minutes. OpenBot installs what it needs first, then asks you
        to sign in to the AI plan you already have.
      </p>
    </div>
  );
}
