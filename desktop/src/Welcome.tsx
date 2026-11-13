import { IconBuilding, IconCloud, IconDeviceLaptop } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import {
  EarlyDownloadsLine,
  earlyDownloadsMeasured,
  useEarlyDownloads,
} from "./EarlyDownloads";
import { ExternalLink } from "./ExternalLink";

/** OpenBot's one booking link. */
export const BOOK_A_DEMO = "https://open.bot/business";

/**
 * The least a computer needs to run every part of OpenBot itself.
 *
 * From the installer's own checks: the engine needs 4 CPUs and 40 GiB of free disk
 * (`local_eval::MIN_ENGINE_CPUS`, `MIN_ENGINE_FREE_DISK_BYTES`), and OpenBot's own machine takes 6 to
 * 8 GiB of memory while 4 GiB is kept for the computer itself (`machine_size.rs`). Memory is said as
 * 16 GB, room for that plus the person's own apps, as decided with David on 13 Nov 2026.
 */
export const SELF_HOSTED_NEEDS = [
  "A Mac or a 64-bit Windows PC",
  "16 GB of memory or more",
  "4 CPU cores or more",
  "40 GB of free disk space",
] as const;

/**
 * Where OpenBot runs, and what that asks of this computer, before it asks for anything else.
 *
 * In this order: the three ways to run OpenBot, of which only Self-hosted can be chosen here
 * (OpenBot Cloud and OpenBot for Business are shown greyed, Business with the one booking link);
 * what this computer needs for Self-hosted and why, which is that every part of OpenBot runs on it;
 * then how long setup takes. Usage data is not said here: it is the last screen's choice
 * (`UsageDataChoice`).
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
      <fieldset className="picker hosting">
        <legend className="sr-only">Where OpenBot runs</legend>
        <label className="tile chosen">
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="self-hosted"
            checked
            readOnly
          />
          <HostingMark>
            <IconDeviceLaptop stroke={1.75} />
          </HostingMark>
          <span className="tile-name">Self-hosted</span>
          <span className="tile-summary">
            Everything runs on this computer.
          </span>
        </label>
        <label className="tile unavailable">
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="cloud"
            disabled
          />
          <HostingMark>
            <IconCloud stroke={1.75} />
          </HostingMark>
          <span className="tile-name">OpenBot Cloud</span>
          <span className="tile-summary">Coming soon.</span>
        </label>
        <label className="tile unavailable">
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="business"
            disabled
          />
          <HostingMark>
            <IconBuilding stroke={1.75} />
          </HostingMark>
          <span className="tile-name">OpenBot for Business</span>
          <span className="tile-summary">
            For your whole team, on your own servers or OpenBot Cloud.{" "}
            <ExternalLink href={BOOK_A_DEMO}>Book a demo</ExternalLink> for
            early access.
          </span>
        </label>
      </fieldset>
      <section className="needs" aria-labelledby="needs-heading">
        <h2 id="needs-heading">What this computer needs</h2>
        <p className="lede">
          Self-hosted runs every part of OpenBot on this computer: the app, its
          server and database, your Bots&apos; memory, and a computer of its own
          for each Bot to work on. Together they need:
        </p>
        <ul className="needs-list">
          {SELF_HOSTED_NEEDS.map((need) => (
            <li key={need}>{need}</li>
          ))}
        </ul>
      </section>
      <p className="lede">
        Depending on your internet speed, setup can take between 1 and 10
        minutes.
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

/** A row's mark: the window's plain icon tile, decorative, since the row's name says what it is. */
function HostingMark({ children }: { children: ReactNode }) {
  return (
    <div className="mark-tile mark-icon" aria-hidden="true">
      {children}
    </div>
  );
}
