import { summaryFor, WEB_HARNESSES } from "@openbot/shared/harnesses";
import {
  IconCheck,
  IconLock,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  agentInputFrom,
} from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import {
  agentCapabilitiesQueryOptions,
  testAgentConnection,
} from "@/lib/agents/queries";
import { isComposing } from "@/lib/composing";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * Where a new Bot is made: a wide sheet floating in from the right, so the roster it is being added
 * to stays in view behind it.
 *
 * No visible header and no corner ✕ — Cancel, Escape and a click outside all close it. It replaced
 * a centred wizard dialog that asked the same questions over four screens, one of them only to say
 * who could see the Bot.
 *
 * The title is still there for screen readers: a dialog with no name is announced as just "dialog".
 */
export function NewBotSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The new Bot's id, so the caller can take the person to it. */
  onCreated: (agentId: string) => void;
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
        <SheetTitle className="sr-only">New Bot</SheetTitle>
        {/* Inside the popup, so it unmounts on close and a reopened sheet starts empty. */}
        <NewBotFlow onCreated={onCreated} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The steps, in the order they are asked.
 *
 * WHERE IT RUNS COMES FIRST because it decides what the rest of the sheet means. For a Bot that runs
 * here, its instructions are the system prompt it runs on; for one somebody else runs, they are a
 * line added on top of a prompt written elsewhere. Asking for them before knowing which left the
 * field unable to say what it was for. The address is asked only of a Bot somebody else runs, and is
 * checked before the person spends time naming it. About it is always last, and always creates.
 */
const STEPS = ["runtime", "endpoint", "about"] as const;
type Step = (typeof STEPS)[number];

/**
 * Where the Bot runs: on this deployment, or behind a framework somebody hosts.
 *
 * Which framework is kept so Back returns to it still chosen, and so a Bot made without a title can
 * be given one. Every framework is reached the same way and stored the same way — an AG-UI address —
 * so the server never hears which was picked.
 */
type Runtime = { kind: "builtin" } | { kind: "managed"; harness: string };

/** What a created Bot is called beneath its name when the person gave it no title. */
function defaultTitle(runtime: Runtime): string {
  if (runtime.kind === "builtin") return "Assistant";
  if (runtime.harness === "byo-url") return "AG-UI agent";
  return (
    WEB_HARNESSES.find((harness) => harness.id === runtime.harness)?.name ??
    "AG-UI agent"
  );
}

/**
 * The role description sent when the person wrote no custom instructions.
 *
 * The server requires one, and for a Bot that runs here it is more than a description: it is the
 * system prompt the Bot runs on. So that one gets a sentence it can actually act on. A Bot somebody
 * else runs takes its instructions from wherever it runs, and gets a plain line saying where.
 */
function defaultInstructions(name: string, runtime: Runtime): string {
  if (runtime.kind === "builtin") {
    return `You are ${name}. Help the people you work with on whatever they bring you, clearly and briefly.`;
  }
  return `Connected from ${defaultTitle(runtime)}.`;
}

/**
 * The steps and everything answered in them, held above all three so going Back loses nothing.
 *
 * Every way forward — Continue, Create, or Enter in a field — is the form's submit. Create on the
 * last step makes the Bot. Back never validates; a half answer is fine to leave and come back to.
 *
 * The body is the one part of the sheet that scrolls, and it has to say so: a flex child with
 * `min-h-0` and no overflow of its own shrinks and paints over the footer instead.
 */
