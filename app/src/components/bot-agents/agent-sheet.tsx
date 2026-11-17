import {
  HARNESSES,
  reachedThroughMastra,
  WEB_HARNESSES,
} from "@openbot/shared/harnesses";
import { IconLock, IconPlus, IconUsers, IconX } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CustomAgentCta } from "@/components/agents/custom-agent-cta";
import {
  EndpointStep,
  OPTION_CLASSES,
  type Runtime,
  RuntimeStep,
} from "@/components/agents/new-bot-sheet";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { agentFormSchema } from "@/lib/agents/form";
import { testAgentConnection } from "@/lib/agents/queries";
import {
  BotAgentHarness,
  type BotAgentSkill,
  type BotAgentVisibility,
} from "@/lib/api/generated/model";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import {
  createBotAgentMutationOptions,
  updateBotAgentMutationOptions,
} from "@/lib/bot-agents/mutations";
import type { AgentRecord } from "@/lib/bot-agents/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { queryClient } from "@/query-client";

/** The value the model picker gives "the organization's default", which the API sends as null. */
const DEFAULT_MODEL = "__default__";

const STEPS = ["about", "runtime", "endpoint"] as const;
type Step = (typeof STEPS)[number];

/** A skill as the form holds it, with a key of its own so a row keeps its place while typed in. */
type SkillDraft = { key: number; name: string; description: string };

/**
 * Where an agent is added, or changed: a sheet from the right, so the list stays in view behind it.
 *
 * Adding takes the New Bot sheet's steps. What it is called and what it is good at come first, and
 * by default it runs inside OpenBot. "Connect an agent you run" goes through the same framework list
 * and address step New Bot has, and the address is tried with a real run before anything is saved.
 */
export function AgentSheet({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  /** The agent being changed, or undefined to add one. */
  editing?: AgentRecord;
  onClose: () => void;
}) {
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
    >
      <SheetContent
        className="gap-0 data-[side=right]:w-[calc(100%-1rem)] data-[side=right]:sm:max-w-2xl"
        showCloseButton={false}
        side="right"
        variant="inset"
      >
        {/* Inside the popup, so it unmounts on close and a reopened sheet starts afresh. */}
        <AgentFlow editing={editing} onDone={onClose} />
      </SheetContent>
    </Sheet>
  );
}

function harnessFor(runtime: Runtime | null): BotAgentHarness | undefined {
  if (runtime?.kind !== "managed") return undefined;
  const known: readonly string[] = Object.values(BotAgentHarness);
  return runtime.harness !== "" && known.includes(runtime.harness)
    ? (runtime.harness as BotAgentHarness)
    : undefined;
}

