/**
 * What the Bot has been doing on its computer, beside the screen that shows what it is looking at.
 *
 * The screen answered half the question. A Bot that spends two minutes in a terminal installing a
 * package showed a blank browser and one grey line per command in the transcript, so the honest
 * answer to "what is it doing" was "something, on a machine holding your logins". This is the other
 * half: every command, what it printed, and what it exited with, as it happens, and every page the
 * Bot opened and every click and field on it, named as the transcript names them.
 *
 * Read from the conversation, so it is the same whichever way a call ran: in the browser, at the
 * server's gate, or after a person allowed it. A conversation opened again, after a reload too,
 * shows what was already done in it, and when: each step's answer says when it finished. The
 * record is still the audit trail on the server; this is the window beside the screen.
 */
import { ownToolLabel } from "@openbot/shared/tool-name";
import {
  IconArrowsVertical,
  IconCamera,
  IconFile,
  IconFileText,
  IconFolder,
  IconKeyboard,
  IconListDetails,
  IconPointer,
  IconTerminal2,
  IconWorld,
} from "@tabler/icons-react";
import { useSyncExternalStore } from "react";
import {
  type AllowedDecision,
  activityFor,
  type BrowserStepName,
  type ComputerActivity,
  subscribeToActivity,
} from "@/lib/computers/activity";
import { CommandOutput } from "./command-output";
import { commandStatus, TerminalBlock } from "./terminal-block";

const ICONS = {
  command: IconTerminal2,
  read_file: IconFile,
  write_file: IconFile,
  list_files: IconFolder,
} as const;

/** What the line says was done. The subject beside it says what it was done to. */
const LABELS = {
  command: "Ran",
  read_file: "Read",
  write_file: "Saved",
  list_files: "Listed",
} as const;

const BROWSER_ICONS: Record<BrowserStepName, typeof IconWorld> = {
  computer_navigate: IconWorld,
  computer_read: IconFileText,
  computer_snapshot: IconListDetails,
  computer_screenshot: IconCamera,
  computer_click: IconPointer,
  computer_type: IconKeyboard,
  computer_key: IconKeyboard,
  computer_scroll: IconArrowsVertical,
};

/** How the person allowed a step on its card, as the card says it once answered. */
const ALLOWED: Record<AllowedDecision, string> = {
  allow_once: "Allowed once.",
  allow_conversation: "Allowed for this conversation.",
  allow_always: "Always allowed here.",
};

