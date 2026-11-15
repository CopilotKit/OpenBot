import { IconBuilding, IconCloud, IconDeviceLaptop } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { ConnectToOpenBot, useConnectToOpenBot } from "./ConnectToOpenBot";
import {
  EarlyDownloadsLine,
  earlyDownloadsMeasured,
  useEarlyDownloads,
} from "./EarlyDownloads";
import { ExternalLink } from "./ExternalLink";
import type { Problem } from "./Problem";

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

/** Where OpenBot runs: on this computer, or at an address this app connects to. */
export type Hosting = "self-hosted" | "connect";

/**
 * Where OpenBot runs, and what that asks of this computer, before it asks for anything else.
 *
 * First the three ways to run OpenBot, of which two can be chosen here: Self-hosted runs
 * everything on this computer, and OpenBot for Business connects this app to the OpenBot a company
 * runs, at its address. OpenBot Cloud is shown greyed. Then what the choice needs. For Self-hosted
 * that is what this computer needs and why, which is that every part of OpenBot runs on it, how
 * long setup takes, and Install. For OpenBot for Business it is the address and Connect
 * (`ConnectToOpenBot`). The one booking link, for a company that has no OpenBot yet, is under the
 * Business row whichever choice is picked. Either
 * way it fits the window's default size (1000×800, less a title bar) with no scrollbar. Usage data
 * is not said here: it is the last screen's choice (`UsageDataChoice`).
 *
 * The big downloads start while this screen shows with Self-hosted chosen, before Install is
 * clicked, and its line says how far they are (`EarlyDownloadsLine`). Once they are done it says
 * nothing: Install is the next step either way.
 *
 * On a disk too full for OpenBot, Install waits with the line that says so, and is there once the
 * download starts by itself. On Windows F it was pressable at 15 GB free: it built OpenBot's machine,
 * then the next step stopped for space, with less free than before. An Install pressed before the
 * downloads have looked at the disk asks them first (`earlyDownloadsMeasured`).
 */
export function Welcome({
  hosting,
  onConnect,
  onThisComputer,
  saved,
  resumes = false,
  onInstall,
  failure,
}: {
  hosting: Hosting;
  /**
   * OpenBot is already set up on this computer, and the person asked from Settings to choose where
   * it runs. Self-hosted's way on is Continue, which goes on with that setup; there is nothing to
   * install or download first.
   */
  resumes?: boolean;
  /** OpenBot for Business was picked. */
  onConnect: () => void;
  /** Self-hosted was picked again. May fail, when a saved connection has to be switched first. */
  onThisComputer: () => void | Promise<void>;
  /** What is known of an OpenBot connected to before (`useConnectToOpenBot`). */
  saved?: {
    address?: string;
    problem?: Problem | null;
    reopen?: () => Promise<void>;
  };
  onInstall: () => void;
  /** A failure from setup on this computer, shown inside this card rather than under it. */
  failure?: ReactNode;
}) {
  const connecting = useConnectToOpenBot({ ...saved, onThisComputer });
  const connect = hosting === "connect";
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
        <label
          className={
            connect ? (connecting.busy ? "tile held" : "tile") : "tile chosen"
          }
        >
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="self-hosted"
            checked={!connect}
            // While it checks an address or waits on the browser, Cancel is the way out.
            disabled={connect && connecting.busy}
            onChange={() => void connecting.leave()}
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
        <label className={connect ? "tile chosen" : "tile"}>
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="business"
            checked={connect}
            onChange={onConnect}
          />
          <HostingMark>
            <IconBuilding stroke={1.75} />
          </HostingMark>
          <span className="tile-name">OpenBot for Business</span>
          <span className="tile-summary">
            For your whole team. Connect to the OpenBot your company runs.
          </span>
        </label>
        {/* Under the Business row and not part of it: a company with no OpenBot of its own has no
            address to type, and opening the link does not pick the row. */}
        <p className="tile-aside">
          No OpenBot at your company yet?{" "}
          <ExternalLink href={BOOK_A_DEMO}>Book a demo</ExternalLink>.
        </p>
      </fieldset>
      {connect ? (
        <ConnectToOpenBot connecting={connecting} />
      ) : (
        <SelfHosted onInstall={onInstall} failure={failure} resumes={resumes} />
      )}
    </div>
  );
}

/** What Self-hosted asks of this computer and why, then the way on. */
function SelfHosted({
  onInstall,
  failure,
  resumes,
}: {
  onInstall: () => void;
  failure?: ReactNode;
  resumes: boolean;
}) {
  return (
    <>
      <section className="needs" aria-labelledby="needs-heading">
        <h2 id="needs-heading">What this computer needs</h2>
        <p className="lede">
          Self-hosted runs every part of OpenBot on this computer: the app, its
          server and database, your Bots&apos; memory, and a computer for each
          Bot to work on.
        </p>
        <ul className="needs-list">
          {SELF_HOSTED_NEEDS.map((need) => (
            <li key={need}>{need}</li>
          ))}
        </ul>
      </section>
      {resumes ? (
        <div className="row">
          <button type="button" onClick={onInstall}>
            Continue
          </button>
        </div>
      ) : (
        <Install onInstall={onInstall} />
      )}
      {failure}
    </>
  );
}

/** How long setup takes, Install, and the downloads this screen started. */
function Install({ onInstall }: { onInstall: () => void }) {
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
    <>
      <p className="lede">
        Setup takes 1 to 10 minutes, depending on your internet speed.
      </p>
      <div className="row">
        <button type="button" disabled={short || checking} onClick={install}>
          Install
        </button>
      </div>
      <EarlyDownloadsLine firstScreen />
    </>
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
