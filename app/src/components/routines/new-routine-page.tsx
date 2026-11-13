import { useForm, useSelector } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, linkOptions, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageCard,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
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
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  type CheckInReadable,
  checkInReadableQueryOptions,
  type ProactiveSetting,
  proactiveAllowedQueryOptions,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
import {
  browserTimeZone,
  DOES,
  EVENT_SOURCES,
  MONTH_DAYS,
  NEW_CONVERSATION,
  REPEAT_LABEL,
  REPEATS,
  type Repeat,
  ROUTINE_FORM_DEFAULTS,
  type RoutineEventSource,
  type RoutineFormValues,
  routineFormSchema,
  STARTS,
  scheduleSentence,
  type WATCHES,
  WEEKDAY_LABEL,
} from "@/lib/routines/form";
import { CHECK_IN_INTERVALS } from "@/lib/routines/merged";
import {
  createFromPlanMutationOptions,
  SavedButRefused,
} from "@/lib/routines/mutations";
import { checkInSubject, planRoutine } from "@/lib/routines/plan";
import { openingOf } from "@/lib/voice/cut";
import { queryClient } from "@/query-client";

/** The conversations a routine for this Bot may post in: live ones the Bot is in. */
function conversationsWith(
  channels: ChannelSummary[] | undefined,
  agentId: string,
): ChannelSummary[] {
  return (channels ?? []).filter(
    (channel) =>
      channel.active && !channel.task && channel.agentIds.includes(agentId),
  );
}

function conversationName(channel: ChannelSummary): string {
  const title = (channel.summary || untitledLine(channel) || "").trim();
  // What the sidebar calls one nobody has named or written in yet.
  return title ? openingOf(title, 60) : "New conversation";
}

/** What Name says when an Only tell you would land on a check-in the Bot already has. */
const SAME_CHECK_IN =
  "This Bot already checks in on this. Give this one a different name, or change that one on its row.";

/**
 * Whether an Only tell you called `title` (`checkInSubject`: its Name, else its instruction) is a
 * check-in this Bot already has. The server counts a check-in with no link and the same subject, in
 * any case, as the same one. Asked for a new one, as this screen asks, it refuses that with 409 and
 * this sentence (`refuseExisting` in `proactiveStore.create`); this check says it while Name is typed.
 */
function sameCheckIn(
  settings: ProactiveSetting[] | undefined,
  agentId: string,
  title: string,
): boolean {
  const subject = title.trim().toLowerCase();
  return (settings ?? []).some(
    (setting) =>
      setting.agentId === agentId &&
      !setting.sourceLink &&
      (setting.subject ?? "").toLowerCase() === subject,
  );
}

/** What It watches says when the Bot can read no app the person connected. */
const NO_APPS =
  "This Bot can't read any app you've connected. Connect one in Connections, or choose a web page.";
/** Beside A web page, for a Bot with no tool that reads one. */
const NO_PAGES = "This Bot has no web search.";

const WATCHES_LABEL: Record<(typeof WATCHES)[number], string> = {
  apps: "Your connected apps",
  page: "A web page",
};

/** "Gmail", "Gmail and Notion", "Gmail, Notion and Slack". */
function listed(apps: readonly string[]): string {
  return apps.length <= 1
    ? (apps[0] ?? "")
    : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
}

/** What It should says when Only tell you was picked and an admin then turned check-ins off. */
const TELL_OFF =
  "An admin turned check-ins off, so it can't only tell you. Choose Act for you to go on.";

type FieldName = keyof RoutineFormValues;

/** The id of a field's message, which its control names in `aria-describedby`. */
const errorId = (name: FieldName) => `${name}-error`;

/** One message per field: the first rule its answer breaks. */
type Messages = Partial<Record<FieldName, string>>;

/**
 * What the answers break now, field by field. The schema holds every rule about the answers alone,
 * its own fields' and the ones that read other answers (`crossFieldIssues`); the two below also read
 * what the server said: whether an admin allows check-ins, and the check-ins the Bot already has.
 */
