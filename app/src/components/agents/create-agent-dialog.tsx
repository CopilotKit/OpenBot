import { summaryFor, WEB_HARNESSES } from "@openbot/shared/harnesses";
import { IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useState } from "react";
import useMeasure from "react-use-measure";
import { HarnessMark } from "@/components/agents/harness-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  agentInputFrom,
  emptyAgentForm,
} from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import {
  agentCapabilitiesQueryOptions,
  type ConnectionVerdict,
  testAgentConnection,
} from "@/lib/agents/queries";
import { isComposing } from "@/lib/composing";
import { queryClient } from "@/query-client";

/**
 * Creating a coworker, one question at a time.
 *
 * A wizard rather than a form, because the answers are three different kinds of decision: who this
 * coworker is, who may see it, and where it runs. The last one is the fork — a built-in coworker
 * needs nothing more, a managed one needs an endpoint — and a flat form showing endpoint fields to
 * everybody made the common case read like the hard one.
 */
export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The new coworker's id, so the caller can open its dialog on it. */
  onCreated: (agentId: string) => void;
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      {/* A floor of 70% of the viewport, against the popup's usual grow-to-fit. The three steps are
          very different heights — two choices on one, three fields on another, four plus an
          endpoint test on the last — and a dialog that resized itself between each made the
          wizard feel like three unrelated popups. The floor sits under the 85svh ceiling the popup
          already carries, so the two never fight: every step lands in that 70–85% band, and the
          shortest one pays for it with empty room below the question. */}
      <DialogContent className="min-h-[70svh]">
        {/* All wizard state lives below DialogContent, whose portal unmounts on close: dismissing
            the dialog mid-way discards the half-answered steps rather than pickling them. */}
        <CreateAgentWizard onClose={onClose} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The steps, in the order they are asked. The name is the questionnaire item's name.
 *
 * Visibility is last because it is the only question whose answer does not change what the person
 * is making. Asked second, it arrived before they had decided anything that makes private or public
 * mean something, and it was the step people had the least to go on.
 */
const STEPS = ["identity", "kind", "endpoint", "visibility"] as const;
type StepName = (typeof STEPS)[number];

/** The two ways a coworker can be seen. */
const VISIBILITY_OPTIONS: Array<{
  value: AgentFormValues["visibility"];
  title: string;
  description: string;
}> = [
  {
    value: "private",
    title: "Private",
    description: "Only you can see it and start channels with it.",
  },
  {
    value: "public",
    title: "Public",
    description: "Everyone in the deployment can find and use it.",
  },
];

/**
 * Where the coworker runs. Not a stored field: the server knows only whether an endpoint was
 * given, so "built-in" is the empty endpoint and this choice exists to make that fork explicit.
 *
 * Which framework was picked is not stored either. Every one of them is reached the same way and
 * written the same way, so after this dialog closes there is no record of the button that was
 * pressed.
 */
type AgentKind = "builtin" | "managed";

/** The first step's slice of the form contract, so its errors match the server's limits. */
const identitySchema = agentFormSchema.pick({
  name: true,
  title: true,
  roleDescription: true,
});

type IdentityField = keyof typeof identitySchema.shape;

/** First message per field, or nothing when the step parses. */
function identityIssues(
  values: AgentFormValues,
): Partial<Record<IdentityField, string>> {
  const parsed = identitySchema.safeParse(values);
  if (parsed.success) return {};
  const issues: Partial<Record<IdentityField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as IdentityField | undefined;
    if (field && !issues[field]) issues[field] = issue.message;
  }
  return issues;
}

/** A pane arrives from the side the journey is moving toward, and leaves out the other. */
const variants = {
  initial: (direction: number) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction: number) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

function CreateAgentWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agentId: string) => void;
}) {
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  /*
   * Whether "built-in" is a coworker this deployment can actually make. Assumed true while the
   * answer is loading, so the common deployment never sees the card flash from disabled to
   * enabled; the server refuses the create either way, so an optimistic card risks nothing.
   */
  const { data: capabilities } = useQuery(agentCapabilitiesQueryOptions());
  const builtInAvailable = capabilities?.builtInAvailable ?? true;

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  /** Whether this step's Continue was pressed, which is when its errors become worth showing. */
  const [tried, setTried] = useState(false);
  const [values, setValues] = useState<AgentFormValues>(emptyAgentForm);
  /** Deliberately unanswered to start with: revealing endpoint fields is the point of asking. */
  const [kind, setKind] = useState<AgentKind | null>(null);
  /**
   * Which framework's button was pressed, so Back returns to it still chosen.
   *
   * Nothing else reads it. Every framework leads to the same endpoint step and is stored the same
   * way, so after this dialog closes there is no answer to "which did I pick" — by design.
   */
  const [harness, setHarness] = useState<string | null>(null);

  const [connection, setConnection] = useState<ConnectionVerdict | null>(null);
  const [testing, setTesting] = useState(false);
  const [ref, bounds] = useMeasure();

  /**
   * The steps this answer actually asks, which is why there is no counter.
   *
   * A Bot that runs on this deployment is never asked for an address, so the sequence is three
   * questions for it and four for one somebody hosts. `step` indexes this rather than `STEPS`, so
   * the same index means the same question whichever way the person went.
   */
  const sequence = STEPS.filter(
    (name) => name !== "endpoint" || kind === "managed",
  );
  const current = sequence[step];
  const last = step === sequence.length - 1;
  const set = <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => setValues((current) => ({ ...current, [key]: value }));

  /** Test endpoint reachability from the server, which is what runs will use. */
  const testConnection = async () => {
    setTesting(true);
    setConnection(null);
    try {
      setConnection(
        await testAgentConnection(values.endpoint, values.authValue),
      );
    } finally {
      setTesting(false);
    }
  };

  const identityErrors = tried ? identityIssues(values) : {};
  const endpointError = !tried
    ? undefined
    : values.endpoint.trim() === ""
      ? "An address is required for an agent you host."
      : agentFormSchema.shape.endpoint.safeParse(values.endpoint).error
          ?.issues[0]?.message;

  /**
   * A framework button, or the Bot that runs here, answered and moved on in one press.
   *
   * The press is the answer, so there is nothing left for a Continue to confirm — and the step
   * this replaced cost the hosted path two presses for one decision. `go` is called with the next
   * index directly rather than through `advance`, because `advance` would read `kind` from a
   * closure this setState has not updated yet.
   */
  const choose = (next: AgentKind, harnessId: string | null) => {
    setKind(next);
    setHarness(harnessId);
    if (next === "builtin") {
      // A built-in coworker has no endpoint; whatever was typed on the way past must not ride
      // along into the create.
      set("endpoint", "");
      set("authValue", "");
      setConnection(null);
    }
    go(step + 1);
  };

  const stepValid = (): boolean => {
    if (current === "identity") {
      return identitySchema.safeParse(values).success;
    }
    // Reachable only by pressing one of its buttons, which is the answer; guarded anyway for Enter.
    if (current === "kind") return kind !== null;
    if (current === "endpoint") {
      return (
        values.endpoint.trim() !== "" &&
        agentFormSchema.shape.endpoint.safeParse(values.endpoint).success
      );
    }
    // Visibility always holds an answer; the radio starts on private.
    return true;
  };

  const go = (to: number) => {
    setDirection(to > step ? 1 : -1);
    setTried(false);
    setStep(to);
  };

  /**
   * Every way forward lands here — the Continue button, Enter in a field, Enter on a choice — as
   * the questionnaire form's submit. Backwards never validates; half answers are fine to leave.
   */
  const advance = async () => {
    if (!stepValid()) {
      setTried(true);
      return;
    }
    if (!last) {
      go(step + 1);
      return;
    }
    const agent = await createAgent.mutateAsync(agentInputFrom(values));
    onCreated(agent.id);
  };

  return (
    <>
      {/* Read aloud, never shown: each step carries its own heading, and a dialog-level title
          above them made two heading sizes compete. The popup still needs an accessible name. */}
      <DialogTitle className="sr-only">New coworker</DialogTitle>
      <DialogBody className="overflow-y-auto">
        <Questionnaire
          /* Fills the body so the empty room the min-height buys falls between the step and the
             buttons, rather than below buttons floating in the middle of the popup. */
          className="flex-1"
          item={current}
          noValidate
          /*
           * Enter means Continue, handled here rather than through the form's submit. The
           * questionnaire's own submit path refuses any item it does not consider answered, and it
           * cannot see these fields: the identity inputs are this dialog's own, not registered
           * answers. Running first and preventing default also keeps the primitive's Enter
           * handling out of the way; a textarea keeps Enter for its line breaks. The Enter that
           * confirms a composed character is left alone, as the primitive leaves it: it finishes a
           * character, not the step.
           */
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isComposing(event) &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              void advance();
            }
          }}
          onSubmit={(event) => event.preventDefault()}
        >
          {/* No step counter. The wizard is three questions for a Bot that runs here and four for
              one at an address somebody hosts, and a counter whose total changes under the reader
              mid-way is worse than none: it reads as the thing having got longer. Each step says
              what it is asking in its own heading, which is the part that was carrying the reader
              anyway. */}
          <MotionConfig
            transition={{ duration: 0.5, type: "spring", bounce: 0 }}
          >
            {/* The frame follows each pane's height, so the buttons glide instead of jumping.
                `relative` is load-bearing: popLayout positions the exiting pane absolutely, and an
                absolute element is clipped by overflow-hidden only on an ancestor that positions
                it. Without this its containing block is the dialog popup, and the old pane slides
                across the whole dialog instead of out of this frame. */}
            <motion.div
              animate={{ height: bounds.height > 0 ? bounds.height : "auto" }}
              className="relative overflow-hidden"
            >
              <div ref={ref}>
                <AnimatePresence
                  custom={direction}
                  initial={false}
                  mode="popLayout"
                >
                  <motion.div
                    animate="active"
                    /*
                     * `pb-2` is slack under the pane, not spacing: the frame above animates its
                     * height to whatever this measures, and clips at that edge. Without it the
                     * last line of a step sits exactly on the clip, so the spring's tail — still
                     * 4px short at 320ms, 1px at 400ms — shaves the bottom off that line for a
                     * visible moment on the way back to a taller step, and any rounding against
                     * it clips the line outright at rest.
                     */
                    className="pt-4 pb-2"
                    custom={direction}
                    exit="exit"
                    initial="initial"
                    key={current}
                    variants={variants}
                  >
                    {current === "identity" ? (
                      <IdentityStep
                        errors={identityErrors}
                        set={set}
                        values={values}
                      />
                    ) : current === "visibility" ? (
                      <VisibilityStep set={set} values={values} />
                    ) : current === "endpoint" ? (
                      <EndpointStep
                        connection={connection}
                        endpointError={endpointError}
                        onTest={() => void testConnection()}
                        set={set}
                        testing={testing}
                        values={values}
                      />
                    ) : (
                      <KindStep
                        builtInAvailable={builtInAvailable}
                        chosen={harness}
                        kind={kind}
                        onChoose={choose}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
          </MotionConfig>

          {createAgent.error ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {createAgent.error.message}
            </p>
          ) : null}

          {/* `mt-auto` pins the row to the bottom when the step is short; `pt-6` is the gap it
              keeps once the step is tall enough to have pushed it there itself. */}
          <div className="mt-auto flex justify-between gap-2 pt-6">
            <Button
              onClick={step === 0 ? onClose : () => go(step - 1)}
              type="button"
              variant="outline"
            >
              {step === 0 ? "Cancel" : "Back"}
            </Button>
            {/* No forward button where the choice is the answer: on "where does it run" every
                button both answers and moves on, so a Continue beside them would be a
                control that confirms a decision already taken. */}
            {current === "kind" ? null : (
              <Button
                disabled={createAgent.isPending}
                onClick={() => void advance()}
                type="button"
              >
                {last
                  ? createAgent.isPending
                    ? "Creating…"
                    : "Create coworker"
                  : "Continue"}
              </Button>
            )}
          </div>
        </Questionnaire>
      </DialogBody>
    </>
  );
}

