import {
  type Icon,
  IconBell,
  IconBook,
  IconBrain,
  IconBuilding,
  IconCircleCheck,
  IconClock,
  IconCloud,
  IconDeviceLaptop,
  IconFiles,
  IconMessages,
  IconPlug,
  IconRobot,
  IconTarget,
  IconUser,
} from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { BusinessBooker } from "./BusinessBooker";
import { cloudAddress, cloudHost, cloudWebAddress } from "./CloudSignIn";
import { ExternalLink } from "./ExternalLink";
import { asProblem, type Problem } from "./Problem";
import {
  type Progress,
  SetupProgress,
  StatusLine,
  StepFooter,
} from "./SetupProgress";
import {
  BUSINESS_SUMMARY,
  CLOUD_TRIAL,
  CloudMarks,
  HostingMark,
} from "./Welcome";

/**
 * Whether this window offers the move to OpenBot Cloud, as the shell answers `move_offer`. `due`:
 * OpenBot is set up and runs on this computer, and the person has never answered, or kept OpenBot
 * here after a move that failed and the app has updated since (once). `fromSettings`:
 * Settings' "Move to OpenBot Cloud" sent the window here, answered once. `footprintBytes`: what
 * OpenBot's own files take on this computer now, which the move removes, or null when it isn't
 * measured yet (the window then asks `move_footprint`) or couldn't be. The finished move's
 * `removedBytes` counts the same files the same way.
 */
export type MoveOffer = {
  due: boolean;
  fromSettings: boolean;
  footprintBytes: number | null;
};

/**
 * One app connection that doesn't move, connected again in OpenBot Cloud: a sign-in, which stays
 * with the service it was made through, or an app meant to move connected that OpenBot Cloud
 * couldn't connect, with `reason`, OpenBot Cloud's own sentence for why.
 */
export type ReconnectApp = {
  appId: string;
  appName: string;
  accountLabel?: string;
  iconUrl?: string;
  botNames?: string[];
  reason?: string;
};

/**
 * One app connected with a key, which moves connected: its key sealed so only the person's OpenBot
 * Cloud account can read it, and the app connected there with it.
 */
export type CarriedApp = {
  appId: string;
  appName: string;
  iconUrl?: string;
  botNames?: string[];
};

/** What the move would take, read from the OpenBot running on this computer (`move_preview`). */
export type MovePreview = {
  counts: { kind: string; count: number }[];
  apps: ReconnectApp[];
  /** The apps that move connected. Absent from an older shell: none. */
  carried?: CarriedApp[];
  footprintBytes: number | null;
  /** This computer has an AI key the move can bring along, sealed for the person's Cloud account. */
  modelKeysAvailable: boolean;
};

/** What a finished move answers (`move_to_cloud`). */
export type Moved = {
  /** What the move removed of OpenBot's files, counted as `footprintBytes` counts them. */
  removedBytes: number | null;
  /** How much more free space the disk showed right after, which can be less for a while. */
  diskGainedBytes: number | null;
  apps: ReconnectApp[];
  /** The apps that came across connected. Absent from an older shell: none. */
  carried?: CarriedApp[];
  /** Plain sentences from OpenBot Cloud about things that moved differently. */
  notes: string[];
  /** Plain sentences about what couldn't be removed from this computer after the move. */
  leftBehind: string[];
  /**
   * OpenBot Cloud still needs the person's AI before their Bots can run: true, false, or null (or
   * absent, from an older shell) when it couldn't be asked. Only true changes the result.
   */
  connectAi?: boolean | null;
  /**
   * The OpenBot Cloud account the move went into: the email the person signed in with and the
   * organization's name. Null (or absent, from an older shell) when it couldn't be asked.
   */
  account?: MovedAccount | null;
};

/** The OpenBot Cloud account and organization a move went into (`Moved.account`). */
export type MovedAccount = {
  email: string;
  organization?: string | null;
};

/**
 * One organization the person belongs to on OpenBot Cloud, which their Bots can move into
 * (`move_destinations`). `canMoveIn`: OpenBot Cloud lets them use Bots there. False, the move is
 * refused before anything moves, so the window shows it and can't pick it.
 */
export type MoveDestination = {
  id: string;
  name: string;
  personal: boolean;
  canMoveIn: boolean;
};

/** Said on an organization the person can't move their Bots into. */
export const NOT_ALLOWED_HERE =
  "An admin of this organization hasn't let you use Bots here.";

/** The person's own organization first, then the others, in the order OpenBot Cloud lists them. */
export function destinationsInOrder(
  destinations: MoveDestination[],
): MoveDestination[] {
  return [
    ...destinations.filter((destination) => destination.personal),
    ...destinations.filter((destination) => !destination.personal),
  ];
}

/**
 * The organization picked to begin with: the one chosen before (Try again), or the person's own,
 * which is where the move went before they could choose, or else the first they can move into.
 */
export function firstPick(
  destinations: MoveDestination[],
  before: string | null,
): string | null {
  const open = destinations.filter((destination) => destination.canMoveIn);
  return (
    open.find((destination) => destination.id === before)?.id ??
    open.find((destination) => destination.personal)?.id ??
    open[0]?.id ??
    null
  );
}

/** "You're signed in as sam@example.com, in Sam's organization." Said under the result's heading. */
export function signedInAsSaid(account: MovedAccount): string {
  const organization = account.organization?.trim();
  return organization
    ? `You're signed in as ${account.email}, in ${organization}.`
    : `You're signed in as ${account.email}.`;
}

