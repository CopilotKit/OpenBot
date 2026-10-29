import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import {
  readConnectPrompt,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
import { researchRoleOfTool } from "@openbot/shared/research";
import {
  IconFileText,
  IconPlug,
  IconSearch,
  IconTool,
  IconWorld,
} from "@tabler/icons-react";
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { PendingApprovals } from "@/components/approvals/inline-approval";
import { markdownComponents } from "@/lib/markdown";
import {
  connectorName,
  humanise,
  ownToolLabel,
  readToolName,
} from "@/lib/plugins/tool-name";
import {
  asText,
  forDisplay,
  REFUSAL_MARKER,
  toolResultFailed,
} from "@/lib/plugins/tool-result";
import { readTeamBotConsent } from "@/lib/team-bots";
import { browserStepDetails, isBrowserStep } from "./browser-activity";
import type { VisibleChatItem } from "./chat-messages";
import { ToolLine } from "./tool-line";

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/** Adjacent things a Bot did, drawn as one line that opens to each of them. */
export type ToolGroup = {
  kind: "tools";
  id: string;
  steps: ToolItem[];
};
export type TranscriptItem = VisibleChatItem | ToolGroup;

/**
 * Fold adjacent tool calls into one row, so a reply that searched, read two pages and checked Drive
 * reads as one thing the Bot did rather than four lines before the answer.
 *
 * Only calls drawn as a plain line are folded: browser steps, connector (MCP) tools, and any other
 * tool the app has no component for, such as an external agent's `run_command`. A tool the app draws
 * itself, a chart or a request for help, stays where it is, and so does a refusal that asks the
 * person to connect their own account, because a question for the person must never sit behind a
 * disclosure. A single call on its own keeps its own line; one browser step is still a group, as it
 * always was, so the row does not change shape when the second step arrives.
 *
 * `isDrawn` says which tools the app draws itself; the transcript reads it from `useDrawnTool`.
 *
 * EVERY RUN IS A GROUP, A RUN OF ONE INCLUDED, AND KEEPS ITS ROW ID FOR ITS WHOLE LIFE. A lone call
 * used to be its own `tool` row and became a `tools` row when a second call arrived, under the same
 * key but a different tree, so React tore the row down and rebuilt it and its entrance replayed. A
 * group took its first step's id, so when that step turned out to ask the person something and left,
 * the group's id changed and it was rebuilt again. Now the transcript draws a group of one as the
 * line it always was, inside the one row type, and `rowIds` remembers which row each step was drawn
 * in: a run reuses the row of the first of its steps no earlier run in this pass has claimed. Group
 * ids carry a `group:` prefix, so they can never collide with a single row's id.
 */
export function groupToolSteps(
  items: readonly VisibleChatItem[],
  isDrawn: (name: string) => boolean,
  rowIds: Map<string, string> = new Map(),
): TranscriptItem[] {
  const segments: (VisibleChatItem | ToolItem[])[] = [];
  let run: ToolItem[] = [];
  const close = () => {
    if (run.length > 0) segments.push(run);
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && foldable(item, isDrawn)) {
      run.push(item);
      continue;
    }
    close();
    segments.push(item);
  }
  close();

  // Runs claim their rows first, so a group keeps its row when its first step leaves it...
  const claimed = new Set<string>();
  const runIds = new Map<ToolItem[], string>();
  for (const segment of segments) {
    if (!Array.isArray(segment)) continue;
    const [first] = segment;
    if (!first) continue;
    const kept = segment
      .map((step) => rowIds.get(step.id))
      .find((id) => id !== undefined && !claimed.has(id));
    const id = kept ?? `group:${first.id}`;
    claimed.add(id);
    runIds.set(segment, id);
    for (const step of segment) rowIds.set(step.id, id);
  }

  // ...and a lone call that stops folding (its answer asks the person) keeps the row it had.
  return segments.map((segment): TranscriptItem => {
    if (Array.isArray(segment)) {
      return {
        kind: "tools",
        id: runIds.get(segment) ?? "",
        steps: segment,
      };
    }
    if (segment.kind !== "tool") return segment;
    const previous = rowIds.get(segment.id);
    if (previous === undefined || claimed.has(previous)) return segment;
    claimed.add(previous);
    return { ...segment, id: previous };
  });
}

