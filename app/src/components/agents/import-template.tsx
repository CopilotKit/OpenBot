import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  type ConnectionVerdict,
  testAgentConnection,
} from "@/lib/agents/queries";
import { actionPolicyQueryOptions } from "@/lib/computers/queries";
import {
  emptyTemplateImportForm,
  type TemplateImportFormValues,
  templateInstallInputFrom,
} from "@/lib/templates/form";
import { installBotTemplateMutationOptions } from "@/lib/templates/mutations";
import {
  type BotTemplate,
  type BotTemplateBoundary,
  previewBotTemplate,
  type ResolvedSkill,
  type SlugResolution,
  type TemplatePlan,
  type TemplatePreviewVerdict,
  templateDraftSourceQueryOptions,
} from "@/lib/templates/queries";
import { queryClient } from "@/query-client";

/**
 * The consent screen: everything a stranger wrote, before any of it reaches a model.
 *
 * The section order is fixed and the first one is the whole point. A person cannot consent to text
 * they were not shown, so `role_description` and every skill's `instructions` are rendered
 * verbatim, unabridged and unformatted, ahead of the capabilities, the address and the button. The
 * ordering is the argument: what this Bot will be TOLD is a larger fact about it than what it may
 * reach, and a screen that led with a permissions list would be teaching people to skim the prose.
 *
 * NOTHING HERE DECIDES ANYTHING. The refusals are the parser's and are re-run at install; the plan
 * is the server's; the digest travels back so the server can refuse a file that moved between
 * being read and being agreed to. What this component owns is the order, the wording and the two
 * fields no template can carry.
 */

/**
 * A stranger's text, shown as the characters it is.
 *
 * Monospace and pre-wrapped, in a box that scrolls rather than one that truncates: an ellipsis in
 * the middle of an instruction is the one rendering a consent screen may not do, because the part
 * it hides is the part worth hiding something in. No markdown renderer touches it either — a
 * heading and a link are formatting a model never sees, and the reviewer needs to read what the
 * model reads. React's own text escaping is what makes `<script>` and `&lt;` appear as themselves
 * rather than disappearing into the document; the parser has already refused the characters that
 * would be invisible here whatever this box did.
 */
function Verbatim({ children }: { children: string }) {
  return (
    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  );
}

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {step}. {title}
      </h2>
      {children}
    </section>
  );
}

/** A claim the author typed. Never an anchor, and labelled as a claim wherever it appears. */
function Claim({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {/*
       * `source` and `example_url` arrive looking like addresses and are rendered as text on
       * purpose. They are attacker-controlled strings sitting a centimetre from a Bot's name while
       * somebody decides whether to trust it, and a link is a thing that can be clicked by
       * somebody who has not finished reading. `break-all` because a long one must wrap rather
       * than push the panel wide.
       */}
      <span className="break-all font-mono text-xs">{value}</span>
    </div>
  );
}

/** The author's ceiling, said in sentences rather than in the vocabulary's words. */
function boundarySentences(boundary: BotTemplateBoundary): string[] {
  const sentences: string[] = [];
  sentences.push(
    boundary.shell === "never"
      ? "It may not run shell commands."
      : "It may run shell commands.",
  );
  sentences.push(
    boundary.files === "none"
      ? "It may not read or write files."
      : boundary.files === "read_only"
        ? "It may read files, and may not change them."
        : "It may read and write files.",
  );
  sentences.push(
    boundary.browser === "none"
      ? "It may not use a browser."
      : boundary.browser === "read_only"
        ? "It may look at web pages, and may not click, type or submit on them."
        : "It may use a browser fully: clicking, typing and submitting.",
  );
  sentences.push(
    boundary.navigateHosts.length === 0
      ? "The author named no web address it may visit."
      : `On the web it is confined to ${boundary.navigateHosts.join(", ")}.`,
  );
  sentences.push(
    boundary.mcp === "none"
      ? "It may not call connector tools."
      : boundary.mcp === "read_only"
        ? "It may call connector tools that read, and not ones that write."
        : "It may call connector tools that read and write.",
  );
  return sentences;
}

