import {
  IconArrowUpRight,
  IconClock,
  IconCube,
  IconDeviceDesktop,
  IconFileText,
  IconPlug,
  IconWorld,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { ChannelAvatar } from "@/components/channels/avatar";
import { setupSummary } from "@/lib/agents/bot-summaries";
import { agentQueryOptions } from "@/lib/agents/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { briefDuration } from "@/lib/elapsed";
import { markFor } from "@/lib/marks";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { type BotTask, taskTurnsQueryOptions } from "@/lib/tasks/queries";
import { type Output, type Source, useThreadWork } from "./thread-work";

/*
 * A task's details, beside its thread: which Bot ran it and on what, what it read, and what it
 * made, as dots lays out a task's Outputs, Sources and Environment. Stacked for the narrow pane,
 * each a short list of one-line rows that open what they name.
 *
 * Who ran it is the Bot and what runs it (its framework, or built in). The model is the one the
 * task's latest turn used, and how long it worked is its turns' time added up, both as the server
 * recorded them (listTaskTurns). Sources and outputs are read
 * from the thread itself (`threadWorkOf`). The Bot's computer is named only when the task used it.
 */

/** How many rows a list shows before "View all". */
const SHOWN = 4;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One line of a list: its icon, what it names, and the way to it when it has one. */
function Row({
  icon,
  label,
  detail,
  href,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  href?: string;
}) {
  const body = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {detail ? (
          <span className="block truncate text-muted-foreground text-xs">
            {detail}
          </span>
        ) : null}
      </span>
      {href ? (
        <IconArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );
  const shape = "-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5";
  return (
    <li>
      {href ? (
        <a
          className={`${shape} outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50`}
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          {body}
        </a>
      ) : (
        <div className={shape}>{body}</div>
      )}
    </li>
  );
}

/** A list that shows its first few rows, and the rest on "View all". */
function ShortList<T>({
  items,
  empty,
  row,
}: {
  items: T[];
  empty: string;
  row: (item: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  if (items.length === 0)
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <div className="grid gap-1">
      <ul className="grid">{shown.map(row)}</ul>
      {items.length > SHOWN ? (
        <button
          className="w-fit rounded-sm text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => setAll(!all)}
          type="button"
        >
          {all ? "Show fewer" : `View all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}

/** A page's address as a person reads it: the site, then the path. */
function addressOf(href: string): { site: string; path: string } {
  try {
    const url = new URL(href);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
    return { site: url.host.replace(/^www\./, ""), path };
  } catch {
    return { site: href, path: "" };
  }
}

function SourceRow(source: Source) {
  if (source.kind === "app")
    return (
      <Row
        icon={<IconPlug className="size-4" />}
        key={`app:${source.app}`}
        label={source.app}
      />
    );
  const { site, path } = addressOf(source.href);
  return (
    <Row
      detail={source.title ?? (path || undefined)}
      href={source.href}
      icon={<IconWorld className="size-4" />}
      key={source.href}
      label={site}
    />
  );
}

function OutputRow(output: Output) {
  return (
    <Row
      detail={output.app}
      href={output.href}
      icon={<IconFileText className="size-4" />}
      key={`${output.href ?? ""}\n${output.label}`}
      label={output.label}
    />
  );
}

/** The model a turn used, by the name and mark the model picker gives it. */
function ModelLine({ model }: { model: string }) {
  const { data: catalogue } = useQuery(modelCatalogueQueryOptions());
  // Usage names a model with its provider ("openai/gpt-6.1-terra"); the catalogue by its own id.
  const bare = model.slice(model.indexOf("/") + 1);
  const known = catalogue?.models.find(
    (one) => one.id === model || one.id === bare,
  );
  const label = known?.label ?? bare;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      {known?.vendor && markFor(known.vendor) ? (
        <HarnessMark className="size-3.5" id={known.vendor} name={label} />
      ) : (
        <IconCube aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

export function TaskDetails({ task }: { task: BotTask }) {
  const work = useThreadWork(task.threadId ?? undefined);
  const { data: bot } = useQuery(agentQueryOptions(task.agentId));
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const { data: turns } = useQuery(
    taskTurnsQueryOptions(task.id, task.status === "working"),
  );
  const model = turns?.findLast((turn) => turn.model)?.model ?? null;
  // Its turns' time, added up. A subagent a turn started worked inside that turn, so it is in here.
  const worked = turns?.length
    ? turns.reduce((sum, turn) => sum + turn.workedSeconds, 0)
    : null;
  /*
   * While the task works or waits on the person, what it has not made or read it may still: "yet".
   * Once it has ended (done, couldn't finish or stopped), nothing is coming.
   */
  const ongoing = task.status === "working" || task.status === "needs_input";
  const yet = ongoing ? " yet" : "";
  return (
    <div className="flex w-full flex-col gap-6 p-8" data-slot="task-details">
      <Section title="Ran by">
        <div className="flex items-center gap-3">
          <ChannelAvatar participantIds={[task.agentId]} size={32} />
          <div className="grid min-w-0 gap-0.5">
            <span className="truncate font-medium text-sm">
              {bot?.name ?? "Your Bot"}
            </span>
            <span className="truncate text-muted-foreground text-xs">
              {bot ? setupSummary(bot, personal ? "personal" : "team") : null}
            </span>
            {model ? <ModelLine model={model} /> : null}
            {worked !== null ? (
              <span
                className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
                data-slot="task-worked"
              >
                <IconClock aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">
                  Worked for {briefDuration(worked)}
                </span>
              </span>
            ) : null}
            {task.agent ? (
              // A task the Bot handed to one of its agents: the agent did the work.
              <span
                className="truncate text-muted-foreground text-xs"
                data-slot="task-agent"
              >
                Handed to {task.agent.name}
              </span>
            ) : null}
          </div>
        </div>
      </Section>
      <Section title="Outputs">
        <ShortList
          empty={`Nothing made or changed${yet}.`}
          items={work.outputs}
          row={OutputRow}
        />
      </Section>
      <Section title="Sources">
        <ShortList
          empty={`Nothing read${yet}.`}
          items={work.sources}
          row={SourceRow}
        />
      </Section>
      {work.usedComputer ? (
        <Section title="Computer">
          <ul className="grid">
            <Row
              detail="Opened pages in its browser"
              icon={<IconDeviceDesktop className="size-4" />}
              label="Bot computer"
            />
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
