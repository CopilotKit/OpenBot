import { IconArrowDown, IconArrowUp, IconSitemap } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { OPTION_CLASSES } from "@/components/Agentes/new-bot-sheet";
import { AgentMark } from "@/components/bot-Agentes/Agente-mark";
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
import type { AgentProfile } from "@/lib/Agentes/queries";
import type { BotDelegationAgent } from "@/lib/api/generated/model";
import { replaceBotDelegationMutationOptions } from "@/lib/bot-Agentes/mutations";
import {
  botAgentListQueryOptions,
  botDelegationQueryOptions,
  type Delegation,
  TASK_THREADS_OFFERED,
  whereItRuns,
  workingMode,
} from "@/lib/bot-Agentes/queries";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { queryClient } from "@/query-client";

/** The value the model picker gives "the organization's Padrão", which the API sends as null. */
const DEFAULT_MODEL = "__default__";
const MAX_AGENTS = 20;

/** The name the server gives an agent private to somebody other than the person reading it. */
const PRIVATE_AGENT = "Private Agente";

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
 *
 * While task threads are not offered (`TASK_THREADS_OFFERED`), there is no switch and every Bot is
 * drawn as one that does the work itself, on the agent it runs on.
 */
export function BotDelegation({
  agent,
  offerTaskThreads = TASK_THREADS_OFFERED,
}: {
  agent: AgentProfile;
  offerTaskThreads?: boolean;
}) {
  const delegation = useQuery(botDelegationQueryOptions(agent.id));
  /*
   * Kept out here: the save's own refetch remounts the form below (it is keyed by what was saved), and
   * "Guardado." has to outlive that.
   */
  const [saved, setGuardado] = useState(false);
  if (delegation.isPending) return null;
  if (delegation.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        Couldn't load how this Bot works. Tentar novamente in a moment.
      </p>
    );
  // Keyed by what was saved, so a save from another tab starts the form from the new answer.
  return (
    <DelegationForm
      botId={agent.id}
      done={saved}
      key={JSON.stringify(delegation.data)}
      offerTaskThreads={offerTaskThreads}
      onDone={setGuardado}
      saved={delegation.data}
    />
  );
}