/**
 * Where the result says OpenBot Cloud is in a browser, and as whom to sign in there: the place a
 * person who goes to the website looks for the Bots they moved.
 */
export function inABrowserSaid(
  account: MovedAccount | null | undefined,
): string {
  const host = cloudHost();
  return account
    ? `In a browser, OpenBot Cloud is at ${host}. Sign in there as ${account.email}.`
    : `In a browser, OpenBot Cloud is at ${host}.`;
}

export type MoveStage =
  | "sign-in"
  | "export"
  | "upload"
  | "import"
  | "verify"
  | "remove";

/** The shell's `move:progress` event. `progress` (0 to 1) only for packing up and sending. */
export type MoveProgress = {
  stage: MoveStage;
  state: "running" | "done";
  progress?: number;
};

/** The move's rows, in order, as the person reads them. */
export const MOVE_STAGES: readonly { stage: MoveStage; label: string }[] = [
  { stage: "sign-in", label: "Signing in to OpenBot Cloud" },
  { stage: "export", label: "Packing up your Bots and their work" },
  { stage: "upload", label: "Sending to OpenBot Cloud" },
  { stage: "import", label: "Adding them to OpenBot Cloud" },
  { stage: "verify", label: "Checking everything arrived" },
  { stage: "remove", label: "Removing OpenBot from this computer" },
];

/** What moves, said the same way on every screen. */
export const WHAT_MOVES =
  "Your Bots, conversations, memory, skills, routines and files";

/** The promise every screen before the end keeps. */
export const NOTHING_REMOVED_UNTIL_CHECKED =
  "Nothing is removed from this computer until everything has arrived in OpenBot Cloud and been checked.";

/** Under the choice while Keep is picked: the move stays on offer. */
export const MOVE_LATER_IN_SETTINGS =
  "You can still move to OpenBot Cloud later in Settings.";

/** Why an app the person signed in to doesn't move, said on the preview. */
export const SIGN_INS_CANT_MOVE =
  "Sign-ins can't move, so you'll sign in to each one again.";

/** The same, said on the result, over each app's Reconnect. */
export const SIGN_INS_DIDNT_MOVE =
  "Sign-ins can't move, so sign in to each one again.";

/** The same, on a result that sends the person to Connect your AI first. */
export const SIGN_INS_AFTER_AI =
  "Sign-ins can't move. Once your AI is connected, you'll reconnect each one from a list in OpenBot Cloud.";

/** Over the apps connected with a key, on the preview. */
export const CARRIED_HEADING = "These apps come across connected";

/** Why they can: said in the voice of the AI key's own line. */
export const CARRIED_SEALED =
  "Their keys are sealed so only your OpenBot Cloud account can read them.";

/** Over the apps that came across connected, on the result. */
export const CARRIED_DONE_HEADING = "These apps came across connected";

/** What that means for the person's Bots. */
export const CARRIED_DONE_SAID =
  "Your Bots can use them in OpenBot Cloud as before.";

/** Said when a move stopped: the one thing the person needs to know first. */
export const NOTHING_WAS_REMOVED = "Nothing was removed from this computer.";

/** The words for each kind the preview counts, in the order they are listed. */
const KINDS: readonly {
  kind: string;
  one: string;
  many: string;
  icon: Icon;
}[] = [
  { kind: "bots", one: "Bot", many: "Bots", icon: IconRobot },
  { kind: "skills", one: "skill", many: "skills", icon: IconBook },
  {
    kind: "conversations",
    one: "conversation",
    many: "conversations",
    icon: IconMessages,
  },
  { kind: "memories", one: "memory", many: "memories", icon: IconBrain },
  { kind: "routines", one: "routine", many: "routines", icon: IconClock },
  { kind: "goals", one: "goal", many: "goals", icon: IconTarget },
  { kind: "check-ins", one: "check-in", many: "check-ins", icon: IconBell },
  { kind: "files", one: "file", many: "files", icon: IconFiles },
];

/**
 * The preview's counts as a person reads them: "3 Bots", "42 conversations". Only the kinds there are
 * words for, in their order, and none that is zero. A kind a later OpenBot adds is left out until
 * this list names it, and settings and AI keys are never a count. Nor are messages: the count holds
 * every record of a conversation, a Bot's tool steps included, so on the test boxes a person who sent
 * 6 messages and got 6 replies read "39 messages". Conversations say what moves.
 */
export function countLines(
  counts: MovePreview["counts"],
): { kind: string; said: string; icon: Icon }[] {
  return KINDS.flatMap(({ kind, one, many, icon }) => {
    const count = counts
      .filter((each) => each.kind === kind)
      .reduce((sum, each) => sum + each.count, 0);
    if (count <= 0) return [];
    return [
      {
        kind,
        said: `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`,
        icon,
      },
    ];
  });
}

/**
 * What the move removes, as the choice says it. The result says the same figure, counted the same
 * way: "OpenBot files", never "frees", because the disk can show less of it free for a while.
 */
export function removesSaid(bytes: number): string {
  return `This removes about ${formatSpace(bytes)} of OpenBot files from this computer.`;
}

/**
 * Whether the disk showed much less free space than the move removed. Seen on a Mac: 20.2 GB of
 * files removed and 4.5 GB more free at once, the rest most likely kept by a local snapshot taken a
 * few minutes before. A gap of a tenth or so (12.0 GB removed, 10.8 GB more free on a Windows box)
 * is the disk's own bookkeeping and isn't said.
 */
