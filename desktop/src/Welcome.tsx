import {
  IconBuilding,
  IconCloud,
  IconDeviceLaptop,
  IconServer2,
} from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { BusinessBooker } from "./BusinessBooker";
import { ConnectToOpenBot, useConnectToOpenBot } from "./ConnectToOpenBot";
import {
  EarlyDownloadsLine,
  earlyDownloadsMeasured,
  useEarlyDownloads,
} from "./EarlyDownloads";
import { MarkImage } from "./Mark";
import type { Problem } from "./Problem";

/** What the first choice is: OpenBot, whole, on this computer. */
export const SELF_CONTAINED_SUMMARY =
  "Everything runs on this computer, for trying it or personal use.";

/** OpenBot for Business's two ways to run. Either one books a call (`BusinessBooker`). */
type BusinessChoice = "cloud" | "own-cloud";

const BUSINESS_CHOICES: readonly {
  id: BusinessChoice;
  name: string;
  summary: string;
  icon: typeof IconCloud;
}[] = [
  {
    id: "cloud",
    name: "Cloud",
    summary: "We run it for you.",
    icon: IconCloud,
  },
  {
    id: "own-cloud",
    name: "Self-Hosted",
    summary: "Your own cloud or on-prem.",
    icon: IconServer2,
  },
];

/** The clouds a company runs OpenBot for Business on, by their vendored marks (`shared/marks`). */
const CLOUDS = [
  { id: "aws", name: "AWS" },
  { id: "azure", name: "Azure" },
  { id: "google-cloud", name: "Google Cloud" },
  { id: "kubernetes", name: "Kubernetes" },
] as const;

/**
 * The least a computer needs to run every part of OpenBot itself.
 *
 * From the installer's own checks: the engine needs 4 CPUs and 40 GiB of free disk
 * (`local_eval::MIN_ENGINE_CPUS`, `MIN_ENGINE_FREE_DISK_BYTES`), and OpenBot's own machine takes 6 to
 * 8 GiB of memory while 4 GiB is kept for the computer itself (`machine_size.rs`). Memory is said as
 * 16 GB, room for that plus the person's own apps, as decided with David on 13 Nov 2026.
 */
export const SELF_CONTAINED_NEEDS = [
  "A Mac or a 64-bit Windows PC",
  "16 GB of memory or more",
  "4 CPU cores or more",
  "40 GB of free disk space",
] as const;

/** Where OpenBot runs: on this computer, or at an address this app connects to. */
export type Hosting = "this-computer" | "connect";

/**
 * Where OpenBot runs, and what that asks of this computer, before it asks for anything else.
 *
 * First the ways to run OpenBot. OpenBot (Self-Contained) runs everything on this computer, for
 * trying it or personal use. OpenBot for Business is one card with its two ways to run, Cloud and
 * Self-Hosted on a company's own cloud or on-prem, and either books a call with us: OpenBot for
 * Business is a meeting booker. Then what the choice needs. For Self-Contained that is what this
 * computer needs and why, which is that every part of OpenBot runs on it, how long setup takes, and
 * Install, and it fits the window's default size (1000×800, less a title bar) with no scrollbar.
 * For OpenBot for Business it is the app's OpenBot for Business view: what it adds and the booking
 * calendar (`BusinessBooker`), which scrolls in the card as any tall step does.
 *
 * Connecting this app to the OpenBot a company already runs is the link under the rows ("Already
 * have OpenBot at work?"), which opens the address and Connect (`ConnectToOpenBot`). While that
 * shows, no row is picked: it is none of them. Usage data is not said here: it is the last
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
   * it runs. Self-Contained's way on is Continue, which goes on with that setup; there is nothing to
   * install or download first.
   */
  resumes?: boolean;
  /** Connecting to the OpenBot a company already runs was picked. */
  onConnect: () => void;
  /** This computer was picked again. May fail, when a saved connection has to be switched first. */
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
  // One of OpenBot for Business's two picked: its booker shows, whatever the app holds as the choice.
  const [business, setBusiness] = useState<BusinessChoice | null>(null);
  const shown = business ? "business" : hosting;
  // While it checks an address or waits on the browser, Cancel is the way out.
  const held = shown === "connect" && connecting.busy;
  const rowClass = (chosen: boolean, base = "tile") =>
    chosen ? `${base} chosen` : held ? `${base} held` : base;
  // Asked for by the link under the rows: the address field has the focus once it shows.
  const [focusField, setFocusField] = useState(false);
  useEffect(() => {
    if (!focusField || shown !== "connect") return;
    connecting.field.current?.focus();
    setFocusField(false);
  }, [focusField, shown, connecting.field]);
  const connectToIt = () => {
    setBusiness(null);
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
        <label className={rowClass(shown === "this-computer")}>
          <input
            type="radio"
            name="hosting"
            className="tile-input"
            value="this-computer"
            checked={shown === "this-computer"}
            disabled={held}
            onChange={() => {
              setBusiness(null);
              if (hosting === "connect") void connecting.leave();
            }}
          />
          <HostingMark>
            <IconDeviceLaptop stroke={1.75} />
          </HostingMark>
          <span className="tile-name">OpenBot (Self-Contained)</span>
          <span className="tile-summary">{SELF_CONTAINED_SUMMARY}</span>
        </label>
        {/* OpenBot for Business, its two ways in one card: both book a call. */}
        <fieldset
          className={rowClass(shown === "business", "tile-group")}
          aria-labelledby="business-name"
        >
          <HostingMark>
            <IconBuilding stroke={1.75} />
          </HostingMark>
          <span className="tile-name" id="business-name">
            OpenBot for Business
          </span>
          <span className="tile-summary">
            For your whole team. Book a call to see it.
          </span>
          <div className="tile-options">
            {BUSINESS_CHOICES.map((choice) => (
              <label
                key={choice.id}
                className={rowClass(business === choice.id, "tile-option")}
              >
                <input
                  type="radio"
                  name="hosting"
                  className="tile-input"
                  value={`business-${choice.id}`}
                  checked={business === choice.id}
                  disabled={held}
                  onChange={() => setBusiness(choice.id)}
                />
                <choice.icon
                  className="tile-option-icon"
                  aria-hidden="true"
                  stroke={1.75}
                />
                <span className="tile-option-text">
                  <span className="tile-option-name">{choice.name}</span>
                  <span className="tile-option-summary">{choice.summary}</span>
                </span>
                {choice.id === "own-cloud" && (
                  <span className="cloud-marks">
                    {CLOUDS.map((cloud) => (
                      <span className="cloud-mark" key={cloud.id}>
                        <MarkImage id={cloud.id} name={cloud.name} />
                      </span>
                    ))}
                  </span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
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
        <SelfContained
          startDownloads={startDownloads}
          onInstall={onInstall}
          failure={failure}
          resumes={resumes}
        />
      )}
    </div>
  );
}

/** What Self-Contained asks of this computer and why, then the way on. */
function SelfContained({
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
          Every part of OpenBot runs on this computer: the app, its server and
          database, your Bots&apos; memory, and a computer for each Bot to work
          on.
        </p>
        <ul className="needs-list">
          {SELF_CONTAINED_NEEDS.map((need) => (
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
