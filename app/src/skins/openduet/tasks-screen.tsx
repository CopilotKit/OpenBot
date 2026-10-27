import {
  type Icon,
  IconArrowsSort,
  IconChevronRight,
  IconFile,
  IconMail,
  IconMessageQuestion,
  IconRepeat,
  IconSearch,
  IconShield,
  IconTargetArrow,
  IconTerminal2,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalDecision,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import {
  type ProactiveSuggestion,
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import {
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
} from "@/lib/responsibilities";
import {
  type RoutineRecord,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  Caption,
  DISC,
  DuetCard,
  FOCUS,
  PillButton,
  Rule,
  StatusLine,
  Tile,
} from "./kit";
import { RESPONSIBILITIES_HASH } from "./places";
import {
  type ActionKind,
  type ApprovalRequest,
  actionKind,
  actionName,
  type PersonQuestion,
  type SortOrder,
  tasksModel,
} from "./tasks-model";

/** Which list Tasks shows: what is under way and waiting, or what nobody has started yet. */
export type TasksView = "active" | "up_next";

/** Which list was open last, kept in this browser between visits. */
export const TASKS_VIEW_STORAGE_KEY = "openduet.tasks-view";

function rememberedView(): TasksView {
  try {
    return window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY) === "up_next"
      ? "up_next"
      : "active";
  } catch {
    return "active";
  }
}

function rememberView(view: TasksView) {
  try {
    window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be refused. The list still switches; it opens on Active next time.
  }
}

/**
 * OpenDuet's Tasks, drawn from OpenBot. Two lists under one switch: Active holds what waits on the
 * person (approvals and questions, answered right here) and what their Bots carry (responsibilities
 * and routines); Up next holds the next steps background research suggested, each started or hidden
 * in place. The switch stays at the top while the list scrolls, with sort and search beside it.
 *
 * Followed from the menu's Responsibilities row, it opens on Active at that section.
 */
export function TasksScreen() {
  const hash = useLocation({ select: (location) => location.hash });
  const wantsResponsibilities = hash === RESPONSIBILITIES_HASH;
  const [view, setView] = useState<TasksView>(() =>
    wantsResponsibilities ? "active" : rememberedView(),
  );
  const [order, setOrder] = useState<SortOrder>("newest");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const show = (next: TasksView) => {
    setView(next);
    rememberView(next);
  };
  useEffect(() => {
    if (wantsResponsibilities) setView("active");
  }, [wantsResponsibilities]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[100px] pb-[calc(var(--openduet-tab-space,86px)+32px)]">
        <TasksSwitch
          onClose={() => {
            setSearching(false);
            setQuery("");
          }}
          onOrder={() =>
            setOrder((current) => (current === "newest" ? "oldest" : "newest"))
          }
          onQuery={setQuery}
          onSearch={() => setSearching(true)}
          onView={show}
          order={order}
          query={query}
          searching={searching}
          view={view}
        />
        <div
          aria-labelledby={`openduet-tasks-tab-${view}`}
          id="openduet-tasks-panel"
          role="tabpanel"
        >
          {view === "active" ? (
            <ActiveView
              focusResponsibilities={wantsResponsibilities}
              order={order}
              query={query}
            />
          ) : (
            <UpNextView order={order} query={query} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Active and Up next as two large words, the one showing in ink and the other grey, with sort and
 * search on the right. It sticks under the header while the list scrolls, solid up to the discs and
 * fading under, so rows never show through it.
 */
function TasksSwitch({
  view,
  onView,
  order,
  onOrder,
  searching,
  onSearch,
  query,
  onQuery,
  onClose,
}: {
  view: TasksView;
  onView: (view: TasksView) => void;
  order: SortOrder;
  onOrder: () => void;
  searching: boolean;
  onSearch: () => void;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const sortLabel =
    order === "newest" ? "Sort: newest first" : "Sort: oldest first";
  return (
    <div
      className={cn(
        "sticky top-[-20px] z-30 -mx-4 mb-3 bg-openduet-surface px-5 pt-1 pb-2",
        "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-[14px] before:bg-openduet-surface before:content-['']",
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-[linear-gradient(var(--openduet-surface),transparent)] after:content-['']",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          aria-label="Tasks"
          className="flex min-w-0 flex-wrap items-baseline gap-x-4"
          role="tablist"
        >
          <SwitchTab id="active" onView={onView} view={view}>
            Active
          </SwitchTab>
          <SwitchTab id="up_next" onView={onView} view={view}>
            Up next
          </SwitchTab>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <RoundButton
            glyph={IconArrowsSort}
            label={sortLabel}
            onClick={onOrder}
          />
          <RoundButton
            expanded={searching}
            glyph={IconSearch}
            label="Search tasks"
            onClick={() => {
              if (searching) field.current?.focus();
              else onSearch();
            }}
          />
        </div>
      </div>
      {searching ? (
        <div className="openduet-glass mt-2.5 flex h-11 items-center gap-2 rounded-full pr-1 pl-4 shadow-openduet-glass">
          <IconSearch className="text-openduet-ink-3" size={18} stroke={1.9} />
          <input
            aria-label="Search tasks"
            // biome-ignore lint/a11y/noAutofocus: opened by the search button, so focus belongs here.
            autoFocus
            className="openduet-type-sub min-w-0 flex-1 bg-transparent text-openduet-ink outline-none placeholder:text-openduet-ink-3"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            placeholder="Search tasks"
            ref={field}
            type="search"
            value={query}
          />
          <button
            aria-label="Close search"
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-full text-openduet-ink-2 hover:bg-openduet-tile",
              FOCUS,
            )}
            onClick={onClose}
            type="button"
          >
            <IconX size={18} stroke={2.2} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SwitchTab({
  id,
  view,
  onView,
  children,
}: {
  id: TasksView;
  view: TasksView;
  onView: (view: TasksView) => void;
  children: ReactNode;
}) {
  const on = id === view;
  return (
    <button
      aria-controls="openduet-tasks-panel"
      aria-selected={on}
      className={cn(
        "openduet-type-display rounded-lg font-semibold transition-colors",
        FOCUS,
        on
          ? "text-openduet-ink"
          : "text-openduet-ink-3 hover:text-openduet-ink-2",
      )}
      id={`openduet-tasks-tab-${id}`}
      onClick={() => onView(id)}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}

function RoundButton({
  glyph: Glyph,
  label,
  onClick,
  expanded,
}: {
  glyph: Icon;
  label: string;
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className={cn(DISC, "size-11")}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Glyph size={19} stroke={2} />
    </button>
  );
}

/** The Bots by id, for "who" on every row. */
function useBotName() {
  const agents = useQuery(agentListQueryOptions());
  return (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? "Your Bot";
}

/**
 * Tasks' Active list, in sections that each say how many: Needs input (approvals decided here, and
 * questions answered here), then the responsibilities and routines a Bot carries. A section with
 * nothing in it is left out, so a quiet day is a short page.
 */
function ActiveView({
  order,
  query,
  focusResponsibilities,
}: {
  order: SortOrder;
  query: string;
  focusResponsibilities: boolean;
}) {
  const inbox = useQuery(approvalInboxOptions());
  const responsibilities = useQuery(responsibilitiesQueryOptions());
  const routines = useQuery(routinesQueryOptions());
  const botName = useBotName();
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const section = useRef<HTMLElement>(null);
  const settled =
    !inbox.isPending && !responsibilities.isPending && !routines.isPending;
  useEffect(() => {
    if (settled && focusResponsibilities)
      section.current?.scrollIntoView({ block: "start" });
  }, [settled, focusResponsibilities]);

  // Nothing until every list is read: each section draws from one, and a half page is a flicker.
  if (!settled) return null;

  const model = tasksModel({
    inbox: inbox.data,
    responsibilities: responsibilities.data,
    routines: routines.data?.routines,
    suggestions: [],
    order,
    query,
  });
  const waiting = model.requests.length + model.questions.length;
  const problems = [
    inbox.error
      ? "Couldn't load what is waiting on you. Reload the page."
      : null,
    responsibilities.error
      ? "Couldn't load your Bots' responsibilities. Reload the page."
      : null,
    routines.error ? "Couldn't load your routines. Reload the page." : null,
  ].filter((problem): problem is string => problem !== null);
  const nothing =
    waiting === 0 &&
    model.responsibilities.length === 0 &&
    model.routines.length === 0;

  return (
    <div className="flex flex-col gap-9">
      {problems.map((problem) => (
        <p
          className="openduet-type-sub px-1 text-openduet-problem"
          key={problem}
          role="alert"
        >
          {problem}
        </p>
      ))}
      {nothing && !focusResponsibilities ? (
        <EmptyLine query={query} title="Nothing active right now.">
          What your Bots need from you, and the work they carry, shows up here.
        </EmptyLine>
      ) : null}
      {waiting > 0 ? (
        <Section
          count={waiting}
          label="Needs input"
          updated={inbox.dataUpdatedAt}
        >
          {model.requests.map((request) => (
            <li key={request.id}>
              <ApprovalCard
                botName={botName(request.action.botId)}
                busy={
                  decision.isPending && decision.variables?.id === request.id
                }
                error={
                  decision.variables?.id === request.id
                    ? (decision.error?.message ?? null)
                    : null
                }
                onDecide={(choice) =>
                  decision.mutate({ id: request.id, choice })
                }
                request={request}
              />
            </li>
          ))}
          {model.questions.map((question) => (
            <li key={question.id}>
              <QuestionCard
                botName={botName(question.botId)}
                busy={answer.isPending && answer.variables?.id === question.id}
                error={
                  answer.variables?.id === question.id
                    ? (answer.error?.message ?? null)
                    : null
                }
                onAnswer={(response) =>
                  answer.mutate({ id: question.id, response })
                }
                question={question}
              />
            </li>
          ))}
        </Section>
      ) : null}
      {model.responsibilities.length > 0 || focusResponsibilities ? (
        <Section
          count={model.responsibilities.length}
          id={RESPONSIBILITIES_HASH}
          label="Responsibilities"
          sectionRef={section}
        >
          {model.responsibilities.length === 0 ? (
            <li>
              <EmptyLine query={query} title="No responsibilities under way.">
                Ask a Bot in a conversation to take one on. Each Bot's page
                holds its own.
              </EmptyLine>
            </li>
          ) : (
            model.responsibilities.map((row) => (
              <li key={row.id}>
                <ResponsibilityLine botName={botName(row.agentId)} row={row} />
              </li>
            ))
          )}
        </Section>
      ) : null}
      {model.routines.length > 0 ? (
        <Section count={model.routines.length} label="Routines">
          {model.routines.map((row) => (
            <li key={row.id}>
              <RoutineLine botName={botName(row.agentId)} row={row} />
            </li>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

/** Nothing here: say so, and where things come from. With a search, say nothing matched. */
function EmptyLine({
  query,
  title,
  children,
}: {
  query: string;
  title: string;
  children: ReactNode;
}) {
  if (query.trim())
    return (
      <p className="openduet-type-sub px-1 text-openduet-ink-2" role="status">
        Nothing matches “{query.trim()}”.
      </p>
    );
  return (
    <div className="px-1">
      <p className="openduet-type-body font-semibold text-openduet-ink">
        {title}
      </p>
      <p className="openduet-type-sub mt-0.5 text-openduet-ink-2">{children}</p>
    </div>
  );
}

/**
 * One section: its name and how many, in regular grey so the rows lead, then its rows straight on
 * the page. The first section also says when the list was last read.
 */
function Section({
  label,
  count,
  updated,
  id,
  sectionRef,
  children,
}: {
  label: string;
  count: number;
  /** When the data under it was read, for "Updated …" on the right. */
  updated?: number;
  id?: string;
  sectionRef?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="flex scroll-mt-[96px] flex-col gap-5"
      id={id}
      ref={sectionRef}
    >
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="openduet-type-body min-w-0 font-normal text-openduet-ink-2">
          {label} <span className="tabular-nums">{count}</span>
        </h2>
        {updated ? (
          <span className="openduet-type-sub ml-auto shrink-0 text-openduet-ink-2">
            Updated {relativeTime(new Date(updated).toISOString())}
          </span>
        ) : null}
      </div>
      <ul className="flex flex-col gap-6">{children}</ul>
    </section>
  );
}

/** The glyph for each kind of waiting action. */
const ACTION_GLYPH: Record<ActionKind, Icon> = {
  command: IconTerminal2,
  file: IconFile,
  mail: IconMail,
  browser: IconWorld,
  other: IconShield,
};

/**
 * One action a Bot wants to take, as OpenDuet draws it: what it is and where, why the Bot asked,
 * everything it would send one tap away under Details, and the person's answers. Allow once and
 * Deny share the row; Always allow here is a quiet text button under them, because it changes a rule
 * rather than answering this one request. A hand-off asks the person to do it, or not.
 */
export function ApprovalCard({
  request,
  botName,
  busy,
  error,
  onDecide,
}: {
  request: ApprovalRequest;
  botName: string;
  busy: boolean;
  error: string | null;
  onDecide: (choice: ApprovalDecision) => void;
}) {
  const detailsId = useId();
  const handOff = request.action.policy?.behaviour === "hand_off";
  const name = actionName(request.action.toolRef);
  const title = handOff
    ? `This needs you: ${name}`
    : `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  return (
    <DuetCard aria-label="Waiting for your approval" raised role="region">
      <div className="flex min-h-[54px] items-center gap-2.5 px-4 py-2.5">
        <Tile
          icon={ACTION_GLYPH[actionKind(request.action.toolRef)]}
          size={32}
        />
        <div className="min-w-0 flex-1">
          <p className="openduet-type-body font-semibold [overflow-wrap:anywhere]">
            {title}
          </p>
          <p className="openduet-type-caption truncate text-openduet-ink-3">
            {[botName, request.action.scope].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      {request.action.policy?.reason ? (
        <>
          <Rule />
          <p className="openduet-type-sub px-4 pt-2.5 text-openduet-ink-2">
            {handOff ? "Handed to you: " : ""}
            {request.action.policy.reason}
          </p>
        </>
      ) : null}
      <details className="group px-4 pb-1">
        <summary
          aria-controls={detailsId}
          className="openduet-type-sub inline-flex min-h-11 cursor-pointer list-none items-center gap-1 py-1 font-medium text-openduet-ink-3 outline-none focus-visible:underline [&::-webkit-details-marker]:hidden"
        >
          Details
          <IconChevronRight
            className="transition-transform group-open:rotate-90"
            size={14}
            stroke={2.2}
          />
        </summary>
        <pre
          className="mt-1 mb-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-openduet-tile p-3 font-mono text-openduet-ink-2 text-xs"
          id={detailsId}
        >
          {JSON.stringify(request.action.args, null, 2)}
        </pre>
      </details>
      {error ? (
        <p
          className="openduet-type-sub px-4 pb-2 text-openduet-problem"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="px-4 pt-1 pb-3">
        <div className="flex flex-wrap gap-2">
          {handOff ? (
            <>
              <PillButton disabled={busy} onClick={() => onDecide("deny")}>
                Don't do it
              </PillButton>
              <PillButton
                disabled={busy}
                onClick={() => onDecide("handled")}
                primary
              >
                I did it myself
              </PillButton>
            </>
          ) : (
            <>
              <PillButton disabled={busy} onClick={() => onDecide("deny")}>
                Deny
              </PillButton>
              <PillButton
                disabled={busy}
                onClick={() => onDecide("allow_once")}
                primary
              >
                Allow once
              </PillButton>
            </>
          )}
        </div>
        {handOff ? null : (
          <button
            className={cn(
              "openduet-type-sub mx-auto mt-1 flex h-11 items-center rounded-full px-3 font-medium text-openduet-ink-2 hover:text-openduet-ink disabled:opacity-50",
              FOCUS,
            )}
            disabled={busy}
            onClick={() => onDecide("allow_always")}
            type="button"
          >
            Always allow here
          </button>
        )}
      </div>
    </DuetCard>
  );
}

/** A question a Bot asked mid-run, answered here: the run picks up with the answer. */
function QuestionCard({
  question,
  botName,
  busy,
  error,
  onAnswer,
}: {
  question: PersonQuestion;
  botName: string;
  busy: boolean;
  error: string | null;
  onAnswer: (response: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const send = () => {
    if (draft.trim()) onAnswer(draft.trim());
  };
  return (
    <DuetCard aria-label={`${botName} asks`} raised role="region">
      <div className="flex gap-2.5 px-4 pt-3">
        <Tile icon={IconMessageQuestion} size={32} tone="needs" />
        <div className="min-w-0 flex-1">
          <p className="openduet-type-caption font-semibold text-openduet-needs">
            {botName} asks
          </p>
          <p className="openduet-type-body mt-0.5 font-semibold [overflow-wrap:anywhere]">
            {question.question}
          </p>
          {question.why ? (
            <p className="openduet-type-sub mt-0.5 text-openduet-ink-2">
              {question.why}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 pt-3 pb-3">
        <Textarea
          aria-label="Your answer"
          onKeyDown={(event) => {
            // ⌘ or Ctrl with Enter sends; Enter alone is a new line in the answer.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
          className="openduet-type-sub min-h-[76px] rounded-[18px] border-openduet-hair bg-openduet-surface px-3.5 py-2.5"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Your answer"
          value={draft}
        />
        {error ? (
          <p className="openduet-type-sub text-openduet-problem" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex">
          <PillButton
            disabled={busy || !draft.trim()}
            onClick={send}
            primary
            small
          >
            {busy ? "Sending…" : "Send answer"}
          </PillButton>
        </div>
      </div>
    </DuetCard>
  );
}

const ROW_LINK = cn(
  "-my-1 block min-w-0 flex-1 rounded-[12px] py-1 hover:opacity-80",
  FOCUS,
);

/** The leading glyph of a flat row, in the colour of how it stands. */
function RowGlyph({ glyph: Glyph, tone }: { glyph: Icon; tone: string }) {
  return (
    <span
      aria-hidden
      className={cn("grid size-[22px] shrink-0 place-items-center", tone)}
    >
      <Glyph size={20} stroke={2} />
    </span>
  );
}

/** The title of a flat row: bold, at most two lines. */
function RowTitle({ children }: { children: ReactNode }) {
  return (
    <p className="openduet-type-body line-clamp-2 font-semibold text-openduet-ink [overflow-wrap:anywhere]">
      {children}
    </p>
  );
}

/**
 * A responsibility a Bot carries, as a flat row: what it is, where it stands in the Bot's own words,
 * and whose. It opens that Bot's responsibilities, where it is paused, run or finished.
 */
function ResponsibilityLine({
  row,
  botName,
}: {
  row: ResponsibilityRecord;
  botName: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <RowGlyph glyph={IconTargetArrow} tone="text-openduet-working" />
      <Link
        className={ROW_LINK}
        params={{ agentId: row.agentId }}
        to="/bots/$agentId/responsibilities"
      >
        <RowTitle>{row.title}</RowTitle>
        <StatusLine standing="working" word="Ongoing">
          {row.progress || row.lastResult || row.instruction}
        </StatusLine>
        <Caption>
          {botName} · Updated {relativeTime(row.updatedAt)}
        </Caption>
      </Link>
    </div>
  );
}

/**
 * A routine that will fire, as a flat row: the instruction, when it runs next and how often (the
 * server's own words), and whose. A last run that failed says so. It opens Routines.
 */
function RoutineLine({
  row,
  botName,
}: {
  row: RoutineRecord;
  botName: string;
}) {
  const failed = row.lastRun?.status === "failed";
  return (
    <div className="flex items-start gap-3">
      <RowGlyph
        glyph={IconRepeat}
        tone={failed ? "text-openduet-problem" : "text-openduet-ink-3"}
      />
      <Link className={ROW_LINK} to="/routines">
        <RowTitle>{row.instruction}</RowTitle>
        <StatusLine
          standing={failed ? "problem" : "scheduled"}
          word={
            failed ? "Last run failed" : `Next ${relativeTime(row.nextRunAt)}`
          }
        >
          {row.schedule}
        </StatusLine>
        <Caption>
          {[botName, row.channel.gone ? null : row.channel.name]
            .filter(Boolean)
            .join(" · ")}
        </Caption>
      </Link>
    </div>
  );
}

/**
 * Tasks' Up next: the next steps background research suggested and nobody has started yet. Each
 * card takes Start as task, which hands it to its Bot, or Dismiss.
 */
function UpNextView({ order, query }: { order: SortOrder; query: string }) {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const botName = useBotName();
  // Who took the last started suggestion, said once it has gone from the list.
  const [started, setStarted] = useState<string | null>(null);

  if (suggestions.isPending) return null;
  const shown = tasksModel({
    inbox: undefined,
    responsibilities: undefined,
    routines: undefined,
    suggestions: suggestions.data,
    order,
    query,
  }).suggestions;
  const answer = (
    suggestion: ProactiveSuggestion,
    action: "start" | "dismiss",
  ) => {
    setStarted(null);
    act.mutate(
      { id: suggestion.id, action },
      {
        onSuccess: () => {
          if (action === "start") setStarted(botName(suggestion.agentId));
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      {suggestions.error ? (
        <p
          className="openduet-type-sub px-1 text-openduet-problem"
          role="alert"
        >
          Couldn't load Up next. Reload the page.
        </p>
      ) : shown.length === 0 ? (
        <EmptyLine query={query} title="Nothing to start right now.">
          Bots with background research on suggest next steps here.
        </EmptyLine>
      ) : (
        <section aria-label="Up next">
          <ul className="flex flex-col gap-2.5">
            {shown.map((suggestion) => (
              <li key={suggestion.id}>
                <SuggestionCard
                  botName={botName(suggestion.agentId)}
                  busy={act.isPending && act.variables?.id === suggestion.id}
                  error={
                    act.error && act.variables?.id === suggestion.id
                      ? act.error.message
                      : null
                  }
                  onAnswer={(action) => answer(suggestion, action)}
                  suggestion={suggestion}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {started ? (
        <p className="openduet-type-sub px-1 text-openduet-ink-2" role="status">
          Started. {started} is on it.
        </p>
      ) : null}
    </div>
  );
}

/** One thing not started: what to do, a line or two of why, who and where from, and its answers. */
function SuggestionCard({
  suggestion,
  botName,
  busy,
  error,
  onAnswer,
}: {
  suggestion: ProactiveSuggestion;
  botName: string;
  busy: boolean;
  error: string | null;
  onAnswer: (action: "start" | "dismiss") => void;
}) {
  const app =
    suggestion.sourceApp || suggestion.sourceLink
      ? `From ${suggestion.sourceApp ?? "a connected app"}`
      : null;
  return (
    <DuetCard className="px-4 py-3">
      <p className="openduet-type-body font-semibold text-openduet-ink [overflow-wrap:anywhere]">
        {suggestion.title}
      </p>
      {suggestion.detail ? (
        <p className="openduet-type-sub line-clamp-2 text-openduet-ink-2 [overflow-wrap:anywhere]">
          {suggestion.detail}
        </p>
      ) : null}
      <Caption>
        {botName}
        {app ? (
          <>
            {" · "}
            {suggestion.sourceLink ? (
              <a
                className="underline decoration-openduet-hair underline-offset-2 hover:text-openduet-ink"
                href={suggestion.sourceLink}
                rel="noreferrer"
                target="_blank"
              >
                {app}
              </a>
            ) : (
              app
            )}
          </>
        ) : null}
      </Caption>
      {error ? (
        <p
          className="openduet-type-sub mt-1 text-openduet-problem"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-2.5 flex gap-2">
        <PillButton
          aria-label={`Dismiss ${suggestion.title}`}
          disabled={busy}
          onClick={() => onAnswer("dismiss")}
          small
        >
          Dismiss
        </PillButton>
        <PillButton
          aria-label={`Start ${suggestion.title} as a task`}
          disabled={busy}
          onClick={() => onAnswer("start")}
          primary
          small
        >
          Start as task
        </PillButton>
      </div>
    </DuetCard>
  );
}