/**
 * What this install will not do.
 *
 * A fixed list, because every line of it is a property of the import module's write set rather
 * than of this file: it creates a Bot, its skills and the one grant that pairs the two, and there
 * is no fourth call. If that ever stops being true, this list is the thing that is now wrong, and
 * it is written out in full here so that it is visibly wrong rather than quietly incomplete.
 */
const WILL_NOT_DO = [
  "Nothing above is granted. Every capability this template asks for is recorded as an ask and stays unanswered until somebody decides it.",
  "No connector, credential or key is added to this deployment.",
  "No component code is installed. A component name that names nothing here simply does not answer when the Bot reaches for it.",
  "No skill you already have is overwritten, renamed or changed.",
  "No deployment setting changes: not the boundary, not the connectors, not the channels, not the model.",
  "The coworker is private and yours. Nobody else sees it until you make it public.",
  "Nothing is fetched from the network to do any of this. The file in the box above is the whole of it.",
];

/** Whether the deployment is still on the shipped policy that permits every action. */
function permitsEverything(policy: {
  deny: string[];
  allow: string[];
}): boolean {
  return (
    policy.deny.length === 0 &&
    policy.allow.length === 1 &&
    policy.allow[0] === "true"
  );
}

export function ImportTemplate({ templateId }: { templateId?: string }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<TemplateImportFormValues>(
    emptyTemplateImportForm,
  );
  const [verdict, setVerdict] = useState<TemplatePreviewVerdict | null>(null);
  const [reading, setReading] = useState(false);
  const [connection, setConnection] = useState<ConnectionVerdict | null>(null);
  const [testing, setTesting] = useState(false);

  const install = useMutation(installBotTemplateMutationOptions(queryClient));

  /*
   * A draft of this deployment's own, opened as a file to import.
   *
   * The round trip an author needs before handing the file to anybody: pack a coworker, read what
   * actually travelled, and see the consent screen a stranger will see. `enabled` rather than a
   * conditional hook, because the panel stays mounted while the search parameter changes.
   */
  const seed = useQuery({
    ...templateDraftSourceQueryOptions(templateId ?? ""),
    enabled: Boolean(templateId),
  });

  useEffect(() => {
    if (!seed.data) return;
    setValues((current) =>
      current.source ? current : { ...current, source: seed.data },
    );
  }, [seed.data]);

  const read = async (source: string) => {
    setReading(true);
    try {
      const next = await previewBotTemplate(source);
      setVerdict(next);
      // The server's plan carries a default for every colliding slug. Adopting it is what makes the
      // radios show an answer rather than nothing, and the person changes the ones they disagree
      // with rather than answering a question per skill before they may continue.
      if (next.ok) {
        setValues((current) => ({
          ...current,
          slugDecisions: next.plan.slugDecisions,
        }));
      }
    } finally {
      setReading(false);
    }
  };

  if (!verdict?.ok) {
    return (
      <PasteStep
        error={verdict && !verdict.ok ? verdict.error : null}
        onRead={() => void read(values.source)}
        onSourceChange={(source) => {
          setVerdict(null);
          setValues((current) => ({ ...current, source }));
        }}
        reading={reading}
        seedError={
          templateId && seed.error ? "Could not open that draft." : null
        }
        source={values.source}
      />
    );
  }

  const { template, plan } = verdict;

  return (
    <ConsentScreen
      connection={connection}
      installError={install.error}
      installing={install.isPending}
      onBack={() => {
        setVerdict(null);
        setConnection(null);
      }}
      onInstall={async () => {
        const result = await install.mutateAsync(
          templateInstallInputFrom(values, plan, {
            from: templateId ? "gallery" : "paste",
            ...(templateId ? { sourceRef: templateId } : {}),
          }),
        );
        await navigate({ search: { agent: result.agentId }, to: "/agents" });
      }}
      onTest={async () => {
        setTesting(true);
        setConnection(null);
        try {
          setConnection(
            await testAgentConnection(values.endpoint, values.authValue),
          );
        } finally {
          setTesting(false);
        }
      }}
      onValues={setValues}
      plan={plan}
      template={template}
      testing={testing}
      values={values}
    />
  );
}

