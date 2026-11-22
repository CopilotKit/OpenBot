import {
  type Icon,
  IconBell,
  IconBook,
  IconBrain,
  IconCircleCheck,
  IconClock,
  IconCloud,
  IconDeviceLaptop,
  IconFiles,
  IconMessages,
  IconPlug,
  IconRobot,
  IconTarget,
} from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cloudAddress } from "./CloudSignIn";
import { asProblem, type Problem } from "./Problem";
import {
  type Progress,
  SetupProgress,
  StatusLine,
  StepFooter,
} from "./SetupProgress";

/**
 * Whether this window offers the move to OpenBot Cloud, as the shell answers `move_offer`. `due`:
 * OpenBot is set up and runs on this computer, and the person has never answered. `fromSettings`:
 * Settings' "Move to OpenBot Cloud" sent the window here, answered once. `footprintBytes`: what
 * OpenBot takes on this computer now, or null when it couldn't be measured.
 */
export type MoveOffer = {
  due: boolean;
  fromSettings: boolean;
  footprintBytes: number | null;
};

/** One private app connection, which can't move and is connected again in OpenBot Cloud. */
export type ReconnectApp = {
  appId: string;
  appName: string;
  accountLabel?: string;
  iconUrl?: string;
  botNames?: string[];
};

/** What the move would take, read from the OpenBot running on this computer (`move_preview`). */
export type MovePreview = {
  counts: { kind: string; count: number }[];
  apps: ReconnectApp[];
  footprintBytes: number | null;
  /** This computer has an AI key the move can bring along, sealed for the person's Cloud account. */
  modelKeysAvailable: boolean;
};

/** What a finished move answers (`move_to_cloud`). */
export type Moved = {
  freedBytes: number | null;
  apps: ReconnectApp[];
  /** Plain sentences from OpenBot Cloud about things that moved differently. */
  notes: string[];
  /** Plain sentences about what couldn't be removed from this computer after the move. */
  leftBehind: string[];
};

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

type Screen =
  | { at: "choice" }
  | { at: "confirm" }
  | { at: "moving" }
  | { at: "failed"; problem: Problem }
  | { at: "done"; moved: Moved };

/**
 * The move to OpenBot Cloud, in the setup window, for a person who runs OpenBot (Self-Contained):
 * offered once after an update, or opened from Settings.
 *
 * 1. The choice: OpenBot Cloud, recommended and picked to begin with, or keep everything here. With
 *    the space the move frees. Keep is recorded and never asked again (`onKeep`).
 * 2. What moves, from the OpenBot running here (`move_preview`), and the app connections that can't
 *    move, by name, to reconnect in OpenBot Cloud. Settings opens here.
 * 3. The move (`move_to_cloud`): sign in through the browser, pack up, send, add, check, and only
 *    then remove OpenBot from this computer, each a row (`move:progress`).
 * 4. A move that stopped removed nothing: the sentence, Try again, or keep OpenBot here.
 * 5. Done: the space freed, the apps to reconnect, each opening OpenBot Cloud's connections in this
 *    window (`open_moved_cloud`), and Open OpenBot.
 */
