import { IconArrowDown, IconArrowUp, IconSitemap } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { OPTION_CLASSES } from "@/components/agents/new-bot-sheet";
import { AgentMark } from "@/components/bot-agents/agent-mark";
import {
  PageCard,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { MetaTag } from "@/components/needs-you/board-row";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AgentProfile } from "@/lib/agents/queries";
import type { BotDelegationAgent } from "@/lib/api/generated/model";
import { replaceBotDelegationMutationOptions } from "@/lib/bot-agents/mutations";
import {
  botAgentListQueryOptions,
  botDelegationQueryOptions,
  type Delegation,
  whereItRuns,
} from "@/lib/bot-agents/queries";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { queryClient } from "@/query-client";

/** The value the model picker gives "the organization's default", which the API sends as null. */
const DEFAULT_MODEL = "__default__";
const MAX_AGENTS = 20;

/** The name the server gives an agent private to somebody other than the person reading it. */
const PRIVATE_AGENT = "Private agent";

/** One agent as this page draws it: from the Bot's own list, or from the agents the person sees. */
type Choice = Pick<
  BotDelegationAgent,
  "id" | "name" | "description" | "kind"
> & {
  framework?: string;
  endpoint?: string | null;
  available: boolean;
};

/**
 * How a Bot works: on its one agent, doing the work itself with its apps, or handing the work to the
 * agents it may use while it answers quickly. One form, saved together, because the switch means
 * nothing without the agents it switches to.
 */
export function BotDelegation({ agent }: { agent: AgentProfile }) {
  const delegation = useQuery(botDelegationQueryOptions(agent.id));
  /*
   * Kept out here: the save's own refetch remounts the form below (it is keyed by what was saved), and
   * "Saved." has to outlive that.
   */
  const [saved, setSaved] = useState(false);
  if (delegation.isPending) return null;
  if (delegation.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        Couldn't load how this Bot works. Try again in a moment.
      </p>
    );
  // Keyed by what was saved, so a save from another tab starts the form from the new answer.
  return (
    <DelegationForm
      botId={agent.id}
      done={saved}
      key={JSON.stringify(delegation.data)}
      onDone={setSaved}
      saved={delegation.data}
    />
  );
}

