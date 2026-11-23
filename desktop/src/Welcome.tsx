import {
  IconBuilding,
  IconCloud,
  IconDeviceLaptop,
  IconServer2,
} from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { BusinessBooker } from "./BusinessBooker";
import { CloudSignIn, cloudAddress, cloudEnabled } from "./CloudSignIn";
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

/** The way to OpenBot (Self-Contained) at the foot of the first screen, with OpenBot Cloud on. */
export const SELF_CONTAINED_ASIDE = "Want everything to run on this computer?";

/** What the second choice is: OpenBot as we run it, signed in to from here and on the web. */
export const CLOUD_SUMMARY = "Use OpenBot here. Your Bots run in our cloud.";

/** OpenBot for Business: on a company's own cloud or on-prem, which books a demo. */
export const BUSINESS_SUMMARY = "Your own cloud or on-prem. Book a demo.";

/**
 * Where OpenBot Cloud is off in this build (`cloudEnabled`), OpenBot for Business is one card with
 * its two ways to run, and either books a call (`BusinessBooker`).
 */
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
 * trying it or personal use. OpenBot Cloud is the OpenBot we run, at an address built into this app
 * (`cloudAddress`): the person signs in with their OpenBot account and this window shows the same
 * account, organizations, Bots and conversations as the web app. OpenBot for Business is Self-Hosted
 * on a company's own cloud or on-prem, and books a call with us. Then what the choice needs. For
 * Self-Contained that is what this computer needs and why, which is that every part of OpenBot runs
 * on it, how long setup takes, and Install, and it fits the window's default size (1000×800, less a
 * title bar) with no scrollbar. For OpenBot Cloud it is Sign in to OpenBot Cloud (`CloudSignIn`).
 * For OpenBot for Business it is the app's OpenBot for Business view: what it adds and the booking
 * calendar (`BusinessBooker`), which scrolls in the card as any tall step does.
 *
 * OpenBot Cloud shows only in a build that turns it on (`VITE_OPENBOT_CLOUD_ENABLED`, `cloudEnabled`).
 * There the screen steers to OpenBot Cloud and OpenBot for Business. They are the two rows, Cloud
 * first and picked to begin with, then the link to connect to a company's own OpenBot, then what the
 * choice shows. OpenBot (Self-Contained) is a line at the very foot of the card, below all of that:
 * never picked to begin with, never the way back from anywhere. Opened, it shows what this computer
 * needs and Install there, and neither row is picked. The one exception is a setup on this computer
 * that failed: the failure is Self-Contained's to show, so it opens there. The order on screen is
 * the order for the keyboard and a screen reader.
 *
 * Otherwise the rows are OpenBot (Self-Contained) and OpenBot for Business as one card with its two
 * ways to run, Cloud and Self-Hosted, either of which books a call; and a saved connection to Cloud's
 * address is any other saved connection.
 *
 * Connecting this app to the OpenBot a company already runs is the link under the rows ("Already
 * have OpenBot at work?"), which opens the address and Connect (`ConnectToOpenBot`). While that
 * shows, no row is picked: it is none of them. A saved connection to OpenBot Cloud whose sign-in
 * ended opens on OpenBot Cloud, to sign in again. Usage data is not said here: it is the last
 * screen's choice (`UsageDataChoice`).
 *
 * The big downloads start with Install (`startDownloads`), the moment the person chooses this
 * computer, and never before: somebody who connects to an OpenBot elsewhere downloads nothing.
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
  const cloudOn = cloudEnabled();
  const cloud = cloudAddress();
  // The connection saved is OpenBot Cloud's: what the launch found about it is Cloud's to say.
  const savedIsCloud =
    cloudOn &&
    Boolean(saved?.address) &&
    saved?.address?.replace(/\/+$/, "") === cloud;
  const connecting = useConnectToOpenBot({
    ...(savedIsCloud ? {} : saved),
    onThisComputer,
  });
  const signingIn = useConnectToOpenBot({
    address: cloud,
    ...(savedIsCloud ? { problem: saved?.problem, reopen: saved?.reopen } : {}),
    onThisComputer,
  });
  // OpenBot Cloud or OpenBot for Business picked: shown whatever the app holds as the choice. With
  // Cloud on, Cloud is picked to begin with, unless setup on this computer failed and says so.
  const firstPick = cloudOn && !failure ? "cloud" : null;
  const [picked, setPicked] = useState<"cloud" | "business" | null>(() =>
    hosting === "connect" ? (savedIsCloud ? "cloud" : null) : firstPick,
  );
  // With Cloud off, which of OpenBot for Business's two ways is picked: both book a demo.
  const [businessWay, setBusinessWay] = useState<BusinessChoice | null>(null);
  // Picked by the person, not opened on: Cloud's button takes the focus.
  const [pickedNow, setPickedNow] = useState(false);
  const shown = picked ?? hosting;
  // While it checks an address or waits on the browser, Cancel is the way out.
  const held =
    (shown === "connect" && connecting.busy) ||
    (shown === "cloud" && signingIn.busy);
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
    setPicked(null);
    setBusinessWay(null);
    setFocusField(true);
    if (hosting !== "connect") onConnect();
  };
  const pick = (choice: "cloud" | "business") => {
    setPicked(choice);
    setPickedNow(true);
  };
  const pickBusinessWay = (way: BusinessChoice) => {
    setBusinessWay(way);
    setPicked("business");
  };
  const pickThisComputer = () => {
    setPicked(null);
    setBusinessWay(null);
    if (hosting === "connect") void connecting.leave();
  };
  // Back from the address: the choices again, with what the screen first picks picked.
  const back = () => {
    if (firstPick) {
      setPicked(firstPick);
      setBusinessWay(null);
    } else {
      pickThisComputer();
    }
  };
  // Under the rows and not one of them: somebody whose company already runs OpenBot connects this
  // app to it. Gone while the address shows, since that is where it leads.
  const connectAside = shown !== "connect" && (
    <p className="tile-aside">
      Already have OpenBot at work?{" "}
      <button
        type="button"
        className="text-link inline-link"
        disabled={held}
        onClick={connectToIt}
      >
        Connect to it
      </button>
      .
    </p>
  );
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
        {!cloudOn && (
          <label className={rowClass(shown === "this-computer")}>
            <input
              type="radio"
              name="hosting"
              className="tile-input"
              value="this-computer"
              checked={shown === "this-computer"}
              disabled={held}
              onChange={pickThisComputer}
            />
            <HostingMark>
              <IconDeviceLaptop stroke={1.75} />
            </HostingMark>
            <span className="tile-name">OpenBot (Self-Contained)</span>
            <span className="tile-summary">{SELF_CONTAINED_SUMMARY}</span>
          </label>
        )}
        {cloudOn ? (
          <>
            <label className={rowClass(shown === "cloud")}>
              <input
                type="radio"
                name="hosting"
                className="tile-input"
                value="cloud"
                checked={shown === "cloud"}
                disabled={held}
                onChange={() => pick("cloud")}
              />
              <HostingMark>
                <IconCloud stroke={1.75} />
              </HostingMark>
              <span className="tile-name">OpenBot Cloud</span>
              <span className="tile-summary">{CLOUD_SUMMARY}</span>
            </label>
            <label
              className={rowClass(shown === "business", "tile with-marks")}
            >
              <input
                type="radio"
                name="hosting"
                className="tile-input"
                value="business"
                checked={shown === "business"}
                disabled={held}
                onChange={() => pick("business")}
              />
              <HostingMark>
                <IconBuilding stroke={1.75} />
              </HostingMark>
              <span className="tile-name">OpenBot for Business</span>
              <span className="tile-summary">{BUSINESS_SUMMARY}</span>
              <CloudMarks />
            </label>
            {connectAside}
          </>
        ) : (
          /* OpenBot for Business, its two ways in one card: both book a demo. */
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
              For your whole team. Book a demo to see it.
            </span>
            <div className="tile-options">
              {BUSINESS_CHOICES.map((choice) => (
                <label
                  key={choice.id}
                  className={rowClass(
                    shown === "business" && businessWay === choice.id,
                    "tile-option",
                  )}
                >
                  <input
                    type="radio"
                    name="hosting"
                    className="tile-input"
                    value={`business-${choice.id}`}
                    checked={shown === "business" && businessWay === choice.id}
                    disabled={held}
                    onChange={() => pickBusinessWay(choice.id)}
                  />
                  <choice.icon
                    className="tile-option-icon"
                    aria-hidden="true"
                    stroke={1.75}
                  />
                  <span className="tile-option-text">
                    <span className="tile-option-name">{choice.name}</span>
                    <span className="tile-option-summary">
                      {choice.summary}
                    </span>
                  </span>
                  {choice.id === "own-cloud" && <CloudMarks />}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {!cloudOn && connectAside}
      </fieldset>
      {shown === "connect" ? (
        <ConnectToOpenBot connecting={connecting} onBack={back} />
      ) : shown === "cloud" ? (
        <CloudSignIn connecting={signingIn} focus={pickedNow} />
      ) : shown === "business" ? (
        <BusinessBooker />
      ) : cloudOn ? null : (
        <SelfContained
          startDownloads={startDownloads}
          onInstall={onInstall}
          failure={failure}
          resumes={resumes}
        />
      )}
      {cloudOn && (
        /* The foot of the card, below everything else: OpenBot, whole, on this computer. A line
           with a link until it is opened, then what this computer needs and Install. */
        <section
          className="this-computer-foot"
          aria-label="Run on this computer"
        >
          {shown === "this-computer" ? (
            <>
              <p className="this-computer-aside">
                <span className="this-computer-name">
                  OpenBot (Self-Contained)
                </span>{" "}
                {SELF_CONTAINED_SUMMARY}
              </p>
              <SelfContained
                startDownloads={startDownloads}
                onInstall={onInstall}
                failure={failure}
                resumes={resumes}
              />
            </>
          ) : (
            <p className="this-computer-aside">
              {SELF_CONTAINED_ASIDE}{" "}
              <button
                type="button"
                className="text-link inline-link"
                disabled={held}
                onClick={pickThisComputer}
              >
                Use OpenBot (Self-Contained)
              </button>
              .
            </p>
          )}
        </section>
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

/** The clouds OpenBot for Business runs on, by their marks. */
function CloudMarks() {
  return (
    <span className="cloud-marks">
      {CLOUDS.map((each) => (
        <span className="cloud-mark" key={each.id}>
          <MarkImage id={each.id} name={each.name} />
        </span>
      ))}
    </span>
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
