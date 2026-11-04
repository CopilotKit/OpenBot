import type { ReactNode } from "react";

/**
 * What OpenBot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Install sets up OpenBot and CopilotKit Intelligence on this computer;
 * everything else waits for a screen that needs it.
 */
export function Welcome({
  onInstall,
  failure,
}: {
  onInstall: () => void;
  /** A failure from setup itself, shown inside this card rather than under it. */
  failure?: ReactNode;
}) {
  return (
    <div className="sheet">
      <div className="lockup">
        <div className="orb" aria-hidden="true" />
        <span>OpenBot</span>
      </div>
      <h1>Set up OpenBot</h1>
      <p className="lede big">
        Installs the OpenBot app and backend on this computer. The first setup
        takes about 10 minutes.
      </p>
      <div className="row">
        <button type="button" onClick={onInstall}>
          Install
        </button>
      </div>
      {failure}
    </div>
  );
}