function DelegationForm({
  botId,
  saved,
  done,
  onDone: setDone,
}: {
  botId: string;
  saved: Delegation;
  /** Whether the last save went through. */
  done: boolean;
  onDone: (done: boolean) => void;
}) {
  const visible = useQuery(botAgentListQueryOptions());
  const catalogue = useQuery(modelCatalogueQueryOptions());
  const save = useMutation(replaceBotDelegationMutationOptions(queryClient));
  const editable = saved.canManage;

  const orchestrate = saved.mode === "orchestrate";
  const toggle = useMutation(replaceBotDelegationMutationOptions(queryClient));
  const [runsOn, setRunsOn] = useState(saved.agents[0]?.id ?? "");
  const [chosen, setChosen] = useState<string[]>(
    saved.mode === "orchestrate" ? saved.agents.map((each) => each.id) : [],
  );
  const [model, setModel] = useState(saved.model ?? DEFAULT_MODEL);
  const [instructions, setInstructions] = useState(saved.instructions);
  const [problem, setProblem] = useState<string>();

  // Every agent this page can name: the Bot's own first, as the server described them, then the rest.
  const byId = new Map<string, Choice>();
  for (const each of saved.agents) byId.set(each.id, each);
  for (const each of visible.data ?? [])
    if (!byId.has(each.id))
      byId.set(each.id, {
        id: each.id,
        name: each.name,
        description: each.description,
        kind: each.kind,
        framework: each.framework,
        endpoint: each.endpoint,
        available: true,
      });
  const all = [...byId.values()];
  const others = all.filter(
    (each) => !chosen.includes(each.id) && each.available,
  );

  const move = (id: string, by: -1 | 1) =>
    setChosen((current) => {
      const at = current.indexOf(id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[at], next[to]] = [next[to] as string, next[at] as string];
      return next;
    });

  const submit = async () => {
    setProblem(undefined);
    setDone(false);
    const agentIds = orchestrate ? chosen : runsOn ? [runsOn] : [];
    if (agentIds.length === 0) {
      setProblem(
        orchestrate
          ? "Choose at least one agent for this Bot to hand work to."
          : "Choose the agent this Bot runs on.",
      );
      return;
    }
    await save.mutateAsync({
      botId,
      input: {
        mode: orchestrate ? "orchestrate" : "self",
        model: model === DEFAULT_MODEL ? null : model,
        effort: saved.effort,
        instructions,
        agentIds,
      },
    });
    setDone(true);
  };

  /*
   * The switch saves on its own, as a switch does. Turning it on keeps the agent the Bot runs on as
   * its first and default; turning it off runs the Bot on its default agent again. What was saved
   * for the other mode (the model, the instructions) is kept for when it is turned back on.
   */
  const flip = (next: boolean) => {
    setDone(false);
    const own = saved.agents.filter((each) => each.available);
    const first = own[0] ?? saved.agents[0];
    if (!first) return;
    toggle.mutate({
      botId,
      input: {
        mode: next ? "orchestrate" : "self",
        model: saved.model,
        effort: saved.effort,
        instructions: saved.instructions,
        agentIds: next ? own.map((each) => each.id) : [first.id],
      },
    });
  };

  return (
    <>
      <PageSection>
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconSitemap />
            </ItemMedia>
            <ItemContent>
              <ItemTitle id={`hand-work-${botId}`}>
                Hand work to agents
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                {orchestrate
                  ? "This Bot answers quickly and hands the work to the agents below. They act with this Bot's apps, as the person who asked."
                  : "This Bot does the work itself, with its apps."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-labelledby={`hand-work-${botId}`}
                checked={toggle.isPending ? !orchestrate : orchestrate}
                disabled={!editable || toggle.isPending}
                onCheckedChange={flip}
              />
            </ItemActions>
          </Item>
        </PageRows>
        {toggle.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {toggle.error.message}
          </p>
        ) : null}
      </PageSection>
      <PageSection title={orchestrate ? "Handing out work" : "Runs on"}>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit().catch(() => undefined);
          }}
        >
          <PageCard
            footer={
              editable ? (
                <Button disabled={save.isPending} size="sm" type="submit">
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              ) : undefined
            }
          >
            <FieldGroup>
              {orchestrate ? (
                <>
                  <Field>
                    <FieldLabel>Model</FieldLabel>
                    <Select
                      disabled={!editable}
                      onValueChange={(value) => setModel(String(value))}
                      value={model}
                    >
                      <SelectTrigger aria-label="Model">
                        <SelectValue>
                          {model === DEFAULT_MODEL
                            ? "Organization default"
                            : (catalogue.data?.models.find(
                                (option) => option.id === model,
                              )?.label ?? model)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={DEFAULT_MODEL}>
                            Organization default
                          </SelectItem>
                          {(catalogue.data?.models ?? []).map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      What this Bot answers and decides on. Each agent keeps its
                      own.
                    </FieldDescription>
                  </Field>
                  {/* Only for whoever may change the Bot: its owner's words can name a private agent. */}
                  {editable ? (
                    <Field>
                      <FieldLabel htmlFor="delegation-instructions">
                        How it hands out work
                        <span className="font-normal text-muted-foreground">
                          Optional
                        </span>
                      </FieldLabel>
                      <Textarea
                        id="delegation-instructions"
                        maxLength={4000}
                        onChange={(event) =>
                          setInstructions(event.target.value)
                        }
                        placeholder="For example: send anything about numbers to the agent that works with figures, and answer greetings yourself."
                        rows={4}
                        value={instructions}
                      />
                    </Field>
                  ) : null}
                  <FieldSet>
                    <FieldLegend variant="label">Agents it may use</FieldLegend>
                    <FieldDescription>
                      It reads what each one is good at to decide. The first is
                      its default, and it gets the work nobody waits on, such as
                      routines.
                    </FieldDescription>
                    <ul aria-label="Agents it may use" className="grid gap-2">
                      {chosen.map((id, index) => {
                        const each = byId.get(id);
                        if (!each) return null;
                        return (
                          <AgentChoice
                            checked
                            choice={each}
                            default={index === 0}
                            disabled={!editable}
                            key={id}
                            onCheck={() =>
                              setChosen((current) =>
                                current.filter((other) => other !== id),
                              )
                            }
                          >
                            {editable ? (
                              <div className="flex shrink-0 gap-1">
                                <Button
                                  aria-label={`Move ${each.name} up`}
                                  disabled={index === 0}
                                  onClick={() => move(id, -1)}
                                  size="icon-sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  <IconArrowUp />
                                </Button>
                                <Button
                                  aria-label={`Move ${each.name} down`}
                                  disabled={index === chosen.length - 1}
                                  onClick={() => move(id, 1)}
                                  size="icon-sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  <IconArrowDown />
                                </Button>
                              </div>
                            ) : null}
                          </AgentChoice>
                        );
                      })}
                      {editable
                        ? others.map((each) => (
                            <AgentChoice
                              checked={false}
                              choice={each}
                              disabled={chosen.length >= MAX_AGENTS}
                              key={each.id}
                              onCheck={() =>
                                setChosen((current) => [...current, each.id])
                              }
                            />
                          ))
                        : null}
                    </ul>
                  </FieldSet>
                </>
              ) : (
                <FieldSet>
                  <FieldLegend className="sr-only" variant="label">
                    Runs on
                  </FieldLegend>
                  <div className="grid gap-2">
                    {all
                      .filter((each) => each.available || each.id === runsOn)
                      .map((each) => (
                        <button
                          aria-pressed={runsOn === each.id}
                          className={OPTION_CLASSES}
                          disabled={!editable}
                          key={each.id}
                          onClick={() => setRunsOn(each.id)}
                          type="button"
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
                            <AgentMark agent={each} bare />
                          </span>
                          <AgentWords choice={each} />
                        </button>
                      ))}
                  </div>
                </FieldSet>
              )}
            </FieldGroup>
            {problem ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {problem}
              </p>
            ) : save.error ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {save.error.message}
              </p>
            ) : done ? (
              <p className="mt-4 text-muted-foreground text-sm" role="status">
                Saved.
              </p>
            ) : null}
          </PageCard>
        </form>
      </PageSection>
    </>
  );
}