function foldable(item: ToolItem, isDrawn: (name: string) => boolean): boolean {
  if (isBrowserStep(item)) return true;
  const name = item.toolCall.function.name;
  if (!name.startsWith("mcp__") && isDrawn(name)) return false;
  /*
   * The app-access card is drawn from a server tool's answer, so no renderer registers it and the
   * registry cannot say so. Never folded — not even while its answer is still on the way, or the
   * card would land inside a group and then jump out of it.
   */
  if (name === SHOW_APP_ACCESS_TOOL) return false;
  return !asksThePerson(item.result);
}

const NOTHING_DRAWN: readonly { name: string }[] = [];

/**
 * Whether the app draws a tool itself, read from CopilotKit's own renderer registry.
 *
 * Read from the registry rather than kept as a list here, because every `useRenderTool` and
 * `useFrontendTool` already registers its name there, and a list would fall behind the first tool
 * added without it. Taken from the context directly, not through `useCopilotKit`, because that
 * throws outside a provider and the transcript is drawn without one in places. With no provider
 * nothing is drawn. A `*` renderer draws every tool it is asked about, so nothing outside MCP folds.
 */
export function useDrawnTool(): (name: string) => boolean {
  const copilotkit = useContext(CopilotKitContext)?.copilotkit;
  const subscribe = useCallback(
    (onChange: () => void) =>
      copilotkit
        ? copilotkit.subscribe({ onRenderToolCallsChanged: onChange })
            .unsubscribe
        : () => {},
    [copilotkit],
  );
  const renderers = useSyncExternalStore(
    subscribe,
    () => copilotkit?.renderToolCalls ?? NOTHING_DRAWN,
  );
  return useMemo(() => {
    const names = new Set(renderers.map((renderer) => renderer.name));
    return names.has("*") ? () => true : (name) => names.has(name);
  }, [renderers]);
}

/**
 * Whether this refusal is a question for the person rather than a line about what a Bot did.
 *
 * Both of these draw a card with something to press — a Team Bot asking to act as them, and an app
 * they cannot use yet (not connected, lost at the vendor, or a team account nobody connected) — and neither may sit behind a disclosure for the same reason: a question
 * nobody can see is a conversation that has stopped without saying so.
 */
function asksThePerson(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  if (!answer.startsWith(REFUSAL_MARKER)) return false;
  const body = answer.slice(REFUSAL_MARKER.length).trim();
  return readTeamBotConsent(body) !== null || readConnectPrompt(body) !== null;
}

/** The app a tool item draws a card for, or null when it draws none. */
function cardApp(item: ToolItem): string | null {
  if (item.result === undefined) return null;
  const answer = asText(item.result);
  const prompt = answer.startsWith(REFUSAL_MARKER)
    ? readConnectPrompt(answer.slice(REFUSAL_MARKER.length).trim())
    : item.toolCall.function.name === SHOW_APP_ACCESS_TOOL
      ? readConnectPrompt(answer)
      : null;
  return prompt?.serverId ?? null;
}

/**
 * One card per app per turn.
 *
 * A refused call already draws the app's card, and a Bot told to show the card for an app it cannot
 * use often calls `show_app_access` for the same app straight after, which drew the same card again.
 * The refused call is kept, because it is what the Bot did; a later `show_app_access` for an app
 * whose card that turn already drew is dropped. A person's next message starts a new turn.
 */
export function dropRepeatedAppCards(
  items: readonly VisibleChatItem[],
): VisibleChatItem[] {
  const drawn = new Set<string>();
  return items.filter((item) => {
    if (item.kind === "text" && item.role === "user") drawn.clear();
    if (item.kind !== "tool") return true;
    const app = cardApp(item);
    if (app === null) return true;
    const repeat =
      drawn.has(app) && item.toolCall.function.name === SHOW_APP_ACCESS_TOOL;
    drawn.add(app);
    return !repeat;
  });
}

type StepKind = "search" | "fetch" | "browser" | "connector" | "tool";

export type StepDetails = {
  id: string;
  kind: StepKind;
  label: string;
  /** What it was done to: a query, a page, a connector. Muted beside the label. */
  detail?: string;
  href?: string;
  pending: boolean;
  failed: boolean;
  refused: boolean;
  reason?: string;
  /** Pages a browser step opened, or a fetch read; zero for anything else. */
  pages: number;
  /** The connector a connector step reached, said the way a person would. */
  connector?: string;
  inputs: [string, string][];
  output?: string;
};