function brokenRules(
  values: RoutineFormValues,
  allowed: boolean,
  checkIns: ProactiveSetting[] | undefined,
  readable?: CheckInReadable,
): Messages {
  const messages: Messages = {};
  const add = (name: FieldName, message: string) => {
    messages[name] ??= message;
  };
  const parsed = routineFormSchema.safeParse(values);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      add(issue.path[0] as FieldName, issue.message);
  // A check-in that could never look is not made: the server would refuse it too.
  if (values.does === "tell" && allowed && readable) {
    if (values.watches === "apps" && readable.apps.length === 0)
      add("watches", NO_APPS);
    if (values.watches === "page" && !readable.page) add("watches", NO_PAGES);
  }
  if (values.does === "tell" && !allowed) add("does", TELL_OFF);
  // Only a check-in can clash: not acting, and not a tell held because check-ins are off.
  else if (
    values.does === "tell" &&
    sameCheckIn(checkIns, values.agentId, checkInSubject(values))
  )
    add("title", SAME_CHECK_IN);
  return messages;
}

function sameMessages(a: Messages, b: Messages): boolean {
  const names = Object.keys(a) as FieldName[];
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => a[name] === b[name])
  );
}

const MONTH_DAY_LABEL = Object.fromEntries(
  MONTH_DAYS.map((day) => [day, day]),
) as Record<string, string>;

const WEEKDAY_ITEMS = Object.fromEntries(
  WEEKDAY_LABEL.map((label, index) => [String(index), label]),
) as Record<string, string>;

type Does = (typeof DOES)[number];

const DOES_LABEL: Record<Does, string> = {
  act: "Act for you",
  tell: "Only tell you",
};

const INTERVAL_LABEL = Object.fromEntries(
  CHECK_IN_INTERVALS.map(({ minutes, label }) => [String(minutes), label]),
) as Record<string, string>;

type Starts = (typeof STARTS)[number];

const STARTS_LABEL: Record<Starts, string> = {
  schedule: "On a schedule",
  event: "When something happens",
  now: "Now, once",
};

const EVENT_SOURCE_LABEL: Record<RoutineEventSource, string> = {
  github: "GitHub",
  slack: "Slack",
  connector: "Connected app",
};

/** The Routines list a page came from: one Bot's, or every Bot's. */
export function routinesOf(agentId: string | undefined) {
  return agentId
    ? linkOptions({ to: "/bots/$agentId/routines", params: { agentId } })
    : linkOptions({ to: "/routines" });
}

/**
 * New routine, on a screen of its own: a Bot, what it does, when, and where it posts. Only tell you
 * posts nowhere: a check-in belongs to its Bot, and what it finds shows under Needs you.
 *
 * The shape other assistants use for scheduled work. A frequency picker with a time, read back as
 * a sentence, and a way out for anything the picker does not cover: ask the Bot, which writes any
 * schedule through the same store this page does. `agentId` and `channelId` arrive pre-filled from
 * a Bot's Routines page and from the clock beside a conversation's message box.
 */
