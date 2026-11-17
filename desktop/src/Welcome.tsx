import { IconBuilding, IconCloud, IconDeviceLaptop } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { BusinessBooker } from "./BusinessBooker";
import { ConnectToOpenBot, useConnectToOpenBot } from "./ConnectToOpenBot";
import {
  EarlyDownloadsLine,
  earlyDownloadsMeasured,
  useEarlyDownloads,
} from "./EarlyDownloads";
import type { Problem } from "./Problem";

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
 * everything on this computer, and OpenBot for Business books a call with us. OpenBot Cloud is
 * shown greyed. Then what the choice needs. For Self-hosted that is what this computer needs and
 * why, which is that every part of OpenBot runs on it, how long setup takes, and Install, and it
 * fits the window's default size (1000×800, less a title bar) with no scrollbar. For OpenBot for
 * Business it is the app's OpenBot for Business view: what it adds and the booking calendar
 * (`BusinessBooker`), which scrolls in the card as any tall step does.
 *
 * Connecting this app to the OpenBot a company already runs is the link under the rows ("Already
 * have OpenBot at work?"), which opens the address and Connect (`ConnectToOpenBot`). While that
 * shows, no row is picked: it is none of the three. Usage data is not said here: it is the last
 * screen's choice (`UsageDataChoice`).
 *
 * The big downloads start with Install (`startDownloads`), the moment the person chooses this
 * computer, and never before: somebody who connects to their company's OpenBot downloads nothing.
 * Where an installation is already on this computer they start when this screen shows. Its line
 * says how far they are (`EarlyDownloadsLine`). Once they are done it says nothing: Install is the
 * next step either way.
 *
 * On a disk too full for OpenBot, Install waits with the line that says so, and is there once the
 * download starts by itself. On Windows F it was pressable at 15 GB free: it built OpenBot's machine,
 * then the next step stopped for space, with less free than before. Install asks the downloads it
 * starts for their look at the disk first (`earlyDownloadsMeasured`), and goes on only with room.
 */
export function Welcome({
  hosting,
  onConnect,
  onThisComputer,
  saved,
  resumes = false,
  startDownloads,
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
  /** Connecting to the OpenBot a company already runs was picked. */
  onConnect: () => void;
  /** Self-hosted was picked again. May fail, when a saved connection has to be switched first. */
  onThisComputer: () => void | Promise<void>;
  /** What is known of an OpenBot connected to before (`useConnectToOpenBot`). */
  saved?: {
    address?: string;
    problem?: Problem | null;
    reopen?: () => Promise<void>;
  };
  /**
   * Starts the big downloads for this computer's install, which first look at its free disk.
   * Install calls it before it asks for that look, so the answer is theirs.
   */
  startDownloads?: () => Promise<void>;
  onInstall: () => void;
  /** A failure from setup on this computer, shown inside this card rather than under it. */
  failure?: ReactNode;
}) {
  const connecting = useConnectToOpenBot({ ...saved, onThisComputer });
  // OpenBot for Business picked: its booker shows, whatever the app holds as the choice.
  const [booking, setBooking] = useState(false);
  const shown = booking ? "business" : hosting;
  // While it checks an address or waits on the browser, Cancel is the way out.
  const held = shown === "connect" && connecting.busy;
  const rowClass = (row: "self-hosted" | "business") =>
    shown === row ? "tile chosen" : held ? "tile held" : "tile";
  // Asked for by the link under the rows: the address field has the focus once it shows.
  const [focusField, setFocusField] = useState(false);
  useEffect(() => {
    if (!focusField || shown !== "connect") return;
    connecting.field.current?.focus();
    setFocusField(false);
  }, [focusField, shown, connecting.field]);
  const connectToIt = () => {
    setBooking(false);
    setFocusField(true);
    if (hosting !== "connect") onConnect();
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
        <label className={rowClass("self-hosted")}>
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="self-hosted"
            checked={shown === "self-hosted"}
            disabled={held}
            onChange={() => {
              setBooking(false);
              if (hosting === "connect") void connecting.leave();
            }}
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
        <label className={rowClass("business")}>
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="business"
            checked={shown === "business"}
            disabled={held}
            onChange={() => setBooking(true)}
          />
          <HostingMark>
            <IconBuilding stroke={1.75} />
          </HostingMark>
          <span className="tile-name">OpenBot for Business</span>
          <span className="tile-summary">
            For your whole team. Book a call to see it.
          </span>
        </label>
        {/* Under the rows and not one of them: somebody whose company already runs OpenBot connects
            this app to it. Gone while the address shows, since that is where it leads. */}
        {shown !== "connect" && (
          <p className="tile-aside">
            Already have OpenBot at work?{" "}
            <button
              type="button"
              className="text-link inline-link"
              onClick={connectToIt}
            >
              Connect to it
            </button>
            .
          </p>
        )}
      </fieldset>
      {shown === "connect" ? (
        <ConnectToOpenBot connecting={connecting} />
      ) : shown === "business" ? (
        <BusinessBooker />
      ) : (
        <SelfHosted
          startDownloads={startDownloads}
          onInstall={onInstall}
          failure={failure}
          resumes={resumes}
        />
      )}
    </div>
  );
}

/** What Self-hosted asks of this computer and why, then the way on. */
function SelfHosted({
  startDownloads,
  onInstall,
  failure,
  resumes,
}: {
  startDownloads?: () => Promise<void>;
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
        <Install startDownloads={startDownloads} onInstall={onInstall} />
      )}
      {failure}
    </>
  );
}

/** How long setup takes, Install, and the downloads Install starts. */
function Install({
  startDownloads,
  onInstall,
}: {
  startDownloads?: () => Promise<void>;
  onInstall: () => void;
}) {
  const downloads = useEarlyDownloads();
  const [checking, setChecking] = useState(false);
  const short = downloads?.state === "short";
  const install = async () => {
    setChecking(true);
    // The person chose this computer: its downloads start now, and look at the disk first.
    await startDownloads?.();
    const now = await earlyDownloadsMeasured();
    setChecking(false);
    if (now?.state !== "short") onInstall();
  };
  return (
    <>
      <p className="lede">
        Setup takes 1 to 10 minutes, depending on your internet speed.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={short || checking}
          onClick={() => void install()}
        >
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
