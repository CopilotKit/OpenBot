/**
 * What OpenBot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
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
        Takes a few minutes. OpenBot installs what it needs and asks you to sign
        in to the AI plan you already have.
      </p>
      <p className="footnote">
        OpenBot sends setup and usage statistics to CopilotKit by default: a
        random installation ID, setup steps, platform and engine details,
        download performance, and Bot and connection choices. Telemetry does not
        include prompts, files, credentials, email addresses, or server URLs. To
        turn it off, launch OpenBot with COPILOTKIT_TELEMETRY_DISABLED=1 or
        DO_NOT_TRACK=1.
      </p>
    </div>
  );
}