export function NewRoutinePage({
  agentId: presetAgentId,
  channelId: presetChannelId,
}: {
  agentId?: string;
  channelId?: string;
}) {
  const navigate = useNavigate();
  // Cancel and the back link go to the Routines list it came from: the Bot's own, or every Bot's in
  // Settings.
  const back = routinesOf(presetAgentId);
  // After a save: from a Bot's page, the chosen Bot's list (it may differ from the preset); from
  // Settings, which lists every Bot's routines, back to Settings whichever Bot was picked.
  const after = (agentId: string) =>
    routinesOf(presetAgentId ? agentId || presetAgentId : undefined);
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const createFromPlan = useMutation(
    createFromPlanMutationOptions(queryClient),
  );
  // Only tell you is offered once the answer says an admin allows check-ins: not while it loads.
  const allowed = useQuery(proactiveAllowedQueryOptions()).data === true;
  // The same request as `allowed`: both read one key.
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  // FOUND IN REVIEW: Slack was offered as a source in every edition. The personal edition has no
  // Slack (Connections leaves it out), so a goal woken by a Slack event there never ran, while its
  // row named the event as if it would.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const eventSources = personal
    ? EVENT_SOURCES.filter((source) => source !== "slack")
    : EVENT_SOURCES;
  const timeZone = browserTimeZone();
  // A write was saved, or its answer was lost. Lock the form to prevent duplicate work.
  const saved = createFromPlan.error instanceof SavedButRefused;
  const plan = createFromPlan.variables;
  const savedFor = plan
    ? plan.kind === "goal"
      ? plan.goal.agentId
      : plan.kind === "routine"
        ? plan.routine.agentId
        : plan.checkIn.agentId
    : "";

  const defaultValues: RoutineFormValues = {
    ...ROUTINE_FORM_DEFAULTS,
    agentId: presetAgentId ?? "",
    channelId:
      presetChannelId && presetAgentId ? presetChannelId : NEW_CONVERSATION,
  };

  // Whether this page is still open, read after the create's requests come back.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      if (saved) return;
      // Answers that break a rule write nothing. Pressing Create shows every message (`shown`).
      if (
        Object.keys(brokenRules(value, allowed, checkIns.data, readable.data))
          .length > 0
      )
        return;
      try {
        // A tell with check-ins off is held by the rule on It should, so this is what was chosen.
        await createFromPlan.mutateAsync(planRoutine(value, timeZone));
      } catch {
        // The alert under the form says what happened, from `createFromPlan.error`.
        return;
      }
      // The person may have left, by the sidebar, while this ran; then there is nowhere to send them.
      if (open.current) await navigate(after(value.agentId));
    },
  });

  /**
   * The messages the page shows: the rules the answers break now (`brokenRules`), each on a field the
   * person worked on, or on every field once they pressed Create. It should's needs neither: an
   * admin made it wrong, not the person.
   *
   * Worked out from the answers each time rather than kept by field validators. A validator's result
   * sits in the slot of the event that ran it (mount, change, submit), and each event clears only
   * some slots, so the message showing was whichever event ran last: asking a field again to follow
   * an answer it reads wiped its submit message while its rule still failed, and marked it touched.
   * Here a message is there exactly while its rule fails, and only the person's own edits and Create
   * count as working on a field. Nothing is asked again when an answer, or `allowed`, changes.
   */
  // What a check-in for the chosen Bot could read, for It watches.
  const chosenBot = useSelector(form.store, (state) => state.values.agentId);
  const readable = useQuery(checkInReadableQueryOptions(chosenBot));

  const shown = useSelector(
    form.store,
    (state) => {
      const pressed = state.submissionAttempts > 0;
      const messages: Messages = {};
      for (const [name, message] of Object.entries(
        brokenRules(state.values, allowed, checkIns.data, readable.data),
      ) as [FieldName, string][])
        if (name === "does" || pressed || state.fieldMeta[name]?.isTouched)
          messages[name] = message;
      return messages;
    },
    { compare: sameMessages },
  );

  /*
   * Where focus goes. Each press of Create with a message showing moves it to the first field that
   * has one, in the order the page draws them; a message that comes or goes while the person types
   * moves nothing. After a partial or uncertain save, Create (which had focus) is replaced by Go to
   * Routines, so focus moves there instead of falling back to the page.
   */
  const formRef = useRef<HTMLFormElement>(null);
  const goToRoutines = useRef<HTMLElement | null>(null);
  const attempts = useSelector(form.store, (state) => state.submissionAttempts);
  const focusedFor = useRef(0);
  useEffect(() => {
    if (attempts === focusedFor.current) return;
    focusedFor.current = attempts;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [attempts]);
  useEffect(() => {
    if (saved) goToRoutines.current?.focus();
  }, [saved]);

  const botItems = Object.fromEntries(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  ) as Record<string, string>;

  return (
    <PageShell
      // Not a link while the writes are on their way, as Cancel isn't: leaving would hide their answer.
      backButton={{
        label: "Routines",
        linkProps: back,
        disabled: createFromPlan.isPending,
      }}
      description="Pick a Bot, say what it should do, and choose when it starts."
      title="New routine"
    >
      <form
        noValidate
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        {/* Sections rather than one card, as New skill is: who does it and what, when it starts,
            when it is done, and where it shows up. Each is one decision with room for its words. */}
        <PageSection
          className="mt-0"
          description="Pick the Bot that does the work, and say what one run of it is."
          title="What it does"
        >
          <PageCard className="mt-4">
            <FieldGroup>
              <form.Field name="agentId">
                {(field) => {
                  const isInvalid = field.name in shown;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Bot</FieldLabel>
                      <Select
                        disabled={saved}
                        items={botItems}
                        onValueChange={(value) => {
                          const next = String(value ?? "");
                          field.handleChange(next);
                          // Another Bot is in other conversations: start a new one unless this one is shared.
                          const current = form.getFieldValue("channelId");
                          if (
                            !conversationsWith(channels.data, next).some(
                              (channel) => channel.id === current,
                            )
                          ) {
                            form.setFieldValue("channelId", NEW_CONVERSATION);
                          }
                        }}
                        value={field.state.value || null}
                      >
                        <SelectTrigger
                          aria-invalid={isInvalid}
                          aria-describedby={
                            isInvalid ? errorId(field.name) : undefined
                          }
                          className="w-full"
                          id={field.name}
                        >
                          <SelectValue placeholder="Choose a Bot" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {(agents.data ?? []).map((agent) => (
                              <SelectItem key={agent.id} value={agent.id}>
                                {/* Hidden: the name beside it already says who. */}
                                <span aria-hidden="true" className="contents">
                                  <AbstractAvatar
                                    name={agent.name}
                                    seed={agent.avatarSeed}
                                    size={18}
                                  />
                                </span>
                                {agent.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {isInvalid ? (
                        <FieldError id={errorId(field.name)}>
                          {shown[field.name]}
                        </FieldError>
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>

              <form.Field name="instruction">
                {(field) => {
                  const isInvalid = field.name in shown;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>What to do</FieldLabel>
                      <FieldDescription>
                        Write it as one run of the work. Leave the schedule out.
                      </FieldDescription>
                      <Textarea
                        disabled={saved}
                        aria-invalid={isInvalid}
                        aria-describedby={
                          isInvalid ? errorId(field.name) : undefined
                        }
                        id={field.name}
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        placeholder="Send me a summary of yesterday's new leads"
                        rows={3}
                        value={field.state.value}
                      />
                      {isInvalid ? (
                        <FieldError id={errorId(field.name)}>
                          {shown[field.name]}
                        </FieldError>
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>

              {/* Not drawn without check-ins: a picker with only Act for you asks nothing. Still drawn
                    for an Only tell you picked before an admin turned them off, to say so. */}
              <form.Subscribe selector={(state) => state.values.does}>
                {(does) =>
                  allowed || does === "tell" ? (
                    <form.Field name="does">
                      {(field) => {
                        // Shown without a touch: the person didn't change it, an admin did.
                        const isInvalid = field.name in shown;
                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>
                              It should
                            </FieldLabel>
                            <Select
                              disabled={saved}
                              items={DOES_LABEL}
                              onValueChange={(value) =>
                                field.handleChange(value as Does)
                              }
                              value={field.state.value}
                            >
                              <SelectTrigger
                                aria-invalid={isInvalid}
                                aria-describedby={
                                  isInvalid ? errorId(field.name) : undefined
                                }
                                className="w-full"
                                id={field.name}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {/* Once check-ins are off, Only tell you can't be chosen. It stays listed:
                                        the Select resets a value whose item goes away, which would switch
                                        it to Act for you without asking. */}
                                  {DOES.map((choice) => (
                                    <SelectItem
                                      disabled={choice === "tell" && !allowed}
                                      key={choice}
                                      value={choice}
                                    >
                                      {DOES_LABEL[choice]}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            {field.state.value === "tell" ? (
                              <FieldDescription>
                                It reads and raises what needs you. It changes
                                nothing.
                              </FieldDescription>
                            ) : null}
                            {isInvalid ? (
                              <FieldError id={errorId(field.name)}>
                                {shown[field.name]}
                              </FieldError>
                            ) : null}
                          </Field>
                        );
                      }}
                    </form.Field>
                  ) : null
                }
              </form.Subscribe>

              {/*
               * What an Only tell you watches, refused here when it could never look. FOUND IN AN
               * AUDIT: a check-in made for a Bot that could read nothing ran no check at all, and
               * nobody was told.
               */}
              <form.Subscribe
                selector={(state) => [state.values.does, state.values.watches]}
              >
                {([does, watches]) =>
                  allowed && does === "tell" ? (
                    <>
                      <form.Field name="watches">
                        {(field) => {
                          const isInvalid = field.name in shown;
                          const apps = readable.data?.apps;
                          const noPage = readable.data?.page === false;
                          return (
                            <Field data-invalid={isInvalid}>
                              <FieldLabel htmlFor={field.name}>
                                It watches
                              </FieldLabel>
                              <Select
                                disabled={saved}
                                items={WATCHES_LABEL}
                                onValueChange={(value) =>
                                  field.handleChange(
                                    value as (typeof WATCHES)[number],
                                  )
                                }
                                value={field.state.value}
                              >
                                <SelectTrigger
                                  aria-describedby={
                                    isInvalid ? errorId(field.name) : undefined
                                  }
                                  aria-invalid={isInvalid}
                                  className="w-full"
                                  id={field.name}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    <SelectItem value="apps">
                                      {WATCHES_LABEL.apps}
                                    </SelectItem>
                                    {/* Listed even when it can't be chosen, saying why. */}
                                    <SelectItem disabled={noPage} value="page">
                                      {WATCHES_LABEL.page}
                                      {noPage ? (
                                        <span className="text-muted-foreground text-xs">
                                          {NO_PAGES}
                                        </span>
                                      ) : null}
                                    </SelectItem>
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              {field.state.value === "apps" &&
                              apps &&
                              !isInvalid ? (
                                <FieldDescription>
                                  {apps.length
                                    ? `It reads ${listed(apps)}.`
                                    : NO_APPS}
                                </FieldDescription>
                              ) : null}
                              {isInvalid ? (
                                <FieldError id={errorId(field.name)}>
                                  {shown[field.name]}
                                </FieldError>
                              ) : null}
                            </Field>
                          );
                        }}
                      </form.Field>
                      {watches === "page" ? (
                        <form.Field name="pageAddress">
                          {(field) => {
                            const isInvalid = field.name in shown;
                            return (
                              <Field data-invalid={isInvalid}>
                                <FieldLabel htmlFor={field.name}>
                                  Page address
                                </FieldLabel>
                                <FieldDescription>
                                  It reads this page each time and tells you
                                  when something there needs you.
                                </FieldDescription>
                                <Input
                                  aria-describedby={
                                    isInvalid ? errorId(field.name) : undefined
                                  }
                                  aria-invalid={isInvalid}
                                  disabled={saved}
                                  id={field.name}
                                  inputMode="url"
                                  name={field.name}
                                  onBlur={field.handleBlur}
                                  onChange={(event) =>
                                    field.handleChange(event.target.value)
                                  }
                                  placeholder="https://github.com/your/project/releases"
                                  value={field.state.value}
                                />
                                {isInvalid ? (
                                  <FieldError id={errorId(field.name)}>
                                    {shown[field.name]}
                                  </FieldError>
                                ) : null}
                              </Field>
                            );
                          }}
                        </form.Field>
                      ) : null}
                    </>
                  ) : null
                }
              </form.Subscribe>
            </FieldGroup>
          </PageCard>
        </PageSection>

        <form.Subscribe selector={(state) => state.values.does}>
          {(does) => (
            <PageSection
              description={
                does === "tell"
                  ? "It looks this often, and tells you when something needs you."
                  : "On a schedule, when something happens, or once, now."
              }
              title={does === "tell" ? "How often it looks" : "When it starts"}
            >
              <PageCard className="mt-4">
                <FieldGroup>
                  {/* Only tell you has no start of its own, only how often it looks. */}
                  <form.Subscribe
                    selector={(state) => [
                      state.values.does,
                      state.values.starts,
                    ]}
                  >
                    {([does, starts]) =>
                      does === "tell" ? (
                        <form.Field name="interval">
                          {(field) => (
                            <Field>
                              <FieldLabel htmlFor={field.name}>
                                How often
                              </FieldLabel>
                              <Select
                                disabled={saved}
                                items={INTERVAL_LABEL}
                                onValueChange={(value) =>
                                  field.handleChange(String(value))
                                }
                                value={field.state.value}
                              >
                                <SelectTrigger
                                  className="w-full"
                                  id={field.name}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {CHECK_IN_INTERVALS.map(
                                      ({ minutes, label }) => (
                                        <SelectItem
                                          key={minutes}
                                          value={String(minutes)}
                                        >
                                          {label}
                                        </SelectItem>
                                      ),
                                    )}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </Field>
                          )}
                        </form.Field>
                      ) : (
                        <>
                          <form.Field name="starts">
                            {(field) => (
                              <Field>
                                <FieldLabel htmlFor={field.name}>
                                  Starts
                                </FieldLabel>
                                <Select
                                  disabled={saved}
                                  items={STARTS_LABEL}
                                  onValueChange={(value) =>
                                    field.handleChange(value as Starts)
                                  }
                                  value={field.state.value}
                                >
                                  <SelectTrigger
                                    className="w-full"
                                    id={field.name}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      {STARTS.map((choice) => (
                                        <SelectItem key={choice} value={choice}>
                                          {STARTS_LABEL[choice]}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              </Field>
                            )}
                          </form.Field>

                          {starts === "schedule" ? (
                            <Field>
                              <FieldLabel htmlFor="repeat">When</FieldLabel>
                              <div className="flex flex-wrap gap-3">
                                <form.Field name="repeat">
                                  {(field) => (
                                    <Select
                                      disabled={saved}
                                      items={REPEAT_LABEL}
                                      onValueChange={(value) =>
                                        field.handleChange(value as Repeat)
                                      }
                                      value={field.state.value}
                                    >
                                      <SelectTrigger
                                        className="min-w-40 flex-1"
                                        id="repeat"
                                      >
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectGroup>
                                          {REPEATS.map((repeat) => (
                                            <SelectItem
                                              key={repeat}
                                              value={repeat}
                                            >
                                              {REPEAT_LABEL[repeat]}
                                            </SelectItem>
                                          ))}
                                        </SelectGroup>
                                      </SelectContent>
                                    </Select>
                                  )}
                                </form.Field>
                                <form.Subscribe
                                  selector={(state) => state.values.repeat}
                                >
                                  {(repeat) => (
                                    <>
                                      {repeat === "weekly" ? (
                                        <form.Field name="weekday">
                                          {(field) => (
                                            <Select
                                              disabled={saved}
                                              items={WEEKDAY_ITEMS}
                                              onValueChange={(value) =>
                                                field.handleChange(
                                                  String(value),
                                                )
                                              }
                                              value={field.state.value}
                                            >
                                              <SelectTrigger
                                                aria-label="Day of the week"
                                                className="min-w-36 flex-1"
                                              >
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                <SelectGroup>
                                                  {WEEKDAY_LABEL.map(
                                                    (label, index) => (
                                                      <SelectItem
                                                        key={label}
                                                        value={String(index)}
                                                      >
                                                        {label}
                                                      </SelectItem>
                                                    ),
                                                  )}
                                                </SelectGroup>
                                              </SelectContent>
                                            </Select>
                                          )}
                                        </form.Field>
                                      ) : null}
                                      {repeat === "monthly" ? (
                                        <form.Field name="monthDay">
                                          {(field) => (
                                            <Select
                                              disabled={saved}
                                              items={MONTH_DAY_LABEL}
                                              onValueChange={(value) =>
                                                field.handleChange(
                                                  String(value),
                                                )
                                              }
                                              value={field.state.value}
                                            >
                                              <SelectTrigger
                                                aria-label="Day of the month"
                                                className="min-w-24"
                                              >
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                <SelectGroup>
                                                  {MONTH_DAYS.map((day) => (
                                                    <SelectItem
                                                      key={day}
                                                      value={day}
                                                    >
                                                      {day}
                                                    </SelectItem>
                                                  ))}
                                                </SelectGroup>
                                              </SelectContent>
                                            </Select>
                                          )}
                                        </form.Field>
                                      ) : null}
                                      {repeat === "hourly" ? null : (
                                        <form.Field name="time">
                                          {(field) => {
                                            const isInvalid =
                                              field.name in shown;
                                            return (
                                              <>
                                                <Input
                                                  disabled={saved}
                                                  aria-invalid={isInvalid}
                                                  aria-describedby={
                                                    isInvalid
                                                      ? errorId(field.name)
                                                      : undefined
                                                  }
                                                  aria-label="Time"
                                                  className="w-32"
                                                  onBlur={field.handleBlur}
                                                  onChange={(event) =>
                                                    field.handleChange(
                                                      event.target.value,
                                                    )
                                                  }
                                                  step={900}
                                                  type="time"
                                                  value={field.state.value}
                                                />
                                                {isInvalid ? (
                                                  <FieldError
                                                    id={errorId(field.name)}
                                                  >
                                                    {shown[field.name]}
                                                  </FieldError>
                                                ) : null}
                                              </>
                                            );
                                          }}
                                        </form.Field>
                                      )}
                                    </>
                                  )}
                                </form.Subscribe>
                              </div>
                              <form.Subscribe
                                selector={(state) => state.values}
                              >
                                {(values) => (
                                  <FieldDescription>
                                    <span className="font-medium text-foreground">
                                      {scheduleSentence(values)}
                                    </span>
                                    , your time ({timeZone}). For anything else,
                                    like every other Tuesday, ask the Bot in a
                                    conversation.
                                  </FieldDescription>
                                )}
                              </form.Subscribe>
                            </Field>
                          ) : null}

                          {starts === "event" ? (
                            <form.Subscribe
                              selector={(state) => state.values.eventSource}
                            >
                              {(eventSource) => (
                                <>
                                  <form.Field name="eventSource">
                                    {(field) => (
                                      <Field>
                                        <FieldLabel htmlFor={field.name}>
                                          Source
                                        </FieldLabel>
                                        <Select
                                          disabled={saved}
                                          items={EVENT_SOURCE_LABEL}
                                          onValueChange={(value) =>
                                            field.handleChange(
                                              value as RoutineEventSource,
                                            )
                                          }
                                          value={field.state.value}
                                        >
                                          <SelectTrigger
                                            className="w-full"
                                            id={field.name}
                                          >
                                            <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectGroup>
                                              {eventSources.map((source) => (
                                                <SelectItem
                                                  key={source}
                                                  value={source}
                                                >
                                                  {EVENT_SOURCE_LABEL[source]}
                                                </SelectItem>
                                              ))}
                                            </SelectGroup>
                                          </SelectContent>
                                        </Select>
                                        {eventSource === "github" ? (
                                          <FieldDescription>
                                            Events come from the repositories
                                            you connected in{" "}
                                            <Link to="/connections">
                                              Connections
                                            </Link>
                                            .
                                          </FieldDescription>
                                        ) : null}
                                      </Field>
                                    )}
                                  </form.Field>
                                  <form.Field name="eventType">
                                    {(field) => {
                                      const isInvalid = field.name in shown;
                                      return (
                                        <Field data-invalid={isInvalid}>
                                          <FieldLabel htmlFor={field.name}>
                                            Event
                                          </FieldLabel>
                                          <Input
                                            disabled={saved}
                                            aria-invalid={isInvalid}
                                            aria-describedby={
                                              isInvalid
                                                ? errorId(field.name)
                                                : undefined
                                            }
                                            id={field.name}
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                              field.handleChange(
                                                event.target.value,
                                              )
                                            }
                                            placeholder={
                                              eventSource === "github"
                                                ? "issues.opened"
                                                : undefined
                                            }
                                            value={field.state.value}
                                          />
                                          {isInvalid ? (
                                            <FieldError
                                              id={errorId(field.name)}
                                            >
                                              {shown[field.name]}
                                            </FieldError>
                                          ) : null}
                                        </Field>
                                      );
                                    }}
                                  </form.Field>
                                </>
                              )}
                            </form.Subscribe>
                          ) : null}
                        </>
                      )
                    }
                  </form.Subscribe>
                </FieldGroup>
              </PageCard>
            </PageSection>
          )}
        </form.Subscribe>

        {/* Only tell you is never done: it looks until you stop it. */}
        <form.Subscribe
          selector={(state) => [state.values.does, state.values.starts]}
        >
          {([does, starts]) =>
            does === "tell" ? null : (
              <PageSection
                description={
                  starts === "now"
                    ? "Optional. Leave it empty and it is done when the work is."
                    : "Optional. Leave it empty and it keeps going until you stop it."
                }
                title="When it's done"
              >
                <form.Field name="doneWhen">
                  {(field) => {
                    const isInvalid = field.name in shown;
                    return (
                      // The box alone, as New skill's instructions are: the section says what it is.
                      <Field className="mt-4" data-invalid={isInvalid}>
                        <FieldLabel className="sr-only" htmlFor={field.name}>
                          Done when (optional)
                        </FieldLabel>
                        <Textarea
                          disabled={saved}
                          aria-invalid={isInvalid}
                          aria-describedby={
                            isInvalid ? errorId(field.name) : undefined
                          }
                          id={field.name}
                          name={field.name}
                          onBlur={field.handleBlur}
                          onChange={(event) =>
                            field.handleChange(event.target.value)
                          }
                          placeholder="The report has this quarter's numbers and a source link."
                          rows={3}
                          value={field.state.value}
                        />
                        {isInvalid ? (
                          <FieldError id={errorId(field.name)}>
                            {shown[field.name]}
                          </FieldError>
                        ) : null}
                      </Field>
                    );
                  }}
                </form.Field>
              </PageSection>
            )
          }
        </form.Subscribe>

        <form.Subscribe selector={(state) => state.values.does}>
          {(does) => (
            <PageSection
              description={
                /*
                 * Only tell you posts nowhere: a check-in belongs to its Bot, and what it finds shows
                 * under Needs you. FOUND IN AN AUDIT: Posts in made an empty conversation for it that
                 * nothing was ever posted in, and deleting it silently stopped the check-in.
                 */
                does === "tell"
                  ? "What it finds shows under Needs you on Bots."
                  : "Where each run posts, and what the Routines page calls it."
              }
              title="Where it shows up"
            >
              <PageCard className="mt-4">
                <FieldGroup>
                  {does === "tell" ? null : (
                    <form.Subscribe selector={(state) => state.values.agentId}>
                      {(agentId) => {
                        const shared = conversationsWith(
                          channels.data,
                          agentId,
                        );
                        // The conversation the clock was pressed in, second and called what it is to the
                        // person who just left it, even when it is past the roster's first page. The server
                        // still checks the Bot is in it.
                        const here =
                          presetChannelId && agentId === presetAgentId
                            ? { [presetChannelId]: "This conversation" }
                            : {};
                        const items: Record<string, string> = {
                          [NEW_CONVERSATION]: "A new conversation",
                          ...here,
                          ...Object.fromEntries(
                            shared.map((channel) => [
                              channel.id,
                              conversationName(channel),
                            ]),
                          ),
                          ...here,
                        };
                        const choices = Object.entries(items);
                        return (
                          <form.Field name="channelId">
                            {(field) => (
                              <Field>
                                <FieldLabel htmlFor={field.name}>
                                  Posts in
                                </FieldLabel>
                                <FieldDescription>
                                  {field.state.value === NEW_CONVERSATION
                                    ? "OpenBot starts a conversation for this routine, named after it."
                                    : "Each run posts in this conversation."}
                                </FieldDescription>
                                <Select
                                  disabled={saved || !agentId}
                                  items={items}
                                  onValueChange={(value) =>
                                    field.handleChange(String(value))
                                  }
                                  value={
                                    field.state.value in items
                                      ? field.state.value
                                      : NEW_CONVERSATION
                                  }
                                >
                                  <SelectTrigger
                                    className="w-full"
                                    id={field.name}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      {choices.map(([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                          {label}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              </Field>
                            )}
                          </form.Field>
                        );
                      }}
                    </form.Subscribe>
                  )}

                  <form.Field name="title">
                    {(field) => {
                      const isInvalid = field.name in shown;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                          <FieldDescription>
                            Optional. The Routines page shows it by this name.
                          </FieldDescription>
                          <Input
                            disabled={saved}
                            aria-invalid={isInvalid}
                            aria-describedby={
                              isInvalid ? errorId(field.name) : undefined
                            }
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                            placeholder="Morning leads"
                            value={field.state.value}
                          />
                          {isInvalid ? (
                            <FieldError id={errorId(field.name)}>
                              {shown[field.name]}
                            </FieldError>
                          ) : null}
                        </Field>
                      );
                    }}
                  </form.Field>
                </FieldGroup>
              </PageCard>
            </PageSection>
          )}
        </form.Subscribe>

        {createFromPlan.error ? (
          <p className="mt-8 text-destructive text-sm" role="alert">
            {createFromPlan.error.message}
          </p>
        ) : null}
        <div className="mt-8 flex justify-end gap-2">
          {/* Cancel says nothing was kept. After a partial or uncertain save the work is kept, and Go to
                  Routines goes to the same list. */}
          {saved ? (
            <Button
              // A link drawn as a button, so the ref is any element.
              ref={(element: HTMLElement | null) => {
                goToRoutines.current = element;
              }}
              render={(props) => (
                <Link
                  {...props}
                  // The Bot the work was saved for, not the one the picker shows.
                  {...after(savedFor)}
                />
              )}
              variant="outline"
            >
              Go to Routines
            </Button>
          ) : (
            <>
              {createFromPlan.isPending ? (
                // Not a link while the writes are on their way: leaving now would hide what they answer.
                <Button disabled variant="outline">
                  Cancel
                </Button>
              ) : (
                <Button
                  render={(props) => <Link {...props} {...back} />}
                  variant="outline"
                >
                  Cancel
                </Button>
              )}
              {/* Enabled while a message shows: pressing it takes the person to the first one. A
                  disabled button says nothing about why, and a keyboard can't reach it. */}
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <Button
                    disabled={isSubmitting || createFromPlan.isPending}
                    type="submit"
                  >
                    {isSubmitting || createFromPlan.isPending
                      ? "Creating…"
                      : "Create routine"}
                  </Button>
                )}
              </form.Subscribe>
            </>
          )}
        </div>
      </form>
    </PageShell>
  );
}