function AgentFlow({
  editing,
  onDone,
}: {
  editing?: AgentRecord;
  onDone: () => void;
}) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const me = useQuery(currentUserQueryOptions()).data;
  const admin = isOrganizationAdmin(me?.role);
  const create = useMutation(createBotAgentMutationOptions(queryClient));
  const update = useMutation(updateBotAgentMutationOptions(queryClient));
  const saving = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  const [step, setStep] = useState<Step>("about");
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [visibility, setVisibility] = useState<BotAgentVisibility>(
    editing?.visibility ?? "private",
  );
  const [model, setModel] = useState<string>(editing?.model ?? DEFAULT_MODEL);
  const [skills, setSkills] = useState<SkillDraft[]>(() =>
    (editing?.skills ?? []).map((skill, index) => ({
      key: index,
      name: skill.name,
      description: skill.description,
    })),
  );
  const [runtime, setRuntime] = useState<Runtime | null>(
    editing?.kind === "address"
      ? { kind: "managed", harness: "byo-url" }
      : { kind: "builtin" },
  );
  const [endpoint, setEndpoint] = useState(editing?.endpoint ?? "");
  const [key, setKey] = useState("");
  const [tried, setTried] = useState(false);
  const [checking, setChecking] = useState(false);
  const [unreachable, setUnreachable] = useState<string>();
  const [missing, setMissing] = useState<string>();

  const kind = runtime?.kind === "managed" ? "address" : "openbot";
  const catalogue = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: kind === "openbot",
  });
  const busy = checking || saving;
  const endpointIssue =
    endpoint.trim() === ""
      ? "Enter your agent's address."
      : agentFormSchema.shape.endpoint.safeParse(endpoint).error?.issues[0]
          ?.message;
  const addressChanged =
    kind === "address" &&
    (endpoint.trim() !== (editing?.endpoint ?? "") || key.trim() !== "");

  const go = (to: Step) => {
    setTried(false);
    setUnreachable(undefined);
    create.reset();
    update.reset();
    setStep(to);
  };

  /** What the person typed, checked: a name, and what the agent is good at. */
  const aboutIssue = (): string | undefined => {
    if (!name.trim()) return "Give the agent a name.";
    if (!description.trim())
      return "Say what this agent is good at, so your Bots know what to send it.";
    if (skills.some((skill) => !skill.name.trim() || !skill.description.trim()))
      return "Give each thing it's good at a name and a description, or remove it.";
    return undefined;
  };

  const shownSkills = (): BotAgentSkill[] =>
    skills.map((skill) => ({
      name: skill.name.trim(),
      description: skill.description.trim(),
    }));

  /**
   * Whether this agent is a Mastra server: the framework picked, or for one being changed, the one it
   * was added with. A Mastra server has no AG-UI route, so the server proves its address against
   * Mastra's own API when it is saved, and the AG-UI test is not run.
   */
  const mastra = editing
    ? HARNESSES.some(
        (harness) =>
          reachedThroughMastra(harness.id) &&
          harness.name === editing.framework,
      )
    : runtime?.kind === "managed" && reachedThroughMastra(runtime.harness);

  /** Dial the address from the server before it is saved, as New Bot does. */
  const reachable = async (): Promise<boolean> => {
    if (endpointIssue) {
      setTried(true);
      document.getElementById("new-bot-endpoint")?.focus();
      return false;
    }
    setUnreachable(undefined);
    if (mastra) return true;
    setChecking(true);
    const verdict = await testAgentConnection(endpoint.trim(), key).finally(
      () => setChecking(false),
    );
    if (!verdict.ok) {
      setUnreachable(verdict.reason);
      document.getElementById("new-bot-endpoint")?.focus();
      return false;
    }
    return true;
  };

  const save = async () => {
    const issue = aboutIssue();
    if (issue) {
      setMissing(issue);
      if (step !== "about") go("about");
      return;
    }
    setMissing(undefined);
    if (kind === "address" && (!editing || addressChanged)) {
      if (!(await reachable())) return;
    }
    const auth = key.trim()
      ? { auth: { header: "Authorization", value: key.trim() } }
      : {};
    const chosenModel = model === DEFAULT_MODEL ? null : model;
    // One person, and the Bot they start with is the install's own: an agent here is for every Bot.
    const shown: BotAgentVisibility = personal ? "public" : visibility;
    if (editing) {
      await update.mutateAsync({
        botAgentId: editing.id,
        input: {
          name: name.trim(),
          description: description.trim(),
          visibility: shown,
          skills: shownSkills(),
          ...(kind === "openbot" ? { model: chosenModel } : {}),
          ...(kind === "address" && addressChanged
            ? { endpoint: endpoint.trim(), ...auth }
            : {}),
        },
      });
    } else {
      const harness = harnessFor(runtime);
      await create.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        visibility: shown,
        kind,
        skills: shownSkills(),
        ...(kind === "openbot"
          ? { model: chosenModel }
          : {
              endpoint: endpoint.trim(),
              ...auth,
              ...(harness ? { harness } : {}),
            }),
      });
    }
    onDone();
  };

  const submit = () => {
    if (busy) return;
    if (step === "about" && kind === "address" && !editing) {
      const issue = aboutIssue();
      if (issue) {
        setMissing(issue);
        return;
      }
      setMissing(undefined);
      go("endpoint");
      return;
    }
    // The failure is shown from the mutation's own state; nothing more to do with it here.
    void save().catch(() => undefined);
  };

  const title = editing ? `Change ${editing.name}` : "Add agent";
  const primary = checking
    ? "Checking…"
    : saving
      ? "Saving…"
      : editing
        ? "Save"
        : step === "about" && kind === "address"
          ? "Continue"
          : "Add agent";

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-6 pt-8 pb-6">
        <SheetTitle className="break-words text-2xl font-semibold tracking-tight">
          {title}
        </SheetTitle>
        <div className="mt-6">
          {step === "about" ? (
            <AboutFields
              admin={admin}
              catalogue={
                kind === "openbot"
                  ? (catalogue.data?.models ?? []).map((option) => ({
                      id: option.id,
                      label: option.label,
                    }))
                  : null
              }
              description={description}
              kind={kind}
              model={model}
              name={name}
              onDescription={setDescription}
              onModel={setModel}
              onName={setName}
              onSkills={setSkills}
              onVisibility={setVisibility}
              personal={personal}
              runtime={runtime}
              skills={skills}
              visibility={visibility}
            />
          ) : step === "runtime" ? (
            <RuntimeStep
              onChoose={(chosen) => {
                setRuntime(chosen);
                go("about");
              }}
            />
          ) : (
            <EndpointStep
              endpoint={endpoint}
              endpointError={tried ? endpointIssue : unreachable}
              harness={runtime?.kind === "managed" ? runtime.harness : null}
              onEndpoint={(value) => {
                setEndpoint(value);
                setTried(false);
                setUnreachable(undefined);
              }}
              onKey={(value) => {
                setKey(value);
                setUnreachable(undefined);
              }}
              secret={key}
            />
          )}
          {editing && kind === "address" && step === "about" ? (
            <div className="mt-8">
              <EndpointStep
                endpoint={endpoint}
                endpointError={tried ? endpointIssue : unreachable}
                harness={mastra ? "mastra" : null}
                onEndpoint={(value) => {
                  setEndpoint(value);
                  setTried(false);
                  setUnreachable(undefined);
                }}
                onKey={(value) => {
                  setKey(value);
                  setUnreachable(undefined);
                }}
                secret={key}
              />
              {editing.hasAuth ? (
                <p className="mt-2 text-muted-foreground text-xs">
                  A key is set. Leave the key empty to keep it.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {step === "about" && !editing ? (
          <div className="mt-auto pt-10">
            {kind === "openbot" ? (
              <CustomAgentCta disabled={busy} onConnect={() => go("runtime")} />
            ) : (
              <Button
                disabled={busy}
                onClick={() => setRuntime({ kind: "builtin" })}
                size="sm"
                type="button"
                variant="outline"
              >
                Run it in OpenBot instead
              </Button>
            )}
          </div>
        ) : null}

        {missing ? (
          <p className="mt-6 text-destructive text-sm" role="alert">
            {missing}
          </p>
        ) : failure ? (
          <p className="mt-6 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
      </div>

      <SheetFooter className="flex-row flex-wrap items-center justify-between border-t border-border">
        {step === "about" ? (
          <SheetClose
            render={<Button className="px-4" size="lg" variant="ghost" />}
          >
            Cancel
          </SheetClose>
        ) : (
          <Button
            className="px-4"
            disabled={busy}
            onClick={() => go(step === "endpoint" ? "about" : "about")}
            size="lg"
            type="button"
            variant="ghost"
          >
            Back
          </Button>
        )}
        {step !== "runtime" ? (
          <Button
            className="ml-auto px-4"
            disabled={busy}
            size="lg"
            type="submit"
          >
            {primary}
          </Button>
        ) : null}
      </SheetFooter>
    </form>
  );
}

/** The two ways an agent can be seen. Public is an admin's to give. */
const VISIBILITY_OPTIONS: Array<{
  value: BotAgentVisibility;
  title: string;
  description: string;
  icon: typeof IconLock;
}> = [
  {
    value: "private",
    title: "Private",
    description: "Only your Bots can use it.",
    icon: IconLock,
  },
  {
    value: "public",
    title: "Everyone",
    description: "Every Bot in your organization can use it.",
    icon: IconUsers,
  },
];

function AboutFields({
  name,
  description,
  visibility,
  model,
  skills,
  kind,
  runtime,
  catalogue,
  admin,
  personal,
  onName,
  onDescription,
  onVisibility,
  onModel,
  onSkills,
}: {
  name: string;
  description: string;
  visibility: BotAgentVisibility;
  model: string;
  skills: SkillDraft[];
  kind: "openbot" | "address";
  runtime: Runtime | null;
  /** The models it can run on, or null for an agent whose model is its own. */
  catalogue: Array<{ id: string; label: string }> | null;
  admin: boolean;
  personal: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onVisibility: (value: BotAgentVisibility) => void;
  onModel: (value: string) => void;
  onSkills: (value: SkillDraft[]) => void;
}) {
  const framework =
    runtime?.kind === "managed"
      ? WEB_HARNESSES.find((harness) => harness.id === runtime.harness)
      : undefined;
  return (
    <FieldGroup>
      <p className="text-muted-foreground text-sm">
        {kind === "openbot"
          ? "Runs in OpenBot, with the apps of whichever Bot hands it work."
          : framework && framework.id !== "byo-url"
            ? `An agent you run on ${framework.name}. OpenBot connects to it.`
            : "An agent you run. OpenBot connects to it."}
      </p>
      <Field>
        <FieldLabel htmlFor="agent-name">Name</FieldLabel>
        <Input
          autoComplete="off"
          autoFocus
          id="agent-name"
          maxLength={80}
          onChange={(event) => onName(event.target.value)}
          placeholder="Researcher"
          value={name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="agent-description">What it's good at</FieldLabel>
        <Textarea
          autoComplete="off"
          id="agent-description"
          maxLength={1000}
          onChange={(event) => onDescription(event.target.value)}
          placeholder="Deep research on the web and in your apps, with sources."
          rows={4}
          value={description}
        />
        <FieldDescription>
          Your Bots read this to decide what to send it.
        </FieldDescription>
      </Field>
      {catalogue ? (
        <Field>
          <FieldLabel>Model</FieldLabel>
          <Select
            onValueChange={(value) => onModel(String(value))}
            value={model}
          >
            <SelectTrigger aria-label="Model">
              <SelectValue>
                {model === DEFAULT_MODEL
                  ? "Organization default"
                  : (catalogue.find((option) => option.id === model)?.label ??
                    model)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={DEFAULT_MODEL}>
                  Organization default
                </SelectItem>
                {catalogue.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <FieldSet>
        <FieldLegend variant="label">
          Things it's good at
          <span className="ml-2 font-normal text-muted-foreground">
            Optional
          </span>
        </FieldLegend>
        <FieldDescription>
          Name each kind of work it handles. Your Bots read these too.
        </FieldDescription>
        <div className="grid gap-2">
          {skills.map((skill, index) => (
            <div
              className="flex items-start gap-2 rounded-lg bg-muted/50 p-3"
              key={skill.key}
            >
              <div className="grid min-w-0 flex-1 gap-2">
                <Input
                  aria-label={`Skill ${index + 1} name`}
                  maxLength={80}
                  onChange={(event) =>
                    onSkills(
                      skills.map((each) =>
                        each.key === skill.key
                          ? { ...each, name: event.target.value }
                          : each,
                      ),
                    )
                  }
                  placeholder="Forecast"
                  value={skill.name}
                />
                <Input
                  aria-label={`Skill ${index + 1} description`}
                  maxLength={500}
                  onChange={(event) =>
                    onSkills(
                      skills.map((each) =>
                        each.key === skill.key
                          ? { ...each, description: event.target.value }
                          : each,
                      ),
                    )
                  }
                  placeholder="Forecasts the quarter from the open deals."
                  value={skill.description}
                />
              </div>
              <Button
                aria-label={`Remove skill ${index + 1}`}
                onClick={() =>
                  onSkills(skills.filter((each) => each.key !== skill.key))
                }
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <IconX />
              </Button>
            </div>
          ))}
          {skills.length < 20 ? (
            <Button
              className="w-fit"
              onClick={() =>
                onSkills([
                  ...skills,
                  {
                    key: Math.max(-1, ...skills.map((each) => each.key)) + 1,
                    name: "",
                    description: "",
                  },
                ])
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <IconPlus />
              Add one
            </Button>
          ) : null}
        </div>
      </FieldSet>
      {personal ? null : (
        <FieldSet>
          <FieldLegend variant="label">Who can use it</FieldLegend>
          <div className="grid gap-2 sm:grid-cols-2">
            {VISIBILITY_OPTIONS.map((option) => {
              const Icon = option.icon;
              const locked = option.value === "public" && !admin;
              return (
                <button
                  aria-pressed={visibility === option.value}
                  className={OPTION_CLASSES}
                  disabled={locked}
                  key={option.value}
                  onClick={() => onVisibility(option.value)}
                  type="button"
                >
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-medium text-sm">
                      {option.title}
                    </span>
                    <span className="block text-pretty text-muted-foreground text-xs">
                      {locked
                        ? "Only an admin can share an agent with everyone."
                        : option.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </FieldSet>
      )}
    </FieldGroup>
  );
}