/** The line under a step the person allowed on its card, as one they declined has its own. */
function AllowedLine({ allowed }: { allowed: AllowedDecision | undefined }) {
  if (!allowed) return null;
  return (
    <p className="mt-1 pl-5 text-muted-foreground text-xs">
      {ALLOWED[allowed]}
    </p>
  );
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * A command, drawn as the chat draws it: a terminal block, which opens the live terminal above. Its
 * time sits in the header, where the chat has its words.
 */
function CommandEntry({
  computerId,
  entry,
}: {
  computerId: string;
  entry: ComputerActivity;
}) {
  return (
    <li>
      <TerminalBlock
        aside={
          entry.at === undefined ? null : (
            <time
              className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
              dateTime={new Date(entry.at).toISOString()}
            >
              {timeOf(entry.at)}
            </time>
          )
        }
        command={entry.subject}
        computerId={computerId}
        label={entry.declined === true ? "Declined" : "Ran"}
        output={entry.output}
        status={commandStatus({
          running: false,
          refused: entry.refused === true,
          declined: entry.declined === true,
          byYou: entry.doneByPerson === true,
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
          timedOut: entry.timedOut === true,
        })}
        truncated={entry.truncated === true}
      />
      <AllowedLine allowed={entry.allowed} />
    </li>
  );
}

/**
 * A browser step: what it was, in the transcript's words ("Opened page", "Clicked on page"), and what
 * it acted on. A page opened carries its title underneath; a step that did not happen, why not.
 */
function BrowserEntry({ entry }: { entry: ComputerActivity }) {
  const step = entry.step ?? "computer_navigate";
  const Icon = BROWSER_ICONS[step];
  const failed = entry.refused === true || entry.failed === true;
  return (
    <li className="border-border/60 border-b py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <Icon
          aria-hidden
          className={`size-3.5 shrink-0 translate-y-0.5 ${
            failed ? "text-destructive" : "text-muted-foreground"
          }`}
        />
        <span className="shrink-0 text-muted-foreground text-xs">
          {entry.declined === true ? "Declined" : ownToolLabel(step)}
        </span>
        {entry.subject ? (
          <code className="min-w-0 break-all font-mono text-xs">
            {entry.subject}
          </code>
        ) : null}
        {entry.at === undefined ? null : (
          <time
            className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums"
            dateTime={new Date(entry.at).toISOString()}
          >
            {timeOf(entry.at)}
          </time>
        )}
      </div>
      {entry.output ? (
        <p
          className={`mt-1 break-words pl-5 text-xs ${
            failed ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {entry.output}
        </p>
      ) : failed ? (
        <p className="mt-1 pl-5 text-destructive text-xs">
          {entry.refused === true
            ? "A boundary refused it."
            : "It did not work."}
        </p>
      ) : null}
      <AllowedLine allowed={entry.allowed} />
    </li>
  );
}

/** What a file step that did not happen says in place of its label: never "Saved" about an unsaved file. */
const NOT_DONE_LABELS = {
  read_file: "Didn't read",
  write_file: "Didn't save",
  list_files: "Didn't list",
} as const;

function Entry({ entry }: { entry: ComputerActivity }) {
  if (entry.kind === "browser") return <BrowserEntry entry={entry} />;
  const Icon = ICONS[entry.kind];
  const notDone = entry.failed === true && entry.kind !== "command";
  const failed =
    entry.refused === true ||
    notDone ||
    (typeof entry.exitCode === "number" && entry.exitCode !== 0);

  return (
    <li className="border-border/60 border-b py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <Icon
          aria-hidden
          className={`size-3.5 shrink-0 translate-y-0.5 ${
            failed ? "text-destructive" : "text-muted-foreground"
          }`}
        />
        <span className="shrink-0 text-muted-foreground text-xs">
          {entry.declined === true
            ? "Declined"
            : notDone && entry.kind !== "command"
              ? NOT_DONE_LABELS[entry.kind]
              : LABELS[entry.kind]}
        </span>
        {/*
          The command wraps rather than truncating. In the transcript one line per call is what keeps
          it readable; here the whole point is to see exactly what ran, and a long command with its
          middle cut out is the one thing this pane must not do.
        */}
        <code className="min-w-0 break-all font-mono text-xs">
          {entry.subject}
        </code>
        {entry.at === undefined ? null : (
          <time
            className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums"
            dateTime={new Date(entry.at).toISOString()}
          >
            {timeOf(entry.at)}
          </time>
        )}
      </div>

      {entry.refused === true ? (
        <p className="mt-1 pl-5 text-destructive text-xs">
          {entry.output || "A boundary refused it."}
        </p>
      ) : notDone ? (
        <p className="mt-1 pl-5 text-destructive text-xs">
          {entry.output || "It did not work."}
        </p>
      ) : entry.doneByPerson === true ? (
        <p className="mt-1 pl-5 text-muted-foreground text-xs">
          {entry.output || "You did it yourself."}
        </p>
      ) : (
        <div className="mt-1 max-h-64 overflow-auto pl-5">
          <CommandOutput
            {...(entry.exitCode !== undefined
              ? { exitCode: entry.exitCode }
              : {})}
            output={entry.output}
            timedOut={entry.timedOut === true}
            truncated={entry.truncated === true}
          />
        </div>
      )}
      <AllowedLine allowed={entry.allowed} />
    </li>
  );
}

export function ActivityLog({ computerId }: { computerId: string }) {
  const entries = useSyncExternalStore(
    subscribeToActivity,
    () => activityFor(computerId),
    () => activityFor(computerId),
  );

  // One quiet line under the screen, not a box as tall as the screen's own card, while there is nothing to list.
  if (entries.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing yet. Pages the Bot opens, commands it runs and files it reads
        appear here.
      </p>
    );
  }

  // Newest first: what somebody watching wants is what just happened, without scrolling for it.
  const newestFirst = [...entries].reverse();

  return (
    <ul className="min-w-0">
      {newestFirst.map((entry) =>
        entry.kind === "command" ? (
          <CommandEntry computerId={computerId} entry={entry} key={entry.id} />
        ) : (
          <Entry entry={entry} key={entry.id} />
        ),
      )}
    </ul>
  );
}
