import { useState } from "react";
import { IntelligenceChoice, type IntelligenceMode } from "./LocalIntelligence";

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
   * When this build can run Intelligence on this computer, this screen asks where it runs, with
   * neither answer chosen for the person: local installs both here, hosted goes to the Bot screen.
   */
  local?: { onInstall: () => void; onHosted: () => void };
}) {
  const [where, setWhere] = useState<IntelligenceMode | null>(null);
  if (local) {
    return (
      <div className="sheet">
        <div className="lockup">
          <div className="orb" aria-hidden="true" />
          <span>OpenBot</span>
        </div>
        <h1>Set up OpenBot</h1>
        <p className="lede big">
          OpenBot keeps your conversations in CopilotKit Intelligence. Where
          should it run?
        </p>
        <IntelligenceChoice chosen={where} onChoose={setWhere} />
        <div className="row">
          <button
            type="button"
            disabled={where === null}
            onClick={where === "local" ? local.onInstall : local.onHosted}
          >
            Continue
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