/**
 * `hidden={false}` and `inert={false}` on every item, against the questionnaire's own hiding.
 *
 * The primitive blanks any item that is not the active one, which is right for its stacked layout
 * and wrong here: only the active step is mounted, except for the instant an old pane is sliding
 * out under AnimatePresence — exactly when the primitive would blank it mid-slide. The item's
 * visibility is the animation's job in this dialog, never the questionnaire's.
 */
function StepItem({
  name,
  children,
}: {
  name: StepName;
  children: React.ReactNode;
}) {
  return (
    <QuestionnaireItem hidden={false} inert={false} name={name}>
      {children}
    </QuestionnaireItem>
  );
}

function IdentityStep({
  values,
  errors,
  set,
}: {
  values: AgentFormValues;
  errors: Partial<Record<IdentityField, string>>;
  set: <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => void;
}) {
  return (
    <StepItem name="identity">
      <QuestionnaireTitle>Who is this coworker?</QuestionnaireTitle>
      <QuestionnaireDescription>
        A name to call it by, a line describing it, and the job it does.
      </QuestionnaireDescription>
      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="create-agent-name">Name</FieldLabel>
          <Input
            aria-invalid={errors.name ? true : undefined}
            autoComplete="off"
            id="create-agent-name"
            onChange={(event) => set("name", event.target.value)}
            placeholder="Expense Manager"
            value={values.name}
          />
          {errors.name ? (
            <FieldError errors={[{ message: errors.name }]} />
          ) : null}
        </Field>
        <Field data-invalid={errors.title ? true : undefined}>
          <FieldLabel htmlFor="create-agent-title">Title</FieldLabel>
          <Input
            aria-invalid={errors.title ? true : undefined}
            autoComplete="off"
            id="create-agent-title"
            onChange={(event) => set("title", event.target.value)}
            placeholder="Finance Operations"
            value={values.title}
          />
          {errors.title ? (
            <FieldError errors={[{ message: errors.title }]} />
          ) : (
            <p className="text-muted-foreground text-sm">
              A few words, shown beneath its name in lists.
            </p>
          )}
        </Field>
        <Field data-invalid={errors.roleDescription ? true : undefined}>
          <FieldLabel htmlFor="create-agent-role">What it does</FieldLabel>
          <Textarea
            aria-invalid={errors.roleDescription ? true : undefined}
            autoComplete="off"
            id="create-agent-role"
            onChange={(event) => set("roleDescription", event.target.value)}
            placeholder="Review receipts, categorize expenses, and prepare reimbursement reports."
            rows={4}
            value={values.roleDescription}
          />
          {errors.roleDescription ? (
            <FieldError errors={[{ message: errors.roleDescription }]} />
          ) : (
            /* Said here rather than above the three fields, where it used to sit: it is true of
               this field alone, and "Role" next to "Title" read as a second job title rather than
               as the standing instruction it becomes. */
            <p className="text-muted-foreground text-sm">
              Its standing instruction in every channel. Messages in a channel
              are tasks within it.
            </p>
          )}
        </Field>
      </FieldGroup>
    </StepItem>
  );
}