/** An agent's name, what it is good at and where it runs, with its tags. */
function AgentWords({
  choice,
  isDefault = false,
}: {
  choice: Choice;
  isDefault?: boolean;
}) {
  const privateToSomeone = choice.name === PRIVATE_AGENT && !choice.description;
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-sm">{choice.name}</span>
        {isDefault ? <MetaTag>Default</MetaTag> : null}
        {!choice.available ? <MetaTag>Unavailable</MetaTag> : null}
      </span>
      <span className="block text-pretty text-muted-foreground text-xs">
        {privateToSomeone
          ? "Somebody else's private agent."
          : !choice.available
            ? "This Bot can't hand it work any more. Remove it."
            : choice.description}
      </span>
      {choice.available && !privateToSomeone ? (
        <span className="block text-muted-foreground text-xs">
          {whereItRuns({
            kind: choice.kind,
            endpoint: choice.endpoint ?? null,
            framework: choice.framework,
          })}
        </span>
      ) : null}
    </span>
  );
}

function AgentChoice({
  choice,
  checked,
  disabled,
  default: isDefault = false,
  onCheck,
  children,
}: {
  choice: Choice;
  checked: boolean;
  disabled: boolean;
  default?: boolean;
  onCheck: () => void;
  children?: React.ReactNode;
}) {
  const id = `agent-choice-${choice.id}`;
  return (
    <li className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
      <Checkbox
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={() => onCheck()}
      />
      <label className="flex min-w-0 flex-1 items-center gap-3" htmlFor={id}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground [&_svg]:size-4">
          <AgentMark agent={choice} bare />
        </span>
        <AgentWords choice={choice} isDefault={isDefault} />
      </label>
      {children}
    </li>
  );
}