function objectOf(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const found = value.find(
        (entry): entry is string => typeof entry === "string" && !!entry.trim(),
      );
      if (found) return found.trim();
    }
  }
  return undefined;
}

function urlsOf(args: Record<string, unknown>): string[] {
  const urls = Array.isArray(args.urls) ? args.urls : [args.url];
  return urls.filter(
    (url): url is string => typeof url === "string" && !!url.trim(),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A value from a tool's arguments, short enough for one line. */
function inputValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export function stepDetails(step: ToolItem): StepDetails {
  const args = objectOf(step.toolCall.function.arguments);
  const inputs = Object.entries(args).map(
    ([key, value]) => [key, inputValue(value)] as [string, string],
  );
  if (isBrowserStep(step)) {
    const browser = browserStepDetails(step);
    return {
      id: step.id,
      kind: "browser",
      label: browser.label ?? "Used the browser",
      ...(browser.title ? { detail: browser.title } : {}),
      ...(browser.href ? { href: browser.href } : {}),
      pending: browser.pending,
      failed: browser.failed,
      refused: false,
      ...(browser.reason ? { reason: browser.reason } : {}),
      pages: browser.visited ? 1 : 0,
      inputs,
    };
  }

  const name = step.toolCall.function.name;
  const answer = step.result === undefined ? undefined : asText(step.result);
  const refused = answer?.startsWith(REFUSAL_MARKER) ?? false;
  const body = refused ? answer?.slice(REFUSAL_MARKER.length).trim() : answer;
  // This deployment's own tools answer the model, not the person; see `ServerToolLine`.
  const own = ownToolLabel(name) !== null;
  const outcome = {
    id: step.id,
    pending: step.result === undefined,
    failed: !refused && toolResultFailed(step.result),
    refused,
    inputs,
    ...(body && !own ? { output: body } : {}),
  };
  // Not a connector: one of this deployment's own tools, or one an external agent runs itself.
  // Named in words, never as an identifier.
  if (!name.startsWith("mcp__"))
    return {
      ...outcome,
      kind: "tool",
      label: ownToolLabel(name, outcome.pending) ?? humanise(name),
      pages: 0,
    };

  const [, server = "", ...rest] = name.split("__");
  const role = researchRoleOfTool(server, rest.join("__"));
  const { label, detail } = readToolName(name);
  const urls = role === "fetch" ? urlsOf(args) : [];
  const base = { ...outcome, label };
  if (role === "search") {
    const query = firstString(
      args.query,
      args.objective,
      args.search_queries,
      args.queries,
    );
    return {
      ...base,
      kind: "search",
      ...(query ? { detail: query } : {}),
      pages: 0,
    };
  }
  if (role === "fetch") {
    const [first, ...more] = urls;
    const href = first && /^https?:\/\//.test(first) ? first : undefined;
    return {
      ...base,
      kind: "fetch",
      ...(first
        ? {
            detail: more.length
              ? `${hostOf(first)} and ${more.length} more`
              : hostOf(first),
          }
        : {}),
      ...(href && !more.length ? { href } : {}),
      pages: Math.max(urls.length, 1),
    };
  }
  return {
    ...base,
    kind: "connector",
    ...(detail ? { detail } : {}),
    pages: 0,
    connector: connectorName(server),
  };
}

function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What a group of steps did, as one phrase: "Searched the web and read 2 pages".
 *
 * Counted by kind rather than listed, because the list is what the line opens to. Research is
 * never attributed to a provider; a connector is named, because which system was reached is the
 * person's own fact.
 */
export function summarise(steps: readonly StepDetails[]): string {
  const of = (kind: StepKind) => steps.filter((step) => step.kind === kind);
  const phrases: string[] = [];
  if (of("search").length) phrases.push("searched the web");
  const read = of("fetch").reduce((sum, step) => sum + step.pages, 0);
  if (read) phrases.push(`read ${plural(read, "page", "pages")}`);
  const browser = of("browser");
  const browsed = browser.reduce((sum, step) => sum + step.pages, 0);
  if (browsed) phrases.push(`browsed ${plural(browsed, "page", "pages")}`);
  else if (browser.length) phrases.push("used the browser");
  const connectors = [
    ...new Set(of("connector").map((step) => step.connector ?? "")),
  ].filter(Boolean);
  if (connectors.length === 1) phrases.push(`used ${connectors[0]}`);
  else if (connectors.length > 1)
    phrases.push(
      `used ${plural(connectors.length, "connector", "connectors")}`,
    );
  const tools = of("tool").length;
  if (tools) phrases.push(`used ${plural(tools, "tool", "tools")}`);
  const sentence = joinPhrases(phrases);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const KIND_ICONS = {
  search: IconSearch,
  fetch: IconFileText,
  browser: IconWorld,
  connector: IconPlug,
  tool: IconTool,
} as const;

function StepIcon({
  kind,
  size = "size-4",
}: {
  kind: StepKind;
  size?: string;
}) {
  const Icon = KIND_ICONS[kind];
  return <Icon aria-hidden className={`${size} shrink-0`} stroke={2} />;
}

/**
 * One small icon per kind of step, overlapped, in the order they first happened.
 *
 * The first is drawn on top. Drawn the other way, each circle's ring cuts into the icon before it,
 * and a magnifying glass with its handle cut off reads as the letter C.
 */
function IconStack({ kinds }: { kinds: StepKind[] }) {
  return (
    <span aria-hidden className="flex items-center">
      {kinds.map((kind, index) => (
        <span
          key={kind}
          style={{ zIndex: kinds.length - index }}
          className={`relative flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background ${
            index > 0 ? "-ml-1.5" : ""
          }`}
        >
          <StepIcon kind={kind} size="size-4" />
        </span>
      ))}
    </span>
  );
}

function StepStatus({ step, active }: { step: StepDetails; active: boolean }) {
  if (step.pending)
    return (
      <span className="shrink-0 text-muted-foreground">
        {active ? "In progress" : "Not completed"}
      </span>
    );
  if (step.refused)
    return <span className="shrink-0 text-destructive">Blocked</span>;
  if (step.failed)
    return (
      <span className="shrink-0 text-amber-600 dark:text-amber-500">
        Didn't work
      </span>
    );
  return null;
}

function StepRow({ step, active }: { step: StepDetails; active: boolean }) {
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <StepIcon kind={step.kind} />
      <span className="shrink-0">{step.label}</span>
      {step.href ? (
        <a
          href={step.href}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
        >
          {step.detail ?? step.href}
        </a>
      ) : step.detail ? (
        <span className="truncate text-muted-foreground">{step.detail}</span>
      ) : null}
      <StepStatus step={step} active={active} />
    </span>
  );
  const reason =
    step.failed && step.kind === "browser" ? (
      <p className="mt-0.5 pl-6 text-destructive">
        {step.reason ?? "Couldn't finish this step."}
      </p>
    ) : null;
  // A browser step says everything it has in its line. Anything else opens to what it was given
  // and what came back, which no other place in the transcript shows.
  if (step.kind === "browser" || (!step.inputs.length && !step.output))
    return (
      <li className="min-w-0">
        {line}
        {reason}
      </li>
    );
  return (
    <li className="min-w-0">
      <details className="tool-line min-w-0">
        <summary className="flex cursor-pointer list-none items-center gap-1.5">
          <span
            aria-hidden
            className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
          >
            ▸
          </span>
          {line}
        </summary>
        <div className="mt-1.5 space-y-2 pl-5">
          {step.inputs.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {step.inputs.map(([key, value]) => (
                <div className="contents" key={key}>
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {step.output ? (
            <div className="max-h-60 overflow-auto border-l pl-3 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
              <Streamdown components={markdownComponents}>
                {forDisplay(step.output)}
              </Streamdown>
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function ToolActivity({
  group,
  active,
}: {
  group: ToolGroup;
  /** This is the newest row of a turn still in flight, so a step without a result is running. */
  active: boolean;
}) {
  const steps = group.steps.map(stepDetails);
  const running = active && steps.some((step) => step.pending);
  const current = steps.find((step) => step.pending);
  const issues = steps.filter((step) => step.failed || step.refused).length;
  const kinds = [...new Set(steps.map((step) => step.kind))];
  // The folded line draws its own steps, so a waiting approval gets its card beside it, not inside.
  return (
    <>
      <ToolLine
        icon={<IconStack kinds={kinds} />}
        label={running && current ? `${current.label}…` : summarise(steps)}
        detail={issues ? plural(issues, "issue", "issues") : undefined}
        running={running}
      >
        <ol className="space-y-2 py-1">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} active={active} />
          ))}
        </ol>
      </ToolLine>
      <PendingApprovals
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
    </>
  );
}
