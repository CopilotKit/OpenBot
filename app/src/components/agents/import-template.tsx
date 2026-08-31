import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  Claim,
  STRANGER_WROTE_IT,
  Verbatim,
} from "@/components/agents/template-prose";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  type ConnectionVerdict,
  testAgentConnection,
} from "@/lib/agents/queries";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
} from "@/lib/computers/queries";
import { describeBoundary } from "@/lib/templates/boundary";
import {
  emptyTemplateImportForm,
  type TemplateImportFormValues,
  templateImportFormSchema,
  templateInstallInputFrom,
} from "@/lib/templates/form";
import { installBotTemplateMutationOptions } from "@/lib/templates/mutations";
import {
  type BotTemplate,
  galleryTemplateQueryOptions,
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
  "No deployment setting changes: not the boundary every Bot is judged by, not the connectors, not the channels, not the model. The ceiling above is written per coworker, in a place a deployment-wide save cannot reach.",
  "The coworker is private and yours. Nobody else sees it until you make it public.",
  "Nothing is fetched from the network to do any of this. The file in the box above is the whole of it.",
];

/**
 * Whether nothing this deployment's boundary says actually stops a Bot.
 *
 * `mode` is half of that answer and was once left out of it. A dry-run boundary decides and then
 * forwards anyway — `server/src/computer/policy.ts` returns `forward: true` on a deny match and on
 * the default refusal alike — so an administrator who added deny rules and chose "Record it and
 * allow it" was shown the calm sentence saying a boundary applies, on a deployment where no rule
 * stops anything at all. The rules do exist; that is simply not the fact somebody deciding whether
 * to run a stranger's Bot needs to be told.
 */
function permitsEverything(policy: ActionPolicy): boolean {
  if (policy.mode === "dry-run") return true;
  return (
    policy.deny.length === 0 &&
    policy.allow.length === 1 &&
    policy.allow[0] === "true"
  );
}