function NewBotFlow({ onCreated }: { onCreated: (agentId: string) => void }) {
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  /*
   * Assumed available while the answer loads, so the common deployment never sees the option flash
   * from disabled to enabled; the server refuses the create either way.
   */
  const { data: capabilities } = useQuery(agentCapabilitiesQueryOptions());
  const builtInAvailable = capabilities?.builtInAvailable ?? true;
  const [step, setStep] = useState<Step>("runtime");
  const [direction, setDirection] = useState(1);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  /** Private until said otherwise: a Bot shown to everybody by accident is the worse mistake. */
  const [visibility, setVisibility] = useState<Visibility>("private");
  /** Run it here unless the person picks otherwise: the answer that needs nothing set up. */
  const [runtime, setRuntime] = useState<Runtime | null>({ kind: "builtin" });
  const [endpoint, setEndpoint] = useState("");
  const [key, setKey] = useState("");
  /** Whether Continue was pressed on the address, which is when its error becomes worth showing. */
  const [tried, setTried] = useState(false);
  /** Continue on the address is dialling it, before anything is created. */
  const [checking, setChecking] = useState(false);
  /** Why the server could not reach the address on the last Continue, in its own words. */
  const [unreachable, setUnreachable] = useState<string>();
  /** The Bot just made, held for the moment the sheet spends saying so before it hands over. */
  const [createdId, setCreatedId] = useState<string>();
  const reduceMotion = useReducedMotion();

  // A deployment with no Bot of its own cannot run one here, so nothing is chosen for the person.
  useEffect(() => {
    if (!builtInAvailable) {
      setRuntime((current) => (current?.kind === "builtin" ? null : current));
    }
  }, [builtInAvailable]);

  /*
   * Read through a ref so the timer below is not restarted by a caller that passes a fresh arrow on
   * every render; the hand-over should happen once, a fixed beat after the Bot exists.
   */
  const onCreatedRef = useRef(onCreated);
  useEffect(() => {
    onCreatedRef.current = onCreated;
  });
  useEffect(() => {
    if (!createdId) return;
    const timer = window.setTimeout(
      () => onCreatedRef.current(createdId),
      reduceMotion ? CREATED_BEAT_REDUCED_MS : CREATED_BEAT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [createdId, reduceMotion]);

  const named = name.trim() !== "";
  const endpointIssue =
    endpoint.trim() === ""
      ? "Enter your agent's address."
      : agentFormSchema.shape.endpoint.safeParse(endpoint).error?.issues[0]
          ?.message;
  const busy = checking || createAgent.isPending;
  const canContinue =
    !busy &&
    (step === "about"
      ? named
      : step === "runtime"
        ? runtime !== null
        : endpointIssue === undefined || !tried);

  const go = (to: Step) => {
    setDirection(STEPS.indexOf(to) > STEPS.indexOf(step) ? 1 : -1);
    setTried(false);
    setUnreachable(undefined);
    createAgent.reset();
    setStep(to);
  };

  const create = async (chosen: Runtime) => {
    const managed = chosen.kind === "managed";
    const agent = await createAgent.mutateAsync(
      agentInputFrom({
        name: name.trim(),
        title: title.trim() || defaultTitle(chosen),
        roleDescription:
          instructions.trim() || defaultInstructions(name.trim(), chosen),
        visibility,
        // A Bot that runs here has no address; whatever was typed on the way past stays behind.
        endpoint: managed ? endpoint.trim() : "",
        authValue: managed ? key : "",
      }),
    );
    setCreatedId(agent.id);
  };

  const advance = () => {
    if (step === "runtime" && runtime) {
      return go(runtime.kind === "builtin" ? "about" : "endpoint");
    }
    if (step === "endpoint") return connect();
    if (step === "about" && runtime) return create(runtime);
  };

  /** Where Back goes: the address for a Bot somebody else runs, where it runs otherwise. */
  const previous = (): Step =>
    step === "about" && runtime?.kind === "managed" ? "endpoint" : "runtime";

  /**
   * Continue on the address: dial it from the server, and move on only if it answers.
   *
   * There is no separate Test button. A test that could be skipped let a Bot be made pointed at
   * nothing, and one that could not be skipped was a second button doing Continue's job. So Continue
   * tests: an agent that answers moves on, and one that does not says why under its address, where
   * the fix will be typed. Continue stays pressable after that, because the usual fix is starting the
   * agent, not editing what was typed.
   */
  const connect = async () => {
    const focusAddress = () =>
      // Focus would otherwise fall to the page while the button below is busy or disabled.
      document.getElementById("new-bot-endpoint")?.focus();
    if (endpointIssue) {
      setTried(true);
      focusAddress();
      return;
    }
    setUnreachable(undefined);
    setChecking(true);
    const verdict = await testAgentConnection(endpoint.trim(), key).finally(
      () => setChecking(false),
    );
    if (!verdict.ok) {
      setUnreachable(verdict.reason);
      focusAddress();
      return;
    }
    go("about");
  };

  if (createdId) {
    return (
      <MotionConfig reducedMotion="user">
        <CreatedView name={name.trim()} />
      </MotionConfig>
    );
  }

  const submit = () => {
    if (!canContinue) return;
    // The failure is shown from the mutation's own state; nothing more to do with it here.
    void Promise.resolve(advance()).catch(() => undefined);
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      /*
       * Enter in a text field means Continue, handled here rather than left to the browser's
       * implicit submit, because the browser does not ask whether the Enter was a real one. The
       * Enter that confirms a character an input method is composing — Japanese, Chinese, Korean —
       * finishes a character, not the step; WebKit sends it as a submit-worthy Enter regardless.
       * A textarea keeps Enter for its line breaks, and the option buttons keep it for pressing.
       */
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          !(event.target instanceof HTMLInputElement)
        ) {
          return;
        }
        event.preventDefault();
        if (!isComposing(event)) submit();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 pt-8 pb-6">
        <MotionConfig reducedMotion="user">
          {/* Shares its layout id with the orb on the created view, so it travels there. */}
          <motion.div className="w-fit" layoutId={ORB_LAYOUT_ID}>
            <AgentOrb
              size="40px"
              state={busy ? "thinking" : named ? "listening" : "idle"}
            />
          </motion.div>

          <motion.div
            animate={{ opacity: 1, x: 0 }}
            className="mt-6"
            initial={{ opacity: 0, x: 24 * direction }}
            key={step}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {step === "about" ? (
              <AboutStep
                instructions={instructions}
                name={name}
                runtime={runtime ?? { kind: "builtin" }}
                onInstructions={setInstructions}
                onName={setName}
                onTitle={setTitle}
                onVisibility={setVisibility}
                title={title}
                visibility={visibility}
              />
            ) : step === "runtime" ? (
              <RuntimeStep
                builtInAvailable={builtInAvailable}
                onChoose={setRuntime}
                runtime={runtime}
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
          </motion.div>
        </MotionConfig>

        {createAgent.error ? (
          <p className="mt-6 text-destructive text-sm" role="alert">
            {createAgent.error.message}
          </p>
        ) : null}
      </div>

      <SheetFooter className="flex-row justify-between border-t border-border">
        {step === "runtime" ? (
          <SheetClose
            render={<Button className="px-4" size="lg" variant="ghost" />}
          >
            Cancel
          </SheetClose>
        ) : (
          <Button
            className="px-4"
            disabled={busy}
            onClick={() => go(previous())}
            size="lg"
            type="button"
            variant="ghost"
          >
            Back
          </Button>
        )}
        <Button
          className="px-4"
          disabled={!canContinue}
          size="lg"
          type="submit"
        >
          {checking
            ? "Checking…"
            : createAgent.isPending
              ? "Creating…"
              : step === "about"
                ? "Create"
                : "Continue"}
        </Button>
      </SheetFooter>
    </form>
  );
}

/** How long the created view holds before handing over to the new Bot's page. */
const CREATED_BEAT_MS = 1600;
/** Shorter with reduced motion: nothing is moving, so the pause is only long enough to read. */
const CREATED_BEAT_REDUCED_MS = 900;
const ORB_LAYOUT_ID = "new-bot-orb";

/**
 * The beat between the Bot existing and the person arriving at it.
 *
 * Without it the sheet vanished mid-press and a different page appeared, which read as the form
 * being lost rather than finished. The orb that has sat in the corner of every step travels to the
 * middle, grows, settles into its finished state with a check beside it, and the Bot is named as
 * ready. Then the caller closes the sheet and takes the person there.
 *
 * It is a status, announced once, with nothing to press: closing the sheet now leaves the Bot made
 * and on the roster, which is the same place the hand-over would have led.
 */
function CreatedView({ name }: { name: string }) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 text-center"
      role="status"
    >
      <div className="relative">
        <motion.div
          layoutId={ORB_LAYOUT_ID}
          transition={{ type: "spring", bounce: 0.25, duration: 0.7 }}
        >
          <AgentOrb size="88px" state="done" />
        </motion.div>
        <motion.span
          animate={{ opacity: 1, scale: 1 }}
          className="absolute -right-0.5 -bottom-0.5 flex size-7 items-center justify-center rounded-full bg-emerald-500 text-white ring-3 ring-popover"
          initial={{ opacity: 0, scale: 0 }}
          transition={{
            delay: 0.45,
            type: "spring",
            bounce: 0.5,
            duration: 0.5,
          }}
        >
          <IconCheck aria-hidden className="size-4" stroke={3} />
        </motion.span>
      </div>
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        initial={{ opacity: 0, y: 8 }}
        transition={{ delay: 0.3, duration: 0.35, ease: "easeOut" }}
      >
        <h2 className="break-words font-semibold text-xl tracking-tight">
          {name} is ready
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">Taking you to it…</p>
      </motion.div>
    </div>
  );
}

type Visibility = AgentFormValues["visibility"];

/** The two ways a Bot can be seen, in the words the old wizard used for them. */
const VISIBILITY_OPTIONS: Array<{
  value: Visibility;
  title: string;
  description: string;
  icon: typeof IconLock;
}> = [
  {
    value: "private",
    title: "Private",
    description: "Only you can see it and talk to it.",
    icon: IconLock,
  },
  {
    value: "public",
    title: "Public",
    description: "Everyone in your OpenBot can find and use it.",
    icon: IconUsers,
  },
];

/**
 * The last step: what to call it, who can see it, and — only if the person wants to be more
 * specific — a line describing it and the instructions it follows.
 *
 * Title and instructions are optional and say so; who can see it always holds an answer, so a Bot
 * named and nothing else is a complete answer, and Create waits for nothing more.
 *
 * The instructions field says what it is for the Bot being made. For one that runs here it is the
 * prompt it runs on, so it is called Instructions and says how it behaves without them; for one
 * somebody else runs it is a line added to a prompt written elsewhere, so it is called Role. The
 * title's example is the framework's name, which is what it becomes when left blank.
 *
 * Who can see it was the old wizard's last step. It is here because this step had the room, and a
 * question that does not change what is being made is cheaper answered alongside the name than as a
 * screen of its own.
 */
function AboutStep({
  name,
  title,
  instructions,
  runtime,
  visibility,
  onName,
  onTitle,
  onInstructions,
  onVisibility,
}: {
  name: string;
  title: string;
  instructions: string;
  runtime: Runtime;
  visibility: Visibility;
  onName: (value: string) => void;
  onTitle: (value: string) => void;
  onInstructions: (value: string) => void;
  onVisibility: (value: Visibility) => void;
}) {
  const runsHere = runtime.kind === "builtin";
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="new-bot-name">Name</FieldLabel>
        <Input
          autoComplete="off"
          autoFocus
          id="new-bot-name"
          maxLength={80}
          onChange={(event) => onName(event.target.value)}
          placeholder="Expense Review"
          value={name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="new-bot-title">
          Title
          <span className="font-normal text-muted-foreground">Optional</span>
        </FieldLabel>
        <Input
          autoComplete="off"
          id="new-bot-title"
          maxLength={120}
          onChange={(event) => onTitle(event.target.value)}
          placeholder={runsHere ? "Finance Operations" : defaultTitle(runtime)}
          value={title}
        />
        <FieldDescription>A few words shown under its name.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="new-bot-instructions">
          {runsHere ? "Instructions" : "Role"}
          <span className="font-normal text-muted-foreground">Optional</span>
        </FieldLabel>
        <Textarea
          autoComplete="off"
          id="new-bot-instructions"
          maxLength={1000}
          onChange={(event) => onInstructions(event.target.value)}
          placeholder="Review receipts, categorize expenses, and prepare reimbursement reports."
          rows={5}
          value={instructions}
        />
        <FieldDescription>
          {runsHere
            ? "How it should work. Leave it blank and it helps with anything."
            : "Added to your agent's own instructions."}
        </FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Who can see it</FieldLegend>
        <div className="grid gap-2 sm:grid-cols-2">
          {VISIBILITY_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                aria-pressed={visibility === option.value}
                className={OPTION_CLASSES}
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
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </FieldSet>
    </FieldGroup>
  );
}

/**
 * Filled rather than outlined, so the list reads as a set of things to pick and not as a stack of
 * cards. The border is there but transparent until chosen, so choosing one never shifts the rows.
 */
const OPTION_CLASSES =
  "flex w-full items-center gap-3 rounded-lg border border-transparent bg-muted/50 p-3 text-left transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 aria-pressed:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * Where it runs, answered by recognition: the Bot this deployment runs itself first, then every
 * framework somebody might already have running.
 *
 * NAMES RATHER THAN TWO RADIOS. The person here arrives knowing the role they want and could not
 * tell "Built-in" from "Managed" — both are a kind of Bot, and neither word says which is theirs. A
 * list of frameworks by name and mark is answered by finding your own.
 *
 * EVERY FRAMEWORK LEADS TO THE SAME PLACE. Picking Google ADK rather than CrewAI changes nothing but
 * the default title: both ask for an AG-UI address next and are stored identically. The names are
 * there so somebody finds theirs and knows it will work, not because the choice branches.
 *
 * RUN IT HERE IS THE BIG CARD, ALREADY CHOSEN. It is the answer that needs nothing set up, and most
 * people making a Bot want exactly that, so the sheet opens with it chosen and Continue ready. The
 * frameworks sit below at their usual size for the person who arrived with an agent of their own.
 *
 * A press chooses rather than advances, because the sheet has a Continue and the choice should be
 * visible before it is confirmed.
 *
 * No inner scroller: the sheet's body already scrolls, and a second one inside it would give the
 * list two scrollbars at once.
 *
 * The heading takes focus on arrival, so a keyboard or screen reader lands on the question rather
 * than on the Continue it just pressed, which is still there.
 */
function RuntimeStep({
  builtInAvailable,
  runtime,
  onChoose,
}: {
  /** Whether this deployment has a Bot of its own to run one here on. */
  builtInAvailable: boolean;
  runtime: Runtime | null;
  onChoose: (runtime: Runtime) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <div className="flex flex-col gap-2">
      <h2
        className="mb-2 break-words font-semibold text-lg tracking-tight outline-none"
        ref={heading}
        tabIndex={-1}
      >
        Where will your Bot run?
      </h2>

      <button
        aria-pressed={runtime?.kind === "builtin"}
        className={cn(OPTION_CLASSES, "items-start gap-4 p-5")}
        disabled={!builtInAvailable}
        onClick={() => onChoose({ kind: "builtin" })}
        type="button"
      >
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-background shadow-xs">
          <IconSparkles className="size-6 text-foreground" />
        </span>
        <span className="min-w-0 pt-0.5">
          <span className="block font-semibold text-base">Run it here</span>
          <span className="mt-1 block text-pretty text-muted-foreground text-sm">
            {builtInAvailable
              ? "OpenBot runs it for you. Nothing to set up, and it can start right away."
              : "Not available yet. An admin has to turn this on first."}
          </span>
        </span>
      </button>

      <div className="flex items-center gap-2 py-1 text-muted-foreground text-xs">
        <span className="h-px flex-1 bg-border" />
        or connect one you run
        <span className="h-px flex-1 bg-border" />
      </div>

      {WEB_HARNESSES.map((harness) => (
        <button
          aria-pressed={
            runtime?.kind === "managed" && runtime.harness === harness.id
          }
          className={OPTION_CLASSES}
          key={harness.id}
          onClick={() => onChoose({ kind: "managed", harness: harness.id })}
          type="button"
        >
          <HarnessMark id={harness.mark} name={harness.name} />
          <span className="min-w-0">
            <span className="block font-medium text-sm">{harness.name}</span>
            <span className="block text-pretty text-muted-foreground text-xs">
              {summaryFor(harness)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The address of an agent somebody else runs, and the key it sits behind if it has one.
 *
 * The framework picked on the step before is named at the top so the person can see what they are
 * connecting, but nothing below differs by framework: every one of them is an AG-UI address and is
 * stored the same way.
 *
 * The address takes focus on arrival rather than the heading, as the name does on the last step: it
 * is the one thing this step asks for, and its label says what it is.
 *
 * Whether it answers is checked when Continue is pressed, by the server rather than the browser,
 * because the server is what will dial it on every run. An agent on this machine has to be reachable
 * from there, which is the one thing the browser cannot tell. Why it could not be reached arrives as
 * this field's error.
 */
function EndpointStep({
  harness,
  endpoint,
  secret,
  endpointError,
  onEndpoint,
  onKey,
}: {
  harness: string | null;
  endpoint: string;
  secret: string;
  endpointError?: string;
  onEndpoint: (value: string) => void;
  onKey: (value: string) => void;
}) {
  const chosen = WEB_HARNESSES.find((entry) => entry.id === harness);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {chosen ? (
          <span className="inline-flex w-fit items-center gap-2 rounded-lg bg-muted/50 py-1 pr-2.5 pl-1.5 text-sm">
            <HarnessMark id={chosen.mark} name={chosen.name} />
            {chosen.name}
          </span>
        ) : null}
        <h2 className="break-words font-semibold text-lg tracking-tight">
          Where can it be reached?
        </h2>
      </div>

      <FieldGroup>
        <Field data-invalid={endpointError ? true : undefined}>
          <FieldLabel htmlFor="new-bot-endpoint">Agent address</FieldLabel>
          <Input
            aria-invalid={endpointError ? true : undefined}
            autoComplete="off"
            autoFocus
            id="new-bot-endpoint"
            inputMode="url"
            onChange={(event) => onEndpoint(event.target.value)}
            placeholder="https://your-agent.example.com/ag-ui"
            value={endpoint}
          />
          {endpointError ? (
            <FieldError
              className="text-pretty"
              errors={[{ message: endpointError }]}
            />
          ) : (
            <FieldDescription>
              Any agent that speaks AG-UI works. OpenBot connects to it, so it
              has to be reachable from OpenBot's server.
            </FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="new-bot-key">
            Key
            <span className="font-normal text-muted-foreground">Optional</span>
          </FieldLabel>
          <Input
            autoComplete="off"
            id="new-bot-key"
            onChange={(event) => onKey(event.target.value)}
            placeholder="Bearer …"
            type="password"
            value={secret}
          />
          <FieldDescription>
            Sent as an <code>Authorization</code> header with every request, and
            stored encrypted.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </div>
  );
}