function VisibilityStep({
  values,
  set,
}: {
  values: AgentFormValues;
  set: <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => void;
}) {
  return (
    <StepItem name="visibility">
      <QuestionnaireTitle>Who can see it?</QuestionnaireTitle>
      <QuestionnaireChoices>
        {VISIBILITY_OPTIONS.map((option) => (
          <QuestionnaireChoice
            checked={values.visibility === option.value}
            key={option.value}
            onChange={() => set("visibility", option.value)}
            value={option.value}
          >
            <span className="font-medium">{option.title}</span>
            <QuestionnaireChoiceDescription>
              {option.description}
            </QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
        ))}
      </QuestionnaireChoices>
    </StepItem>
  );
}

/**
 * Where the coworker runs, as buttons.
 *
 * TWO RADIOS BECAME A LIST OF NAMES, because the person this step is for arrives knowing the role
 * they want and could not tell "Built-in" from "Managed" — both are a kind of Bot, and neither
 * word says which one is theirs. A list led by the Bot this deployment runs itself, followed by the
 * frameworks somebody might already have running, is answered by recognition instead.
 *
 * EVERY FRAMEWORK LEADS TO THE SAME PLACE. Picking Google ADK rather than CrewAI changes nothing:
 * both ask for an AG-UI address on the next step and are stored identically. The names are here so
 * somebody finds their own and knows this will work, not because the choice branches. The risk that
 * carries — that twelve buttons read as a promise OpenBot will go and run CrewAI for you, which is
 * what the desktop setup window really does — was raised and accepted deliberately.
 *
 * The press is the answer, so there is no Continue: `onChoose` both records and advances.
 */