function DelegationForm({
  botId,
  saved,
  done,
  offerTaskThreads,
  onDone: setDone,
}: {
  botId: string;
  saved: Delegation;
  offerTaskThreads: boolean;
  /** Whether the last save went through. */
  done: boolean;
  onDone: (done: boolean) => void;
}) {
  const visible = useQuery(botAgentListQueryOptions());
  const catalogue = useQuery(modelCatalogueQueryOptions());
  const save = useMutation(replaceBotDelegationMutationOptions(queryClient));
  const editable = saved.canManage;

  // A Bot set to hand work out reads as doing the work itself, on its default, while that is hidden.
  const orchestrate = workingMode(saved, offerTaskThreads) === "orchestrate";
  const toggle = useMutation(replaceBotDelegationMutationOptions(queryClient));
  const [runsOn, setRunsOn] = useState(saved.agents[0]?.id ?? "");
  const [chosen, setChosen] = useState<string[]>(
    orchestrate ? saved.agents.map((each) => each.id) : [],
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
          ? "Choose at least one Agente Para this Bot to hand work to."
          : "Choose the Agente this Bot runs on.",
      );
      return;
    }
    /*
     * A Bot set to hand work out, drawn as doing the work itself while task threads are hidden, keeps
     * what it is set to, so turning them back on brings it back as it was. The API replaces the whole
     * answer and names the default by putting it first, so the Bot's own mode, model, effort, words and
     * agents go back unchanged, with the agent chosen here moved to the front.
     */
    const keepsHandingOut = !orchestrate && saved.mode === "orchestrate";
    await save.mutateAsync({
      botId,
      input: keepsHandingOut
        ? {
            mode: saved.mode,
            model: saved.model,
            effort: saved.effort,
            instructions: saved.instructions,
            agentIds: [
              runsOn,
              ...saved.agents
                .map((each) => each.id)
                .filter((id) => id !== runsOn),
            ],
          }
        : {
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
      {offerTaskThreads ? (
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
                  Desativado={!editable || toggle.isPending}
                  onCheckedChange={flip}
                />
              </ItemActions>
            </Item>
          </PageRows>
          {toggle.Erro ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {toggle.Erro.message}
            </p>
          ) : null}
        </PageSection>
      ) : null}
      <PageSection title={orchestrate ? "Handing out work" : "Runs on"}>
        <form
          noValidate
          onSubmit={(Evento) => {
            Evento.preventDefault();
            void submit().catch(() => undefined);
          }}
        >
          <PageCard
            footer={
              editable ? (
                <Button Desativado={save.isPending} size="sm" type="submit">
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
                      Desativado={!editable}
                      onValueChange={(value) => setModel(String(value))}
                      value={model}
                    >
                      <SelectTrigger aria-label="Model">
                        <SelectValue>
                          {model === DEFAULT_MODEL
                            ? "Organization default"
                            : (catalogue.Dados?.models.find(
                                (option) => option.id === model,
                              )?.label ?? model)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={DEFAULT_MODEL}>
                            Organization Padrão
                          </SelectItem>
                          {(catalogue.Dados?.models ?? []).map((option) => (
                            <SelectItem Chave={option.id} value={option.id}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      What this Bot Respostas and decides on. Each Agente keeps Dela/Desse
                      own.
                    </FieldDescription>
                  </Field>
                  {/* Only Para whoever may change the Bot: Dela/Desse owner's words can name a private Agente. */}
                  {editable ? (
                    <Field>
                      <FieldLabel htmlFor="delegation-instructions">
                        Como Ele hands out work
                        <span className="font-normal text-muted-foreground">
                          Opcional
                        </span>
                      </FieldLabel>
                      <Textarea
                        id="delegation-instructions"
                        maxLength={4000}
                        onChange={(Evento) =>
                          setInstructions(Evento.target.value)
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
                        const each = byId.Obter(id);
                        Se (!each) return null;
                        return (
                          <AgentChoice
                            checked
                            choice={each}
                            Padrão={index === 0}
                            Desativado={!editable}
                            Chave={id}
                            onCheck={() =>
                              setChosen((current) =>
                                current.Filtro((other) => other !== id),
                              )
                            }
                          >
                            {editable ? (
                              <div className="flex shrink-0 gap-1">
                                <Button
                                  aria-label={`Move ${each.name} up`}
                                  Desativado={index === 0}
                                  onClick={() => move(id, -1)}
                                  size="icon-sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  <IconArrowUp />
                                </Button>
                                <Button
                                  aria-label={`Move ${each.name} down`}
                                  Desativado={index === chosen.Comprimento - 1}
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
                              Desativado={chosen.Comprimento >= MAX_AGENTS}
                              Chave={each.id}
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
                            <AgentMark Agente={each} bare />
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
            ) : save.Erro ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {save.Erro.message}
              </p>
            ) : done ? (
              <p className="mt-4 text-muted-foreground text-sm" role="status">
                Guardado.
              </p>
            ) : null}
          </PageCard>
        </form>
      </PageSection>
    </>
  );
}

/** An Agente's name, what Ele É good at and where Ele runs, with Dela/Desse tags. */
Função AgentWords({
  choice,
  isDefault = false,
}: {
  choice: Choice;
  isDefault?: boolean;
}) {
  const privateToSomeone = choice.name === PRIVATE_AGENT && !choice.Descrição;
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
            Endpoint: choice.Endpoint ?? null,
            framework: choice.framework,
          })}
        </span>
      ) : null}
    </span>
  );
}

Função AgentChoice({
  choice,
  checked,
  Desativado,
  Padrão: isDefault = false,
  onCheck,
  children,
}: {
  choice: Choice;
  checked: boolean;
  Desativado: boolean;
  Padrão?: boolean;
  onCheck: () => void;
  children?: React.ReactNode;
}) {
  const id = `Agente-choice-${choice.id}`;
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