export function heldBack(moved: Moved): boolean {
  return (
    moved.removedBytes != null &&
    moved.diskGainedBytes != null &&
    moved.diskGainedBytes < moved.removedBytes * 0.75
  );
}

/** Disk space as a person reads it: "18.4 GB", or "640 MB" under a gigabyte. */
export function formatSpace(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** "Inbox helper", "Inbox helper and Standup", "Inbox helper, Standup and 2 more". */
function namesSaid(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** The setup window asks this once per page, at its first handover. An older shell: never due. */
export function askMoveOffer(cloud: boolean): Promise<MoveOffer | null> {
  return invoke<MoveOffer>("move_offer", { cloud }).catch(() => null);
}

/** Whether the offer means the move's screens show before OpenBot does. */
export function moveOffered(offer: MoveOffer | null): offer is MoveOffer {
  return Boolean(offer && (offer.due || offer.fromSettings));
}

type StageState = "pending" | "running" | "done" | "failed";
type Stages = Record<MoveStage, { state: StageState; progress?: number }>;

function freshStages(): Stages {
  return Object.fromEntries(
    MOVE_STAGES.map(({ stage }) => [stage, { state: "pending" }]),
  ) as Stages;
}

/** One event applied: a stage that runs or is done means every stage before it is done. */
function advance(stages: Stages, event: MoveProgress): Stages {
  const at = MOVE_STAGES.findIndex(({ stage }) => stage === event.stage);
  if (at === -1) return stages;
  const next = { ...stages };
  MOVE_STAGES.forEach(({ stage }, index) => {
    if (index < at) next[stage] = { state: "done" };
  });
  next[event.stage] =
    event.state === "done"
      ? { state: "done" }
      : { state: "running", progress: event.progress };
  return next;
}

/** Where a failed move stopped: the stage running then, or the first one not done. */
function stopped(stages: Stages): Stages {
  const running = MOVE_STAGES.find(
    ({ stage }) => stages[stage].state === "running",
  );
  const first =
    running ??
    MOVE_STAGES.find(({ stage }) => stages[stage].state === "pending");
  if (!first) return stages;
  return { ...stages, [first.stage]: { state: "failed" } };
}

function stageRows(stages: Stages): Progress[] {
  return MOVE_STAGES.map(({ stage, label }) => {
    const { state, progress } = stages[stage];
    const share =
      state === "running" && progress != null
        ? Math.round(Math.min(1, Math.max(0, progress)) * 100)
        : null;
    return {
      step: label,
      ok: state !== "failed",
      running: state === "running",
      pending: state === "pending",
      detail:
        stage === "sign-in" && state === "running"
          ? "Finish signing in in your browser."
          : share !== null
            ? stage === "upload"
              ? `${share}% sent.`
              : `${share}% packed.`
            : "",
    };
  });
}

/**
 * The OpenBot on this computer, as the move needs it, when the move is offered before it started:
 * what moves is read from it, so it starts once the person picks OpenBot Cloud, updated to this
 * app's release on the way. `stopped`: not started yet. `starting`: starting for the move. `up`:
 * running, so what moves can be read. `failed`: it didn't start, and why.
 */
export type MoveHere =
  | { at: "stopped" }
  | { at: "starting" }
  | { at: "up" }
  | { at: "failed"; problem: Problem };

/** Said on the confirm screen while OpenBot starts for the move, which can take minutes. */
export const GETTING_READY_TO_MOVE =
  "Getting your Bots ready to move. This can take a few minutes.";

type Screen =
  | { at: "choice" }
  | { at: "confirm" }
  | { at: "moving" }
  | { at: "where"; destinations: MoveDestination[] }
  | { at: "failed"; problem: Problem }
  | { at: "done"; moved: Moved };

/**
 * The move to OpenBot Cloud, in the setup window, for a person who runs OpenBot (Self-Contained):
 * offered once after an update, or opened from Settings.
 *
 * 1. The choice: OpenBot Cloud, recommended and picked to begin with, or keep everything here. With
 *    the space the move frees. Keep is recorded and not asked again at launch, except once after the
 *    next update when it followed a failed move (`onKeep`). Between them,
 *    OpenBot for Business, which books a demo (`BusinessBooker`, stacked for the card) and
 *    moves nothing: while it is picked there is no Continue and no Keep.
 * 2. What moves, from the OpenBot running here (`move_preview`). What the person acts on comes
 *    first: the apps they signed in to, which can't move, by name, to reconnect in OpenBot Cloud,
 *    then bringing the AI key. The apps connected with a key, which come across connected
 *    (`carried`), come last. Settings opens here. Offered at launch, before OpenBot started
 *    (`here`), it starts now (`onGetReady`), and the figures arrive once it is up.
 * 3. The move (`move_to_cloud`): sign in through the browser, pack up, send, add, check, and only
 *    then remove OpenBot from this computer, each a row (`move:progress`).
 * 4. A move that stopped removed nothing: the sentence, Try again, or keep OpenBot here.
 * 5. Done: the space freed, the apps to reconnect (one meant to come across that OpenBot Cloud
 *    couldn't connect says why), each opening its own connect page in OpenBot Cloud in this window
 *    (`open_moved_cloud`), then the apps that came across connected, and Open OpenBot, which opens
 *    the list of apps to reconnect when there are any. When OpenBot Cloud still needs the person's
 *    AI (`connectAi`), Connect your AI comes first and is the only way on: the apps are named as the
 *    step after it, with nothing on them to press. It names the account and organization the move went into
 *    (`account`), and where OpenBot Cloud is in a browser, with Open in browser: on 1.2.0-rc.3 a
 *    person who moved went to the website, signed in with another account and found nothing.
 */
export function MoveToCloud({
  offer,
  onKeep,
  here,
  onGetReady,
}: {
  offer: MoveOffer;
  /** Keep OpenBot here: recorded, then OpenBot shows, or starts as it would have. */
  onKeep: () => Promise<void>;
  /** The OpenBot here, when the move was offered before it started. Absent: it is running. */
  here?: MoveHere;
  /** Start the OpenBot here for the move: the person picked OpenBot Cloud. */
  onGetReady?: () => void;
}) {
  const [screen, setScreen] = useState<Screen>(
    offer.fromSettings ? { at: "confirm" } : { at: "choice" },
  );
  const [keeping, setKeeping] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /*
   * What OpenBot's files take here. The shell answers the question at once and measures this on its
   * own (`move_footprint`): on a Mac with two older installs on its disk, measuring it first held
   * the question back 15 seconds. Until it arrives, or if it never does, the screens say the move
   * without it.
   *
   * One figure for what the move removes, the same on both screens. Offered before the OpenBot here
   * started (`here`), its start for the move updates it first and adds the new release's files: a
   * Mac said 23.1 GB on the choice and 26.6 GB on the next screen. So then the choice says no
   * figure, and the next screen says the one measured from the OpenBot that moves (`move_preview`).
   * Offered over it running, the next screen keeps the figure the choice said, and a size measured
   * after the person left the choice is not taken.
   */
  const [sizedOnChoice] = useState(() => !here && !offer.fromSettings);
  const [footprintBytes, setFootprintBytes] = useState(
    sizedOnChoice ? offer.footprintBytes : null,
  );
  const onChoice = screen.at === "choice";
  useEffect(() => {
    if (!sizedOnChoice || !onChoice || offer.footprintBytes != null) return;
    let current = true;
    invoke<number | null>("move_footprint")
      .then((bytes) => {
        if (current && typeof bytes === "number") setFootprintBytes(bytes);
      })
      .catch(() => {
        // An older shell sends the size with the answer, or not at all.
      });
    return () => {
      current = false;
    };
  }, [sizedOnChoice, onChoice, offer.footprintBytes]);
  const keep = async () => {
    setKeeping(true);
    try {
      await invoke("keep_self_contained").catch((error) =>
        console.warn("keep_self_contained", error),
      );
      await onKeep();
    } finally {
      if (alive.current) setKeeping(false);
    }
  };

  // What moves: asked of the OpenBot running here once the confirm screen shows.
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [previewProblem, setPreviewProblem] = useState<Problem | null>(null);
  const loadPreview = useCallback(() => {
    setPreviewProblem(null);
    invoke<MovePreview>("move_preview")
      .then((found) => {
        if (alive.current) setPreview(found);
      })
      .catch((error) => {
        if (alive.current) setPreviewProblem(asProblem(error));
      });
  }, []);
  // Read from the OpenBot here, so only once it is up.
  const up = !here || here.at === "up";
  const wantsPreview = screen.at !== "choice" && preview === null && up;
  const asked = useRef(false);
  useEffect(() => {
    if (!wantsPreview || asked.current) return;
    asked.current = true;
    loadPreview();
  }, [wantsPreview, loadPreview]);
  // OpenBot Cloud picked: the OpenBot here starts for the move, if it hasn't yet.
  const toConfirm = () => {
    setScreen({ at: "confirm" });
    if (here?.at === "stopped") onGetReady?.();
  };
  const [includeKeys, setIncludeKeys] = useState(true);

  const [stages, setStages] = useState<Stages>(freshStages);
  const cancelled = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  // The organization the person chose last, picked again when Try again asks once more.
  const chose = useRef<string | null>(null);
  /*
   * Move pressed (or Try again): sign in, and the organizations the person belongs to on OpenBot
   * Cloud. One: the move goes straight on into it. More: they choose where their Bots go, and
   * Continue moves them there (`into`).
   */
  const move = async (into?: MoveDestination) => {
    cancelled.current = false;
    setCancelling(false);
    setStages(freshStages());
    setScreen({ at: "moving" });
    const stop = await listen<MoveProgress>("move:progress", (event) => {
      if (alive.current) setStages((now) => advance(now, event.payload));
    }).catch(() => null);
    try {
      let organization = into?.id;
      if (!into) {
        const destinations = await invoke<MoveDestination[] | null>(
          "move_destinations",
          { address: cloudAddress() },
        );
        if (!alive.current) return;
        if (Array.isArray(destinations) && destinations.length > 1) {
          setScreen({
            at: "where",
            destinations: destinationsInOrder(destinations),
          });
          return;
        }
        organization = Array.isArray(destinations)
          ? destinations[0]?.id
          : undefined;
      }
      const moved = await invoke<Moved>("move_to_cloud", {
        address: cloudAddress(),
        includeModelKeys: Boolean(preview?.modelKeysAvailable && includeKeys),
        ...(organization ? { organization } : {}),
      });
      if (alive.current) setScreen({ at: "done", moved });
    } catch (error) {
      if (!alive.current) return;
      const problem = asProblem(error);
      // Cancelled in the browser's wait: back to what moves, with nothing to say.
      if (cancelled.current && problem.kind === "sign-in") {
        setScreen({ at: "confirm" });
        return;
      }
      // Refused before anything was packed up: no step of the move failed, none had begun.
      if (problem.kind !== "move-not-allowed") setStages((now) => stopped(now));
      setScreen({ at: "failed", problem });
    } finally {
      stop?.();
    }
  };
  const cancel = () => {
    cancelled.current = true;
    setCancelling(true);
    invoke("cancel_move").catch((error) => console.warn("cancel_move", error));
  };

  if (screen.at === "choice")
    return (
      <Choice
        footprintBytes={footprintBytes}
        keeping={keeping}
        onCloud={toConfirm}
        onKeep={() => void keep()}
      />
    );
  if (screen.at === "confirm")
    return (
      <Confirm
        preview={preview}
        problem={here?.at === "failed" ? here.problem : previewProblem}
        gettingReady={here?.at === "starting" || here?.at === "stopped"}
        footprintBytes={footprintBytes ?? preview?.footprintBytes ?? null}
        includeKeys={includeKeys}
        onIncludeKeys={setIncludeKeys}
        keeping={keeping}
        onRetryPreview={
          here?.at === "failed" ? () => onGetReady?.() : loadPreview
        }
        onMove={() => void move()}
        onKeep={() => void keep()}
      />
    );
  if (screen.at === "moving") {
    const signingIn = stages["sign-in"].state === "running";
    return (
      <Sheet>
        <h1>Moving to OpenBot Cloud</h1>
        <p className="lede">
          Keep OpenBot open while it moves. This can take a few minutes.
        </p>
        <SetupProgress steps={stageRows(stages)} label="Move progress" />
        {/* Pinned, so Cancel shows in the smallest window while the rows scroll above it. */}
        <StepFooter>
          {signingIn && (
            <div className="row">
              <button
                type="button"
                className="quiet"
                disabled={cancelling}
                onClick={cancel}
              >
                Cancel
              </button>
            </div>
          )}
          <p className="footnote move-moving-footnote">
            {NOTHING_REMOVED_UNTIL_CHECKED}
          </p>
        </StepFooter>
      </Sheet>
    );
  }
  if (screen.at === "where")
    return (
      <Where
        destinations={screen.destinations}
        picked={firstPick(screen.destinations, chose.current)}
        onContinue={(destination) => {
          chose.current = destination.id;
          void move(destination);
        }}
      />
    );
  if (screen.at === "failed") {
    const { problem } = screen;
    return (
      <Sheet>
        <h1>
          {problem.kind === "sign-in"
            ? "Signing in didn't finish"
            : problem.kind === "move-mismatch"
              ? "Not everything arrived"
              : problem.kind === "move-not-allowed"
                ? "Your Bots can't move there"
                : "The move didn't finish"}
        </h1>
        <p className="lede">{problem.said}</p>
        <div className="local-alert needs move-safe" role="status">
          <h2>{NOTHING_WAS_REMOVED}</h2>
          <p>
            Your Bots and their work are on this computer, just as they were.
            {/* OpenBot Cloud said why it stopped, and what to do: no try again of our own. */}
            {problem.kind === "move-stopped"
              ? " You can keep using OpenBot here."
              : " You can try again, or keep using OpenBot here."}
          </p>
        </div>
        <SetupProgress steps={stageRows(stages)} label="Move progress" />
        {problem.detail && (
          <details className="detail-of move-detail" onToggle={showOpened}>
            <summary>Technical details</summary>
            <pre>{problem.detail}</pre>
          </details>
        )}
        {/*
         * Pinned, so Try again and Keep always show: on 1.2.0-rc.2 the technical details pushed
         * them past the card's foot at the window's default size, and Keep was never seen.
         */}
        <StepFooter>
          <div className="row">
            <button
              type="button"
              disabled={keeping}
              onClick={() => void move()}
            >
              Try again
            </button>
            <button
              type="button"
              className="quiet"
              disabled={keeping}
              onClick={() => void keep()}
            >
              Keep OpenBot on this computer
            </button>
          </div>
        </StepFooter>
      </Sheet>
    );
  }
  return <Done moved={screen.moved} />;
}

/**
 * Technical details, opened: the card scrolls them clear of the pinned foot, so opening them shows
 * them rather than opening them out of sight under the buttons.
 */
function showOpened(event: SyntheticEvent<HTMLDetailsElement>) {
  const details = event.currentTarget;
  const card = details.parentElement;
  const foot = card?.querySelector(":scope > .step-footer");
  if (!details.open || !card || !foot) return;
  const hidden =
    details.getBoundingClientRect().bottom - foot.getBoundingClientRect().top;
  if (hidden > 0) card.scrollTop += Math.ceil(hidden);
}

/** The card every move screen is drawn in, under OpenBot's mark, as the first screen is. */
function Sheet({ children }: { children: ReactNode }) {
  return (
    <div className="sheet move-sheet">
      <div className="lockup">
        <div className="orb" aria-hidden="true" />
        <span>
          OpenBot
          <sup className="trademark" aria-hidden="true">
            ™
          </sup>
        </span>
      </div>
      {children}
    </div>
  );
}

function Mark({ icon: Glyph }: { icon: Icon }) {
  return (
    <div className="mark-tile mark-icon" aria-hidden="true">
      <Glyph stroke={1.75} />
    </div>
  );
}

function Choice({
  footprintBytes,
  keeping,
  onCloud,
  onKeep,
}: {
  footprintBytes: number | null;
  keeping: boolean;
  onCloud: () => void;
  onKeep: () => void;
}) {
  const [picked, setPicked] = useState<"cloud" | "business" | "keep">("cloud");
  const rowClass = (chosen: boolean, base = "tile") =>
    chosen ? `${base} chosen` : base;
  return (
    <Sheet>
      <h1>Move to OpenBot Cloud?</h1>
      <p className="lede">
        Choose where OpenBot runs from now on. If you keep it here, you can
        still move later in Settings.
      </p>
      <fieldset className="picker hosting">
        <legend className="sr-only">Where OpenBot runs</legend>
        <label className={rowClass(picked === "cloud")}>
          <input
            type="radio"
            name="move"
            className="tile-input"
            value="cloud"
            checked={picked === "cloud"}
            disabled={keeping}
            onChange={() => setPicked("cloud")}
          />
          <Mark icon={IconCloud} />
          <span className="tile-name">
            OpenBot Cloud <span className="move-badge">Recommended</span>
          </span>
          <span className="tile-summary">
            {WHAT_MOVES} move to your OpenBot Cloud account.
            {footprintBytes != null && ` ${removesSaid(footprintBytes)}`}
            {` ${CLOUD_TRIAL}`}
          </span>
        </label>
        {/* The first screen's OpenBot for Business row: a company's own cloud or on-prem. */}
        <label className={rowClass(picked === "business", "tile with-marks")}>
          <input
            type="radio"
            name="move"
            className="tile-input"
            value="business"
            checked={picked === "business"}
            disabled={keeping}
            onChange={() => setPicked("business")}
          />
          <HostingMark>
            <IconBuilding stroke={1.75} />
          </HostingMark>
          <span className="tile-name">OpenBot for Business</span>
          <span className="tile-summary">{BUSINESS_SUMMARY}</span>
          <CloudMarks />
        </label>
        <label className={rowClass(picked === "keep")}>
          <input
            type="radio"
            name="move"
            className="tile-input"
            value="keep"
            checked={picked === "keep"}
            disabled={keeping}
            onChange={() => setPicked("keep")}
          />
          <Mark icon={IconDeviceLaptop} />
          <span className="tile-name">OpenBot (Self-Contained)</span>
          <span className="tile-summary">
            Everything stays on this computer, as it is now.
          </span>
        </label>
      </fieldset>
      {/* OpenBot for Business books a demo: it moves nothing and keeps nothing, so neither shows. */}
      {picked === "business" ? (
        <BusinessBooker layout="card" place="move_to_cloud" />
      ) : (
        <>
          <div className="row">
            {picked === "cloud" ? (
              <button type="button" onClick={onCloud}>
                Continue
              </button>
            ) : (
              <button type="button" disabled={keeping} onClick={onKeep}>
                Keep OpenBot on this computer
              </button>
            )}
          </div>
          {keeping ? (
            <StatusLine>Opening OpenBot…</StatusLine>
          ) : (
            <p className="footnote">
              {picked === "cloud"
                ? NOTHING_REMOVED_UNTIL_CHECKED
                : MOVE_LATER_IN_SETTINGS}
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

/**
 * Where the Bots go, for a person in more than one organization on OpenBot Cloud: the choice
 * screen's own rows, one per organization, their own first. One that doesn't let them use Bots is
 * shown, held, saying so. Continue moves them into the one picked.
 */
function Where({
  destinations,
  picked: first,
  onContinue,
}: {
  destinations: MoveDestination[];
  picked: string | null;
  onContinue: (destination: MoveDestination) => void;
}) {
  const [picked, setPicked] = useState(first);
  const chosen = destinations.find(
    (destination) => destination.id === picked && destination.canMoveIn,
  );
  return (
    <Sheet>
      <h1>Where should your Bots go?</h1>
      <p className="lede">
        You belong to more than one organization in OpenBot Cloud. Choose the
        one your Bots move to.
      </p>
      <fieldset className="picker hosting">
        <legend className="sr-only">Organization</legend>
        {destinations.map((destination) => (
          <label
            key={destination.id}
            className={
              !destination.canMoveIn
                ? "tile held"
                : destination.id === picked
                  ? "tile chosen"
                  : "tile"
            }
          >
            <input
              type="radio"
              name="destination"
              className="tile-input"
              value={destination.id}
              checked={destination.id === picked}
              disabled={!destination.canMoveIn}
              onChange={() => setPicked(destination.id)}
            />
            <Mark icon={destination.personal ? IconUser : IconBuilding} />
            <span className="tile-name">{destination.name}</span>
            <span className="tile-summary">
              {!destination.canMoveIn
                ? NOT_ALLOWED_HERE
                : destination.personal
                  ? "Your own organization."
                  : "An organization you belong to."}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button
          type="button"
          disabled={!chosen}
          onClick={() => chosen && onContinue(chosen)}
        >
          Continue
        </button>
      </div>
      <p className="footnote">{NOTHING_REMOVED_UNTIL_CHECKED}</p>
    </Sheet>
  );
}

function Confirm({
  preview,
  problem,
  gettingReady,
  footprintBytes,
  includeKeys,
  onIncludeKeys,
  keeping,
  onRetryPreview,
  onMove,
  onKeep,
}: {
  preview: MovePreview | null;
  problem: Problem | null;
  /** The OpenBot here is starting for the move, so what moves can't be read yet. */
  gettingReady: boolean;
  footprintBytes: number | null;
  includeKeys: boolean;
  onIncludeKeys: (include: boolean) => void;
  keeping: boolean;
  onRetryPreview: () => void;
  onMove: () => void;
  onKeep: () => void;
}) {
  const lines = preview ? countLines(preview.counts) : [];
  const carried = preview?.carried ?? [];
  return (
    <Sheet>
      <h1>Move to OpenBot Cloud</h1>
      <p className="lede">
        {lines.length > 0
          ? "Here's what moves to your OpenBot Cloud account."
          : `${WHAT_MOVES} move to your OpenBot Cloud account.`}
      </p>
      {problem ? (
        <div className="local-alert" role="alert">
          <p>{problem.said}</p>
          <div className="row">
            <button type="button" className="quiet" onClick={onRetryPreview}>
              Try again
            </button>
          </div>
        </div>
      ) : gettingReady ? (
        <StatusLine>{GETTING_READY_TO_MOVE}</StatusLine>
      ) : !preview ? (
        <StatusLine>Looking at what's on this computer…</StatusLine>
      ) : (
        <>
          {lines.length > 0 && (
            <ul className="move-counts" aria-label="What moves">
              {lines.map((line) => (
                <li key={line.kind}>
                  <line.icon stroke={1.75} aria-hidden="true" />
                  {line.said}
                </li>
              ))}
            </ul>
          )}
          {/* What the person acts on first: the apps to sign in to again, then the AI key. */}
          {preview.apps.length > 0 && (
            <section
              className="local-alert needs move-apps-notice"
              aria-labelledby="move-apps-heading"
            >
              <h2 id="move-apps-heading">
                You'll reconnect these apps in OpenBot Cloud
              </h2>
              <p>{SIGN_INS_CANT_MOVE}</p>
              <AppList apps={preview.apps} />
            </section>
          )}
          {preview.modelKeysAvailable ? (
            <label className="move-key">
              <input
                type="checkbox"
                checked={includeKeys}
                onChange={(event) => onIncludeKeys(event.target.checked)}
              />
              <span>
                <span className="move-key-name">
                  Bring my AI key to OpenBot Cloud
                </span>
                <span className="move-key-said">
                  It's sealed so only your OpenBot Cloud account can read it.
                  Without it, you'll connect your AI in OpenBot Cloud.
                </span>
              </span>
            </label>
          ) : (
            <p className="move-key-said move-key-none">
              You'll connect your AI in OpenBot Cloud after the move.
            </p>
          )}
          {/* Last, calm, in the bordered group: nothing to do for these. */}
          {carried.length > 0 && (
            <section
              className="move-then"
              aria-labelledby="move-carried-heading"
            >
              <h2 id="move-carried-heading">{CARRIED_HEADING}</h2>
              <p>{CARRIED_SEALED}</p>
              <AppList apps={carried} label="Apps that move connected" />
            </section>
          )}
        </>
      )}
      <StepFooter>
        <div className="row">
          <button type="button" disabled={!preview || keeping} onClick={onMove}>
            Move to OpenBot Cloud
          </button>
          <button
            type="button"
            className="quiet"
            disabled={keeping}
            onClick={onKeep}
          >
            Keep OpenBot on this computer
          </button>
        </div>
        {keeping ? (
          <StatusLine>Opening OpenBot…</StatusLine>
        ) : (
          <p className="footnote">
            {footprintBytes != null &&
              `Removes about ${formatSpace(footprintBytes)} of OpenBot files. `}
            {NOTHING_REMOVED_UNTIL_CHECKED}
          </p>
        )}
      </StepFooter>
    </Sheet>
  );
}

/**
 * App connections by name, with an action on each row when there is one: the apps to reconnect, or
 * (`label`) the apps that move connected. A row with a `reason` says it as its second line, where
 * the Bots that used it would be.
 */
function AppList({
  apps,
  action,
  label = "Apps to reconnect",
}: {
  apps: ReconnectApp[];
  action?: (app: ReconnectApp) => ReactNode;
  label?: string;
}) {
  return (
    <ul className="move-apps" aria-label={label}>
      {apps.map((app) => (
        <li key={app.appId} className="move-app">
          <AppMark app={app} />
          <span className="move-app-text">
            <span className="move-app-name">
              {app.appName}
              {app.accountLabel && (
                <span className="move-app-account">, {app.accountLabel}</span>
              )}
            </span>
            {app.reason ? (
              <span className="move-app-bots" data-move-app-reason="">
                {app.reason}
              </span>
            ) : (
              app.botNames &&
              app.botNames.length > 0 && (
                <span className="move-app-bots">
                  Used by {namesSaid(app.botNames)}
                </span>
              )
            )}
          </span>
          {action?.(app)}
        </li>
      ))}
    </ul>
  );
}

/** The app's own icon when there is one that loads, else a plain plug on the same tile. */
function AppMark({ app }: { app: ReconnectApp }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="move-app-mark" aria-hidden="true">
      {app.iconUrl && !broken ? (
        <img src={app.iconUrl} alt="" onError={() => setBroken(true)} />
      ) : (
        <IconPlug stroke={1.75} />
      )}
    </span>
  );
}

/**
 * Where the result opens OpenBot Cloud: the list of apps the move left to reconnect, or one app's
 * place in it, which opens that app's connect page and comes back to the list once it is
 * connected. OpenBot Cloud runs Connect your AI before either when the person still needs one,
 * then lands on the page asked for.
 */
export const RECONNECT_LIST = "/reconnect";

/**
 * One app's reconnect. The shell opens only a plain path of lowercase letters, digits, `-`, `_`
 * and `/`, at most 100 characters (`relay::app_page`), and anything else opens home. An app id it
 * can't carry opens the list instead, where the app is too.
 */
export function reconnectPage(app: ReconnectApp): string {
  const path = `${RECONNECT_LIST}/${app.appId}`;
  return /^[a-z0-9_-]+$/.test(app.appId) && path.length <= 100
    ? path
    : RECONNECT_LIST;
}

function Done({ moved }: { moved: Moved }) {
  const [opening, setOpening] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const open = async (path: string) => {
    setOpening(path);
    setProblem(null);
    try {
      await invoke("open_moved_cloud", { path });
    } catch (error) {
      setProblem(asProblem(error));
      setOpening(null);
    }
  };
  const notices = [...moved.notes, ...moved.leftBehind];
  // OpenBot Cloud sends a person with no AI to Connect your AI before any page, and then on to
  // the page they asked for: the list of apps that didn't move, each with Reconnect.
  const aiFirst = moved.connectAi === true;
  const carried = moved.carried ?? [];
  return (
    <Sheet>
      <h1>You're on OpenBot Cloud</h1>
      <p className="lede">
        {WHAT_MOVES} are in your OpenBot Cloud account now.
        {moved.account && ` ${signedInAsSaid(moved.account)}`}
      </p>
      {moved.removedBytes != null && moved.removedBytes > 0 && (
        <div className="move-freed">
          <IconCircleCheck stroke={1.75} aria-hidden="true" />
          <div>
            <p>
              <strong>
                {formatSpace(moved.removedBytes)} of OpenBot files removed
              </strong>{" "}
              from this computer
            </p>
            {heldBack(moved) && moved.diskGainedBytes != null && (
              <p className="move-freed-held">
                So far, {formatSpace(moved.diskGainedBytes)} of that is free
                space on your disk. Your computer can keep deleted files in a
                backup snapshot for a while before it frees their space.
              </p>
            )}
          </div>
        </div>
      )}
      {aiFirst && (
        <section
          className="local-alert needs move-ai-first"
          aria-labelledby="moved-ai-heading"
        >
          <h2 id="moved-ai-heading">Connect your AI first</h2>
          <p>
            Your Bots can't work in OpenBot Cloud until you connect your AI.
          </p>
        </section>
      )}
      {moved.apps.length > 0 &&
        (aiFirst ? (
          <section className="move-then" aria-labelledby="moved-apps-heading">
            <h2 id="moved-apps-heading">Then reconnect your apps</h2>
            <p>{SIGN_INS_AFTER_AI}</p>
            <AppList apps={moved.apps} />
          </section>
        ) : (
          <section
            className="local-alert needs move-apps-notice"
            aria-labelledby="moved-apps-heading"
          >
            <h2 id="moved-apps-heading">
              Reconnect your apps in OpenBot Cloud
            </h2>
            <p>{SIGN_INS_DIDNT_MOVE}</p>
            <AppList
              apps={moved.apps}
              action={(app) => (
                <button
                  type="button"
                  className="quiet move-app-action"
                  aria-label={`Reconnect ${app.appName}`}
                  disabled={opening !== null}
                  onClick={() => void open(reconnectPage(app))}
                >
                  Reconnect
                </button>
              )}
            />
          </section>
        ))}
      {/* After what the person acts on: nothing to do for these. */}
      {carried.length > 0 && (
        <section className="move-then" aria-labelledby="moved-carried-heading">
          <h2 id="moved-carried-heading">{CARRIED_DONE_HEADING}</h2>
          <p>{CARRIED_DONE_SAID}</p>
          <AppList apps={carried} label="Apps that came across connected" />
        </section>
      )}
      {notices.length > 0 && (
        <div className="move-notice" role="status">
          {notices.map((said) => (
            <p key={said}>{said}</p>
          ))}
        </div>
      )}
      {problem && (
        <div className="local-alert" role="alert">
          <p>{problem.said}</p>
        </div>
      )}
      <StepFooter>
        <div className="row">
          {aiFirst ? (
            <button
              type="button"
              disabled={opening !== null}
              onClick={() => void open(RECONNECT_LIST)}
            >
              Connect your AI
            </button>
          ) : (
            <button
              type="button"
              disabled={opening !== null}
              onClick={() =>
                void open(moved.apps.length > 0 ? RECONNECT_LIST : "/")
              }
            >
              Open OpenBot
            </button>
          )}
          {/* The same account in the person's own browser, where they may look for it next. */}
          <ExternalLink className="button-link" href={cloudWebAddress()}>
            Open in browser
          </ExternalLink>
        </div>
        {opening !== null ? (
          <StatusLine>Opening OpenBot Cloud…</StatusLine>
        ) : (
          <p className="footnote">{inABrowserSaid(moved.account)}</p>
        )}
      </StepFooter>
    </Sheet>
  );
}