function PasteStep({
  source,
  onSourceChange,
  onRead,
  reading,
  error,
  seedError,
}: {
  source: string;
  onSourceChange: (source: string) => void;
  onRead: () => void;
  reading: boolean;
  error: string | null;
  seedError: string | null;
}) {
  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header>
        <h1 className="font-semibold text-2xl">Import a coworker</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Paste a template file. Nothing is written until you have read it and
          pressed the button at the end.
        </p>
      </header>

      <Textarea
        aria-label="Template file"
        className="max-h-[50vh] min-h-48 overflow-y-auto font-mono text-xs"
        onChange={(event) => onSourceChange(event.target.value)}
        placeholder={"openbot_template: 1\n\ntemplate:\n  slug: …"}
        spellCheck={false}
        value={source}
      />

      {seedError ? (
        <p className="text-destructive text-sm" role="alert">
          {seedError}
        </p>
      ) : null}

      {/*
       * The server's own sentence, not one composed here. A refusal names the thing that is wrong
       * with the file — an unknown key, an environment reference, a character nobody can see — and
       * the person who has to fix it is usually the person who wrote it.
       */}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        className="w-full text-sm!"
        disabled={!source.trim() || reading}
        onClick={onRead}
      >
        {reading ? "Reading…" : "Read this template"}
      </Button>
    </div>
  );
}

