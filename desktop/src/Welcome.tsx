import {
  IconCloud,
  IconCloudLock,
  IconDeviceLaptop,
  IconServer,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import {
  EarlyDownloadsLine,
  earlyDownloadsMeasured,
  useEarlyDownloads,
} from "./EarlyDownloads";
import { ExternalLink } from "./ExternalLink";
import { Mark } from "./Mark";

/** OpenBot's one booking link. */
export const BOOK_A_DEMO = "https://open.bot/business";

/**
 * Where OpenBot will run, before it asks for anything.
 *
 * Three places, as the provider picker's rows: this computer, the one that setup installs and the
 * only one that can be chosen, then OpenBot for Business on OpenBot's cloud and on the person's own
 * cloud or servers. Those two are shown but disabled, so the person sees where OpenBot goes next,
 * and the one booking link under them is how to ask for one. Usage data is not said here: it is the
 * last screen's choice (`UsageDataChoice`).
 *
 * The big downloads start while this screen shows, before Install is clicked, and its line says how
 * far they are (`EarlyDownloadsLine`). Once they are done it says nothing: Install is the next step
 * either way.
 *
 * On a disk too full for OpenBot, Install waits with the line that says so, and is there once the
 * download starts by itself. On Windows F it was pressable at 15 GB free: it built OpenBot's machine,
 * then the next step stopped for space, with less free than before. An Install pressed before the
 * downloads have looked at the disk asks them first (`earlyDownloadsMeasured`).
 */
export function Welcome({
  onInstall,
  failure,
}: {
  onInstall: () => void;
  /** A failure from setup itself, shown inside this card rather than under it. */
  failure?: ReactNode;
}) {
  const downloads = useEarlyDownloads();
  const [checking, setChecking] = useState(false);
  const short = downloads?.state === "short";
  const install = () => {
    setChecking(true);
    void earlyDownloadsMeasured().then((now) => {
      setChecking(false);
      if (now?.state !== "short") onInstall();
    });
  };
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
      <fieldset className="picker places">
        <legend className="sr-only">Where OpenBot runs</legend>
        <label className="tile chosen">
          <input
            type="radio"
            name="place"
            className="tile-input"
            value="this-computer"
            checked
            readOnly
          />
          <IconTile>
            <IconDeviceLaptop stroke={1.75} />
          </IconTile>
          <span className="tile-name">Self-contained on this computer</span>
          <span className="tile-summary">
            Everything runs on this computer. Setup takes up to about 10
            minutes, depending on your internet speed.
          </span>
        </label>
        <label className="tile">
          <input
            type="radio"
            name="place"
            className="tile-input"
            value="business-cloud"
            disabled
          />
          <IconTile>
            <IconCloud stroke={1.75} />
          </IconTile>
          <span className="tile-name">OpenBot for Business Cloud</span>
          <span className="tile-summary">
            OpenBot runs it for your team on OpenBot's cloud. Early access.
          </span>
        </label>
        <label className="tile">
          <input
            type="radio"
            name="place"
            className="tile-input"
            value="business-vpc"
            disabled
          />
          <IconTile>
            <IconCloudLock stroke={1.75} />
          </IconTile>
          <span className="tile-name">OpenBot for Business on your VPC</span>
          <span className="tile-summary">
            Deploy in one click to AWS, Azure, Google Cloud or your own servers.
            Early access.
          </span>
          {/* The four places it deploys to, already named in the line above. */}
          <span className="deploy-marks" aria-hidden="true">
            <Mark id="aws" name="AWS" />
            <Mark id="azure" name="Azure" />
            <Mark id="google-cloud" name="Google Cloud" />
            <IconTile>
              <IconServer stroke={1.75} />
            </IconTile>
          </span>
        </label>
      </fieldset>
      <p className="footnote">
        OpenBot for Business is in early access. If you're interested,{" "}
        <ExternalLink href={BOOK_A_DEMO}>you can set up a call</ExternalLink>.
      </p>
      <div className="row">
        <button type="button" disabled={short || checking} onClick={install}>
          Install
        </button>
      </div>
      <EarlyDownloadsLine firstScreen />
      {failure}
    </div>
  );
}

/** A plain icon in a mark's tile, as `EndpointMark` draws its cloud: decorative, the row names it. */
function IconTile({ children }: { children: ReactNode }) {
  return (
    <div className="mark-tile mark-icon" aria-hidden="true">
      {children}
    </div>
  );
}
