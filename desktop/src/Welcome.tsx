import type { ReactNode } from "react";
import { EarlyDownloadsLine } from "./EarlyDownloads";
import { ExternalLink } from "./ExternalLink";

/** What OpenBot Desktop sends, and what it never does, in full. */
export const USAGE_DATA_DOC =
  "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md";

/**
 * What OpenBot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Install sets up OpenBot and CopilotKit Intelligence on this computer;
 * everything else waits for a screen that needs it.
 *
 * The usage-data notice is here because this is the first screen, and the sign-in that links the
 * data to an account is the next. Settings > General turns it off.
 *
 * The big downloads start while this screen shows, before Install is clicked, and its line says how
 * far they are (`EarlyDownloadsLine`).
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
        <span>
          OpenBot
          <sup className="trademark" aria-hidden="true">
            ™
          </sup>
        </span>
      </div>
      <h1>Set up OpenBot</h1>
      <p className="lede big">
        This installs OpenBot on this computer. The first setup takes about 10
        minutes.
      </p>
      <div className="row">
        <button type="button" onClick={onInstall}>
          Install
        </button>
      </div>
      <EarlyDownloadsLine firstScreen />
      <p className="footnote">
        OpenBot sends usage data, linked to your OpenBot account. It never sends
        your conversations, files or keys. You can turn this off in Settings.{" "}
        <ExternalLink href={USAGE_DATA_DOC}>What OpenBot sends</ExternalLink>
      </p>
      {failure}
    </div>
  );
}