export function ImportTemplate({
  templateId,
  gallerySlug,
}: {
  templateId?: string;
  /**
   * A template from this deployment's gallery, opened as the file it is.
   *
   * A SLUG rather than a document, and the difference is the whole reason this prop exists rather
   * than a `source` string. What installs is re-read from the catalogue on the server, so the YAML
   * seeded here is what a person READS and the digest is what pins it — a browser that could hand
   * over the document would be able to write "gallery" into the provenance of a file that never was
   * in one.
   */
  gallerySlug?: string;
}) {
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

  /*
   * A gallery template, on the same terms: opened as a file, read like any other.
   *
   * The YAML the server serialised out of the document it parsed, so what somebody reads before
   * agreeing is a file they could have been sent by hand rather than a form this screen assembled.
   * It goes through the same preview and the same consent screen as a paste, because a template
   * shipped in the image deserves exactly as much reading as one a stranger emailed.
   */
  const galleryEntry = useQuery({
    ...galleryTemplateQueryOptions(gallerySlug ?? ""),
    enabled: Boolean(gallerySlug),
  });

  const seeded = seed.data ?? galleryEntry.data?.yaml;
  useEffect(() => {
    if (!seeded) return;
    setValues((current) =>
      current.source ? current : { ...current, source: seeded },
    );
  }, [seeded]);

  const read = useCallback(async (source: string) => {
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
    // Stable, so the effect below can depend on it without re-reading on every render. The state
    // setters are the only closure and React guarantees those never change identity.
  }, []);

  /**
   * The file this screen was opened ON, already read.
   *
   * "Use this template" used to land here, on a paste box, showing a file nobody pasted, above a
   * button repeating the words the person had just pressed on the card. Three presses to reach a
   * decision and the middle one bought nothing — and the box was worse than redundant, because an
   * install from the gallery posts the SLUG and the server re-reads its own copy: anybody who
   * edited a character got a 409 saying the template had changed since they read it, blaming the
   * file for their own edit.
   *
   * A ref rather than `verdict` in the dependencies, and that is the whole subtlety. `verdict` is
   * cleared by "Read a different file", so a dependency on it would re-read this same document
   * immediately and bounce the person back to the consent screen — silently discarding the address
   * and key they had typed. Keyed on the document instead, so it reads once per file and a genuinely
   * different one still reads.
   */
  const alreadyRead = useRef<string | null>(null);
  useEffect(() => {
    if (!gallerySlug || !seeded || reading) return;
    if (alreadyRead.current === seeded) return;
    alreadyRead.current = seeded;
    void read(seeded);
  }, [gallerySlug, seeded, reading, read]);

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
          templateId && seed.error
            ? "Could not open that draft."
            : gallerySlug && galleryEntry.error
              ? "Could not open that template."
              : null
        }
        readOnly={Boolean(gallerySlug)}
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
        /*
         * Reading a different file forgets everything the importer typed for the last one. Only
         * `verdict` and `connection` used to be cleared, so a key typed for template A survived
         * into template B and was sent to B's host and then stored in this deployment's vault
         * attached to B's Bot. It is worse on a deployment that runs a managed Bot, where B's
         * consent screen renders neither an address box nor a key box: the screen promised a local
         * coworker while the install pointed one at A's host with A's credential. The file itself
         * stays, because it is what the paste box is showing.
         */
        setVerdict(null);
        setConnection(null);
        setValues((current) => ({
          ...emptyTemplateImportForm,
          source: current.source,
        }));
      }}
      onInstall={async () => {
        /*
         * WHERE THIS FILE CAME FROM, as the provenance row will record it.
         *
         * `gallery` is now a server-side re-read rather than a label: the install route ignores the
         * document in the body and takes the one the catalogue holds under this slug. A draft of
         * this deployment's own is therefore `file` — it used to be sent as `gallery` with the draft
         * id as its ref, which under the new rule would look up a gallery slug that does not exist
         * and answer 404.
         */
        const result = await install.mutateAsync(
          templateInstallInputFrom(values, plan, {
            from: gallerySlug ? "gallery" : templateId ? "file" : "paste",
            ...(gallerySlug
              ? { sourceRef: gallerySlug }
              : templateId
                ? { sourceRef: templateId }
                : {}),
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
  readOnly,
}: {
  source: string;
  onSourceChange: (source: string) => void;
  onRead: () => void;
  reading: boolean;
  error: string | null;
  seedError: string | null;
  readOnly: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header>
        <h1 className="font-semibold text-2xl">Import a coworker</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {readOnly
            ? "This is the file this deployment holds under that name. Nothing is written until you have read it and pressed the button at the end."
            : "Paste a template file. Nothing is written until you have read it and pressed the button at the end."}
        </p>
      </header>

      {/*
       * READ-ONLY when the file came from the catalogue, because an edit here cannot install. The
       * install posts the slug and the server reads its own copy, so a changed character produces a
       * 409 about the template having changed rather than anything about what was typed.
       */}
      <Textarea
        aria-label="Template file"
        className="max-h-[50vh] min-h-48 overflow-y-auto font-mono text-xs"
        onChange={(event) => onSourceChange(event.target.value)}
        placeholder={"openbot_template: 1\n\ntemplate:\n  slug: …"}
        readOnly={readOnly}
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

  /*
   * One field decides the box and the button alike, so the two can never disagree on screen.
   *
   * `plan.endpoint.required` is the same fact arriving under another name, and it stays the lock on
   * what `templateInstallInputFrom` may send. Reading it here as well would be two answers to one
   * question, which is how this screen came to demand an address for a coworker it had just said
   * runs on this deployment.
   */
  const endpointNeeded = plan.runsOn === "address";
  const typed = values.endpoint.trim();
  const shapeProblem = endpointProblem(values.endpoint);
  const typedAddress = shapeProblem ? null : addressOf(values.endpoint);
  const typedHost = typedAddress ? typedAddress.host : null;
  const claimedHost = plan.endpoint.sendsConversationTo;
  /*
   * `hostname` rather than `host`. A claim can never carry a port — the format refuses a
   * `sends_conversation_to` that is not a bare hostname — so comparing against `host` fired the
   * amber mismatch warning on `https://renewals.example.com:8443/ag-ui`, about the very host the
   * template had named. A disclosure that cries wolf on the correct address teaches people to click
   * past the one case it exists for.
   */
  const hostDiffers = Boolean(
    typedAddress && claimedHost && typedAddress.hostname !== claimedHost,
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
          {/*
           * Wrapping rather than truncating, for the same reason the Verbatim box below exists.
           * `standingRoleMessage` builds a Bot's system message as `You are ${name}, ${title}.`, so
           * both of these are stranger-written text handed to a model on every turn in every
           * channel. They used to carry `truncate`, which in this panel showed roughly sixty
           * characters of a title capped at a hundred and twenty: an author could put a sentence of
           * instruction past the ellipsis and the person consenting would never see it, on the one
           * screen that exists to show them all of it. Nothing model-visible is clipped here.
           */}
          <div className="min-w-0">
            <p className="break-words font-medium text-base">{bot.name}</p>
            <p className="break-words text-muted-foreground text-sm">
              {bot.title}
            </p>
          </div>
        </div>

        <p className="break-words text-sm">{meta.summary}</p>

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

        {/* The same sentence the template's own page uses, from one place, so neither can soften it. */}
        <p className="font-medium text-sm">{STRANGER_WROTE_IT}</p>
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
                    {/*
                     * `break-words` on both, matching Claim and Verbatim. A title and a summary are
                     * read by the model when it picks a skill for a turn, and a stranger can write
                     * either as one unbroken run with no space in it — which, left with the default
                     * `overflow-wrap: normal`, has no break opportunity and lays itself outside a
                     * fixed-width panel where the reviewer never sees it.
                     */}
                    <div className="grid gap-0.5">
                      <p className="break-words font-medium text-sm">
                        {skill.title}
                      </p>
                      <p className="font-mono text-muted-foreground text-xs">
                        /{skill.slug}
                      </p>
                    </div>
                    <p className="break-words text-sm">{skill.summary}</p>
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
        {plan.runsOn === "in_process" ? (
          /*
           * The case that used to demand an address, so it is said at length rather than in four
           * words. Somebody arriving here was previously told to go and register an endpoint for a
           * coworker the file said runs here; the sentence that replaced that has to be specific
           * enough that they can tell the difference at a glance.
           */
          <>
            <p className="text-sm">
              It runs on this deployment itself, on the model this deployment is
              configured with. There is no address to supply and no other host
              is dialled: nothing leaves your network.
            </p>
            <p className="text-muted-foreground text-sm">
              Nothing had to be arranged for it: the text above under
              &ldquo;What this Bot is&rdquo; becomes its standing instructions,
              and its skills are given to it the same way they are to a coworker
              you built yourself.
            </p>
          </>
        ) : plan.runsOn === "managed_agent" ? (
          <p className="text-sm">
            It runs on the Bot this deployment already runs. Nothing leaves your
            network.
          </p>
        ) : (
          <>
            {/*
             * The origin, large, and it is the address that will actually be dialled the moment
             * there is one — the author's claim only stands in while the box is empty. Showing the
             * claim after an address has been typed would put the wrong host in the largest type on
             * the screen, and that is exactly what happened for every schemeless address: `hostOf`
             * could not parse `renewals-mycopy.example.com/agui`, so the author's `renewals.example
             * .com` was painted under the sentence saying conversations go there, and `hostDiffers`
             * had nothing to compare and stayed quiet. The claim now yields to anything typed.
             */}
            <p className="break-all font-mono font-semibold text-lg">
              {typedHost ??
                (typed
                  ? "Not a web address"
                  : (claimedHost ?? "No address yet"))}
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
                disabled={!typed || testing || Boolean(shapeProblem)}
                onClick={onTest}
                type="button"
                variant="outline"
              >
                {testing ? "Testing…" : "Test"}
              </Button>
            </div>

            {shapeProblem ? (
              <p className="text-destructive text-sm" role="alert">
                {shapeProblem}
              </p>
            ) : null}

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
                  <p className="font-medium text-amber-700 text-xs dark:text-amber-500">
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
                  <p className="font-medium text-amber-700 text-xs dark:text-amber-500">
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
          {describeBoundary(template.boundary).map((sentence) => (
            <li className="text-sm" key={sentence}>
              {sentence}
            </li>
          ))}
        </ul>

        {/*
         * This block used to say the opposite, and the change is the whole of phase 4.
         *
         * It read "This deployment does not yet enforce that ceiling. Until it does, an imported
         * Bot has exactly the computer reach of any other Bot here." — honest while the vocabulary
         * above was only the author's statement of what the coworker needs. It stopped being
         * honest the moment the compiler shipped, and a stale reassurance on a consent screen is
         * worse than none: somebody reads that the ceiling is decorative, declines to look further,
         * and never learns what was actually applied to their coworker.
         *
         * What is true now is deliberately specific about WHO enforces it. The clauses are this
         * deployment's, compiled here from a closed vocabulary — a template never writes CEL — and
         * judged by the same engine as the administrator's own rules. Naming the engine is what
         * makes the next block below meaningful rather than contradictory: a ceiling evaluated by
         * an engine that refuses nothing still refuses nothing.
         */}
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          This ceiling is applied to this coworker when you import it, and to no
          other. It is enforced by this deployment&rsquo;s own policy engine,
          from rules this deployment compiles — the file never carries a rule of
          its own. Retracting the import takes them away again.
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
          /*
           * Still worth saying now that the ceiling is real, because a ceiling only ever
           * SUBTRACTS. Nothing above grants anything, so wherever the author left a key at its
           * permissive end this coworker inherits whatever the deployment permits — which here is
           * everything.
           *
           * The dry-run half needed rewriting rather than keeping. `mode` governs the whole
           * evaluation and the compiled clauses are composed into the same deny list, so a
           * deployment set to "Record it and allow it" does not enforce the ceiling either:
           * `policy.ts` returns `forward: true` on a deny match in that mode. Saying "this ceiling
           * is enforced" a paragraph above and leaving that unsaid here would be the same
           * comfortable half-truth this section was just rewritten to remove.
           */
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <span className="font-medium">
              This deployment currently allows every action.
            </span>{" "}
            {policy.data.mode === "dry-run" ? (
              <>
                Its boundary is set to record what it would have refused rather
                than refuse it, and that setting decides the ceiling above too —
                nothing in it stops anything until this deployment is switched
                to stopping actions.{" "}
              </>
            ) : (
              <>
                Nothing narrows this coworker except the ceiling above. Wherever
                that ceiling permits something, it can browse, read and write
                files, and run shell commands exactly like a Bot you built
                yourself.{" "}
              </>
            )}
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
            This deployment has a boundary of its own. It applies to this
            coworker exactly as it applies to every other one, on top of the
            ceiling above.
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
          installing ||
          (endpointNeeded && (typed.length === 0 || Boolean(shapeProblem)))
        }
        onClick={onInstall}
      >
        {installing ? "Importing…" : `Import ${bot.name}`}
      </Button>

      {endpointNeeded && typed.length === 0 ? (
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

/** A typed address, parsed, or nothing. A half-typed URL is not an error worth reporting. */
function addressOf(endpoint: string): URL | null {
  try {
    return new URL(endpoint.trim());
  } catch {
    return null;
  }
}

/**
 * What is wrong with the shape of a typed address, in the schema's own words.
 *
 * `templateImportFormSchema` was written for this field and then wired to nothing: the screen kept
 * its own `useState` and validated none of it. So the very common schemeless form
 * `renewals.example.com/agui` sailed through, failed to parse as a URL, and left the screen falling
 * back to the author's claimed host in its largest type. An empty box is not a problem — it is a
 * box nobody has typed in yet, and the sentence under the button already says an address is needed.
 */
function endpointProblem(endpoint: string): string | null {
  const parsed = templateImportFormSchema.shape.endpoint.safeParse(endpoint);
  if (parsed.success) return null;
  return (
    parsed.error.issues[0]?.message ??
    "Enter a web address starting with http:// or https://."
  );
}