export function MoveToCloud({
  offer,
  onKeep,
}: {
  offer: MoveOffer;
  /** Keep OpenBot here: recorded, then OpenBot shows. */
  onKeep: () => Promise<void>;
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
  const wantsPreview = screen.at !== "choice" && preview === null;
  const asked = useRef(false);
  useEffect(() => {
    if (!wantsPreview || asked.current) return;
    asked.current = true;
    loadPreview();
  }, [wantsPreview, loadPreview]);
  const [includeKeys, setIncludeKeys] = useState(true);

  const [stages, setStages] = useState<Stages>(freshStages);
  const cancelled = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const move = async () => {
    cancelled.current = false;
    setCancelling(false);
    setStages(freshStages());
    setScreen({ at: "moving" });
    const stop = await listen<MoveProgress>("move:progress", (event) => {
      if (alive.current) setStages((now) => advance(now, event.payload));
    }).catch(() => null);
    try {
      const moved = await invoke<Moved>("move_to_cloud", {
        address: cloudAddress(),
        includeModelKeys: Boolean(preview?.modelKeysAvailable && includeKeys),
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
      setStages((now) => stopped(now));
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
        footprintBytes={offer.footprintBytes}
        keeping={keeping}
        onCloud={() => setScreen({ at: "confirm" })}
        onKeep={() => void keep()}
      />
    );
  if (screen.at === "confirm")
    return (
      <Confirm
        preview={preview}
        problem={previewProblem}
        footprintBytes={preview?.footprintBytes ?? offer.footprintBytes}
        includeKeys={includeKeys}
        onIncludeKeys={setIncludeKeys}
        keeping={keeping}
        onRetryPreview={loadPreview}
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
        <p className="footnote">{NOTHING_REMOVED_UNTIL_CHECKED}</p>
      </Sheet>
    );
  }
  if (screen.at === "failed") {
    const { problem } = screen;
    return (
      <Sheet>
        <h1>
          {problem.kind === "sign-in"
            ? "Signing in didn't finish"
            : problem.kind === "move-mismatch"
              ? "Not everything arrived"
              : "The move didn't finish"}
        </h1>
        <p className="lede">{problem.said}</p>
        <div className="local-alert needs move-safe" role="status">
          <h2>{NOTHING_WAS_REMOVED}</h2>
          <p>
            Your Bots and their work are on this computer, just as they were.
            You can try again, or keep using OpenBot here.
          </p>
        </div>
        <SetupProgress steps={stageRows(stages)} label="Move progress" />
        {problem.detail && (
          <details className="detail-of move-detail">
            <summary>Technical details</summary>
            <pre>{problem.detail}</pre>
          </details>
        )}
        <div className="row">
          <button type="button" disabled={keeping} onClick={() => void move()}>
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
      </Sheet>
    );
  }
  return <Done moved={screen.moved} />;
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
  const [picked, setPicked] = useState<"cloud" | "keep">("cloud");
  const rowClass = (chosen: boolean) => (chosen ? "tile chosen" : "tile");
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
            {footprintBytes != null &&
              ` This frees about ${formatSpace(footprintBytes)} on this computer.`}
          </span>
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
    </Sheet>
  );
}

function Confirm({
  preview,
  problem,
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
  footprintBytes: number | null;
  includeKeys: boolean;
  onIncludeKeys: (include: boolean) => void;
  keeping: boolean;
  onRetryPreview: () => void;
  onMove: () => void;
  onKeep: () => void;
}) {
  const lines = preview ? countLines(preview.counts) : [];
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
          {preview.apps.length > 0 && (
            <section
              className="local-alert needs move-apps-notice"
              aria-labelledby="move-apps-heading"
            >
              <h2 id="move-apps-heading">
                You'll reconnect these apps in OpenBot Cloud
              </h2>
              <p>
                Your app connections are private, so they can't move safely.
              </p>
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
              `Frees about ${formatSpace(footprintBytes)}. `}
            {NOTHING_REMOVED_UNTIL_CHECKED}
          </p>
        )}
      </StepFooter>
    </Sheet>
  );
}

/** The app connections to reconnect, by name, with an action on each row when there is one. */
function AppList({
  apps,
  action,
}: {
  apps: ReconnectApp[];
  action?: (app: ReconnectApp) => ReactNode;
}) {
  return (
    <ul className="move-apps" aria-label="Apps to reconnect">
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
            {app.botNames && app.botNames.length > 0 && (
              <span className="move-app-bots">
                Used by {namesSaid(app.botNames)}
              </span>
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
  return (
    <Sheet>
      <h1>You're on OpenBot Cloud</h1>
      <p className="lede">
        {WHAT_MOVES} are in your OpenBot Cloud account now.
      </p>
      {moved.freedBytes != null && moved.freedBytes > 0 && (
        <p className="move-freed">
          <IconCircleCheck stroke={1.75} aria-hidden="true" />
          <span>
            <strong>{formatSpace(moved.freedBytes)} freed</strong> on this
            computer
          </span>
        </p>
      )}
      {moved.apps.length > 0 && (
        <section
          className="local-alert needs move-apps-notice"
          aria-labelledby="moved-apps-heading"
        >
          <h2 id="moved-apps-heading">Reconnect your apps in OpenBot Cloud</h2>
          <p>Your app connections are private, so they didn't move.</p>
          <AppList
            apps={moved.apps}
            action={(app) => (
              <button
                type="button"
                className="quiet move-app-action"
                aria-label={`Reconnect ${app.appName}`}
                disabled={opening !== null}
                onClick={() => void open("/connections")}
              >
                Reconnect
              </button>
            )}
          />
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
          <button
            type="button"
            disabled={opening !== null}
            onClick={() => void open("/")}
          >
            Open OpenBot
          </button>
        </div>
        {opening !== null && <StatusLine>Opening OpenBot Cloud…</StatusLine>}
      </StepFooter>
    </Sheet>
  );
}