function KindStep({
  builtInAvailable,
  chosen,
  kind,
  onChoose,
}: {
  /** Whether this deployment has been pointed at a Bot of its own. */
  builtInAvailable: boolean;
  /** The framework whose button was pressed, so coming back shows it still chosen. */
  chosen: string | null;
  kind: AgentKind | null;
  onChoose: (kind: AgentKind, harness: string | null) => void;
}) {
  return (
    <StepItem name="kind">
      <QuestionnaireTitle>Where does it run?</QuestionnaireTitle>
      <div className="flex flex-col gap-2">
        <button
          aria-pressed={kind === "builtin"}
          className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 aria-pressed:border-primary/40 aria-pressed:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          disabled={!builtInAvailable}
          onClick={() => onChoose("builtin", null)}
          type="button"
        >
          <IconSparkles className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block font-medium text-sm">Run it here</span>
            <span className="block text-muted-foreground text-xs">
              {builtInAvailable
                ? "OpenBot runs it for you. Nothing to set up — it can start work as soon as it is made."
                : "Not available yet. Whoever set OpenBot up has to switch this on first."}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-2 py-1 text-muted-foreground text-xs">
          <span className="h-px flex-1 bg-border" />
          or connect one you run
          <span className="h-px flex-1 bg-border" />
        </div>

        {/*
         * Every framework, always, behind a scroller rather than a disclosure. A "show more" made
         * somebody who did not find their own on the first three press a control before they could
         * even look; scrolling is the gesture people already try on a list. The scroller is bounded
         * so it is the list that moves and not the step: the question above it and the Back button
         * below stay exactly where they were.
         *
         * FLUSH, WITH NOTHING WIDER THAN THE FRAME ABOVE IT. The frame that animates each step's
         * height hides its overflow, and it hides it on both axes. A negative margin here — put in
         * to stop a row's border meeting the clip edge — made this box three pixels wider than that
         * frame, and focusing the step scrolled the frame four pixels sideways to reveal them.
         * Every child then drew four pixels to the left of where it belonged, so the step's own
         * heading lost the left of its first letter and each row lost its left border. Horizontal
         * room is bought with an inset focus ring on the rows instead, which cannot overflow.
         *
         * Bounded in `svh` rather than at a fixed height, because the popup it sits in is already
         * sized that way: at `max-h-64` the list stopped short and left a third of the step empty.
         */}
        <div className="max-h-[42svh] overflow-y-auto">
          <div className="flex flex-col gap-2">
            {WEB_HARNESSES.map((harness) => (
              <button
                aria-pressed={kind === "managed" && chosen === harness.id}
                className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted aria-pressed:border-primary/40 aria-pressed:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                data-testid="harness-option"
                key={harness.id}
                onClick={() => onChoose("managed", harness.id)}
                type="button"
              >
                <HarnessMark id={harness.mark} name={harness.name} />
                <span className="min-w-0">
                  <span className="block font-medium text-sm">
                    {harness.name}
                  </span>
                  <span className="block text-muted-foreground text-xs">
                    {summaryFor(harness)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </StepItem>
  );
}

/**
 * The address of an agent somebody else hosts.
 *
 * Generic on purpose: it does not name the framework that led here, because nothing about it
 * differs per framework and a heading that said "your CrewAI agent" would imply otherwise.
 */
function EndpointStep({
  values,
  set,
  endpointError,
  connection,
  testing,
  onTest,
}: {
  values: AgentFormValues;
  set: <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => void;
  endpointError?: string;
  connection: ConnectionVerdict | null;
  testing: boolean;
  onTest: () => void;
}) {
  return (
    <StepItem name="endpoint">
      <QuestionnaireTitle>Where can it be reached?</QuestionnaireTitle>
      <FieldGroup>
        <Field data-invalid={endpointError ? true : undefined}>
          <FieldLabel htmlFor="create-agent-endpoint">
            Agent endpoint
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              aria-invalid={endpointError ? true : undefined}
              autoComplete="off"
              id="create-agent-endpoint"
              onChange={(event) => set("endpoint", event.target.value)}
              placeholder="https://your-agent.example.com/ag-ui"
              value={values.endpoint}
            />
            <Button
              disabled={!values.endpoint || testing}
              onClick={onTest}
              type="button"
              variant="outline"
            >
              {testing ? "Testing…" : "Test"}
            </Button>
          </div>
          {endpointError ? (
            <FieldError errors={[{ message: endpointError }]} />
          ) : connection ? (
            <p
              className={`text-sm ${connection.ok ? "text-muted-foreground" : "text-destructive"}`}
              role="status"
            >
              {connection.ok
                ? `It answered: ${connection.events.join(", ")}`
                : connection.reason}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              Anything that speaks AG-UI works. This server dials your agent, so
              an agent on your own machine has to be reachable from here.
            </p>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="create-agent-key">
            Key for that agent (optional)
          </FieldLabel>
          <Input
            autoComplete="off"
            id="create-agent-key"
            onChange={(event) => set("authValue", event.target.value)}
            placeholder="Bearer …"
            type="password"
            value={values.authValue}
          />
          <p className="text-muted-foreground text-sm">
            Sent as an <code>Authorization</code> header on every run, and kept
            in the credential vault.
          </p>
        </Field>
      </FieldGroup>
    </StepItem>
  );
}