function ConsentScreen({
  template,
  plan,
  values,
  onValues,
  onTest,
  testing,
  connection,
  onInstall,
  installing,
  installError,
  onBack,
}: {
  template: BotTemplate;
  plan: TemplatePlan;
  values: TemplateImportFormValues;
  onValues: (
    update: (current: TemplateImportFormValues) => TemplateImportFormValues,
  ) => void;
  onTest: () => void;
  testing: boolean;
  connection: ConnectionVerdict | null;
  onInstall: () => void;
  installing: boolean;
  installError: Error | null;
  onBack: () => void;
}) {
  const policy = useQuery(actionPolicyQueryOptions());
  const { bot, template: meta } = template;

  const endpointNeeded = plan.endpoint.required;
  const typedHost = hostOf(values.endpoint);
  const claimedHost = plan.endpoint.sendsConversationTo;
  const hostDiffers = Boolean(
    typedHost && claimedHost && typedHost !== claimedHost,
  );

  const asks =
    plan.connectors.reduce(
      (total, connector) => total + connector.tools.length,
      0,
    ) +
    plan.connectors.filter((connector) => connector.tools.length === 0).length +
    plan.components.length;

  return (
    <div className="flex w-full flex-col gap-7 p-8">
      <header className="grid gap-2">
        <Button
          className="justify-self-start px-0 text-muted-foreground text-xs!"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          Read a different file
        </Button>
        <h1 className="font-semibold text-2xl">Import this coworker?</h1>
      </header>

      {/* 1 ─────────────────────────────────────────────────────────────── */}
      <Section step={1} title="What this Bot is">
        <div className="flex items-center gap-3">
          <AbstractAvatar
            name={bot.name}
            seed={bot.avatarSeed ?? meta.slug}
            size={48}
          />
          <div className="min-w-0">
            <p className="truncate font-medium text-base">{bot.name}</p>
            <p className="truncate text-muted-foreground text-sm">
              {bot.title}
            </p>
          </div>
        </div>

        <p className="text-sm">{meta.summary}</p>

        <div className="grid gap-0.5 rounded-lg border border-border bg-card p-3">
          <Claim label="Template" value={meta.slug} />
          {meta.version ? <Claim label="Version" value={meta.version} /> : null}
          {/*
           * "claims to be" rather than "by". Nothing verifies an author and nothing ever will
           * without identity infrastructure, so the word on the screen has to be the weaker one.
           */}
          {meta.author ? (
            <Claim label="Claims to be by" value={meta.author} />
          ) : null}
          {meta.source ? (
            <Claim label="Claims to come from" value={meta.source} />
          ) : null}
          {meta.license ? (
            <Claim label="License claim" value={meta.license} />
          ) : null}
        </div>

        <p className="font-medium text-sm">
          This text is given to a model as instructions. It was written by a
          stranger.
        </p>
        <Verbatim>{bot.roleDescription}</Verbatim>

        {template.notes ? (
          <>
            <p className="text-muted-foreground text-xs">
              A note the author left for you. This one is not given to a model.
            </p>
            <Verbatim>{template.notes}</Verbatim>
          </>
        ) : null}
      </Section>

      {/* 2 ─────────────────────────────────────────────────────────────── */}
      <Section step={2} title="Its skills">
        {template.skills.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This template defines no skills.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              A skill is more instructions, chosen for a turn and given to the
              model the same way the text above is. Every word of each one is
              below.
            </p>
            <div className="grid gap-4">
              {template.skills.map((skill) => {
                const resolved = plan.skills.find(
                  (candidate) => candidate.slug === skill.slug,
                );
                return (
                  <div
                    className="grid gap-2 rounded-lg border border-border bg-card p-3"
                    key={skill.slug}
                  >
                    <div className="grid gap-0.5">
                      <p className="font-medium text-sm">{skill.title}</p>
                      <p className="font-mono text-muted-foreground text-xs">
                        /{skill.slug}
                      </p>
                    </div>
                    <p className="text-sm">{skill.summary}</p>
                    <Verbatim>{skill.instructions}</Verbatim>
                    {skill.tools.length > 0 ? (
                      <p className="text-muted-foreground text-xs">
                        It names {skill.tools.join(", ")}. Naming a tool is not
                        being given it.
                      </p>
                    ) : null}
                    {resolved?.collides ? (
                      <SlugDecision
                        onChange={(resolution) =>
                          onValues((current) => ({
                            ...current,
                            slugDecisions: {
                              ...current.slugDecisions,
                              [skill.slug]: resolution,
                            },
                          }))
                        }
                        resolved={resolved}
                        value={
                          values.slugDecisions[skill.slug] ??
                          resolved.resolution
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Section>

      {/* 3 ─────────────────────────────────────────────────────────────── */}
      <Section step={3} title="Where it runs">
        {!endpointNeeded ? (
          <p className="text-sm">
            On this deployment's own Bot. Nothing leaves your network.
          </p>
        ) : (
          <>
            {plan.endpoint.reason === "no_managed_agent" ? (
              <p className="text-muted-foreground text-sm">
                The template says this coworker runs in the box, and this
                deployment does not run one. It needs an address of its own.
              </p>
            ) : null}

            {/*
             * The origin, large, and it is the address that will actually be dialled the moment
             * there is one — the author's claim only stands in until somebody types over it.
             * Showing the claim after an address has been typed would put the wrong host in the
             * largest type on the screen.
             */}
            <p className="break-all font-mono font-semibold text-lg">
              {typedHost ?? claimedHost ?? "No address yet"}
            </p>

            <p className="text-sm">
              Every message anyone sends this coworker is sent to this address,
              together with any skill instructions in force.
            </p>

            {plan.endpoint.exampleUrl ? (
              <Claim
                label="The author suggests"
                value={plan.endpoint.exampleUrl}
              />
            ) : null}

            <div className="flex gap-2">
              <Input
                aria-label="Address this coworker runs at"
                onChange={(event) =>
                  onValues((current) => ({
                    ...current,
                    endpoint: event.target.value,
                  }))
                }
                placeholder="https://your-agent.example.com/ag-ui"
                value={values.endpoint}
              />
              <Button
                disabled={!values.endpoint.trim() || testing}
                onClick={onTest}
                type="button"
                variant="outline"
              >
                {testing ? "Testing…" : "Test"}
              </Button>
            </div>

            {/*
             * The claim and the address are compared and the difference is said out loud. It is not
             * a refusal: a person legitimately points a template at their own copy of a service,
             * which is exactly the case that looks identical to being pointed somewhere else.
             */}
            {hostDiffers ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                The template says conversations go to{" "}
                <span className="font-mono">{claimedHost}</span>. You have typed{" "}
                <span className="font-mono">{typedHost}</span>. Only the address
                you type is used.
              </p>
            ) : null}

            {connection ? (
              <p
                className={
                  connection.ok
                    ? "text-muted-foreground text-sm"
                    : "text-destructive text-sm"
                }
                role="status"
              >
                {connection.ok
                  ? `It answered: ${connection.events.join(", ")}`
                  : connection.reason}
              </p>
            ) : null}

            {plan.endpoint.requiresKey ? (
              <div className="grid gap-1.5">
                <Input
                  aria-label="Key for this address"
                  autoComplete="off"
                  onChange={(event) =>
                    onValues((current) => ({
                      ...current,
                      authValue: event.target.value,
                    }))
                  }
                  placeholder="Key"
                  type="password"
                  value={values.authValue}
                />
                <p className="text-muted-foreground text-xs">
                  The template said this address needs a key and carried the
                  header name{" "}
                  <span className="font-mono">
                    {plan.endpoint.authHeader ?? "Authorization"}
                  </span>
                  . It carried no key: a template cannot hold one. Yours is
                  stored in this deployment's vault and is never read back.
                </p>
              </div>
            ) : null}
          </>
        )}
      </Section>

      {/* 4 ─────────────────────────────────────────────────────────────── */}
      <Section step={4} title="What it is asking for">
        {asks === 0 ? (
          <p className="text-muted-foreground text-sm">
            It asks for nothing beyond its own instructions.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Reasons the author wrote. Granting any of these is a separate act
              on a separate screen, by somebody who may.
            </p>
            <div className="grid gap-2">
              {plan.connectors.map((connector) => (
                <div
                  className="grid gap-1.5 rounded-lg border border-border bg-card p-3"
                  key={connector.id}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-sm">{connector.id}</p>
                    <span className="text-muted-foreground text-xs">
                      {connector.verdict === "available"
                        ? "Connected here"
                        : "Not connected here"}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{connector.why}</p>
                  {connector.verdict === "unavailable" ? (
                    <p className="text-muted-foreground text-xs">
                      {connector.id} is not connected on this deployment.
                      Nothing will be granted and nothing will be written.
                    </p>
                  ) : null}
                  {connector.tools.map((tool) => (
                    <div
                      className="border-border border-t pt-1.5 first-of-type:border-t-0"
                      key={tool.ref}
                    >
                      <p className="font-mono text-xs">{tool.ref}</p>
                      <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                        {tool.why}
                      </p>
                    </div>
                  ))}
                  <p className="font-medium text-amber-600 text-xs dark:text-amber-500">
                    Not granted by this install.
                  </p>
                </div>
              ))}

              {plan.components.map((component) => (
                <div
                  className="grid gap-1.5 rounded-lg border border-border bg-card p-3"
                  key={component.name}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-mono text-sm">{component.name}</p>
                    <span className="text-muted-foreground text-xs">
                      {component.verdict === "available"
                        ? "In this build"
                        : "Not in this build"}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{component.why}</p>
                  {component.verdict === "not_in_build" ? (
                    <p className="text-muted-foreground text-xs">
                      There is no component called {component.name} here. The
                      Bot reaching for it is told so, and nothing is written.
                    </p>
                  ) : null}
                  <p className="font-medium text-amber-600 text-xs dark:text-amber-500">
                    Not granted by this install.
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      {/* 5 ─────────────────────────────────────────────────────────────── */}
      <Section step={5} title="What it will be allowed to do">
        <p className="text-muted-foreground text-sm">
          The ceiling the author wrote into the file.
        </p>
        <ul className="grid gap-1">
          {boundarySentences(template.boundary).map((sentence) => (
            <li className="text-sm" key={sentence}>
              {sentence}
            </li>
          ))}
        </ul>

        {/*
         * The honest sentence, and it stays until the compiler that enforces this ceiling ships.
         * The vocabulary above is the author's statement of what the coworker needs; nothing on
         * this deployment yet turns it into a rule, so a screen that showed it without saying so
         * would be describing a cage that is not there.
         */}
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          This deployment does not yet enforce that ceiling. Until it does, an
          imported Bot has exactly the computer reach of any other Bot here.
        </p>

        {policy.isPending ? null : policy.error ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <span className="font-medium">
              What this deployment allows cannot be read from here.
            </span>{" "}
            Only an administrator can see the boundary. Whatever it says applies
            to an imported Bot exactly as it applies to a Bot you built
            yourself.
          </p>
        ) : policy.data && permitsEverything(policy.data) ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <span className="font-medium">
              This deployment currently allows every action.
            </span>{" "}
            An imported Bot can browse, read and write files, and run shell
            commands — exactly like a Bot you built yourself.{" "}
            <Link
              className="underline underline-offset-2"
              to="/admin/boundaries"
            >
              Set a boundary
            </Link>
            .
          </p>
        ) : (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
            This deployment has a boundary of its own, and it applies to this
            coworker exactly as it applies to every other one.
          </p>
        )}
      </Section>

      {/* 6 ─────────────────────────────────────────────────────────────── */}
      <Section step={6} title="What this install will not do">
        <ul className="grid gap-1.5">
          {WILL_NOT_DO.map((line) => (
            <li className="text-muted-foreground text-sm" key={line}>
              {line}
            </li>
          ))}
        </ul>
      </Section>

      {/* 7 ─────────────────────────────────────────────────────────────── */}
      {installError ? (
        <p className="text-destructive text-sm" role="alert">
          {installError.message}
        </p>
      ) : null}

      <Button
        className="w-full text-sm!"
        disabled={
          installing || (endpointNeeded && values.endpoint.trim().length === 0)
        }
        onClick={onInstall}
      >
        {installing ? "Importing…" : `Import ${bot.name}`}
      </Button>

      {endpointNeeded && values.endpoint.trim().length === 0 ? (
        <p className="-mt-4 text-muted-foreground text-xs">
          An address is needed before this coworker can be imported.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What happens to a skill slug this deployment already has.
 *
 * Three answers, and overwrite is not among them: `installSkill` upserts on `skills.slug`, so an
 * import that took a taken name would silently replace somebody's `/` command with a stranger's
 * instructions. Reuse is offered only when what is already here is byte-identical, which is the
 * only case where keeping it and installing it are the same outcome.
 */
function SlugDecision({
  resolved,
  value,
  onChange,
}: {
  resolved: ResolvedSkill;
  value: SlugResolution;
  onChange: (resolution: SlugResolution) => void;
}) {
  /*
   * A real `for`/`id` pair rather than a wrapping label. Base UI's Radio draws a span and puts a
   * hidden input beside it, and the `id` given here is the one that input takes — so this is what
   * makes clicking the sentence select the answer, and what a screen reader reads out.
   */
  const group = useId();
  const options: { value: SlugResolution; label: string }[] = [
    ...(resolved.identical
      ? [
          {
            value: "reuse" as const,
            label: "Use the one already here — it is word for word the same.",
          },
        ]
      : []),
    ...(resolved.suffixCandidate
      ? [
          {
            value: "suffix" as const,
            label: `Install it as /${resolved.suffixCandidate}, beside the one already here.`,
          },
        ]
      : []),
    { value: "skip" as const, label: "Do not install this skill at all." },
  ];

  return (
    <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
      <p className="text-sm">
        <span className="font-medium">
          There is already a skill called /{resolved.slug} here.
        </span>{" "}
        {resolved.identical
          ? "It is identical to this one."
          : "It is a different skill with the same name, and it is not touched."}
      </p>
      <RadioGroup
        onValueChange={(next: unknown) => onChange(next as SlugResolution)}
        value={value}
      >
        {options.map((option) => (
          <div className="flex items-start gap-2" key={option.value}>
            <Radio
              className="mt-0.5"
              id={`${group}-${option.value}`}
              value={option.value}
            />
            <label
              className="text-sm leading-snug"
              htmlFor={`${group}-${option.value}`}
            >
              {option.label}
            </label>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}

/** The host of a typed address, or nothing. A half-typed URL is not an error worth reporting. */
function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint.trim()).host;
  } catch {
    return null;
  }
}
