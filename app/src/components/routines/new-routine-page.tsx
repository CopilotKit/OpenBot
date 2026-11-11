import { useForm, useSelector } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, linkOptions, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageCard, PageShell } from "@/components/layout/page-shell";
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
import {
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
  WEEKDAY_LABEL,
} from "@/lib/routines/form";
import { CHECK_IN_INTERVALS } from "@/lib/routines/merged";
import {
  createFromPlanMutationOptions,
  SavedButRefused,
} from "@/lib/routines/mutations";
import { planRoutine } from "@/lib/routines/plan";
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
 * Whether an Only tell you named `title` is a check-in this Bot already has. The server counts a
 * check-in with no link and the same subject, in any case, as the same one, and updates that one
 * in place (`proactiveStore.create`): it would keep posting in its own conversation, and the one
 * picked here would stay empty.
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

/** What It should says when Only tell you was picked and an admin then turned check-ins off. */
const TELL_OFF =
  "An admin turned check-ins off, so it can't only tell you. Choose Act for you to go on.";

type FieldName = keyof RoutineFormValues;

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
): Messages {
  const messages: Messages = {};
  const add = (name: FieldName, message: string) => {
    messages[name] ??= message;
  };
  const parsed = routineFormSchema.safeParse(values);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      add(issue.path[0] as FieldName, issue.message);
  if (values.does === "tell" && !allowed) add("does", TELL_OFF);
  // Only a check-in can clash: not acting, and not a tell held because check-ins are off.
  else if (
    values.does === "tell" &&
    sameCheckIn(checkIns, values.agentId, values.title)
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

/** A Bot's Routines list, or every Bot's in Settings when there is no Bot. */
function routinesOf(agentId: string | undefined) {
  return agentId
    ? linkOptions({ to: "/bots/$agentId/routines", params: { agentId } })
    : linkOptions({ to: "/routines" });
}

/**
 * New routine, on a screen of its own: a Bot, what it does, when, and where it posts.
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
  const timeZone = browserTimeZone();
  // The goal exists but its schedule or first run was refused. The form is read-only from here: the
  // goal is made for the Bot that was picked, and a second submit would make another one.
  const saved = createFromPlan.error instanceof SavedButRefused;
  // Only a goal can be saved and then refused, so its plan names the Bot it was saved for.
  const savedFor =
    createFromPlan.variables?.kind === "goal"
      ? createFromPlan.variables.goal.agentId
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
      if (Object.keys(brokenRules(value, allowed, checkIns.data)).length > 0)
        return;
      try {
        // A tell with check-ins off is held by the rule on It should, so this is what was chosen.
        await createFromPlan.mutateAsync(planRoutine(value, timeZone));
      } catch {
        // The alert under the form says what happened, from `createFromPlan.error`.
        return;
      }
      // The person may have left by the back link while this ran; then there is nowhere to send them.
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
  const shown = useSelector(
    form.store,
    (state) => {
      const pressed = state.submissionAttempts > 0;
      const messages: Messages = {};
      for (const [name, message] of Object.entries(
        brokenRules(state.values, allowed, checkIns.data),
      ) as [FieldName, string][])
        if (name === "does" || pressed || state.fieldMeta[name]?.isTouched)
          messages[name] = message;
      return messages;
    },
    { compare: sameMessages },
  );

  const botItems = Object.fromEntries(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  ) as Record<string, string>;

  return (
    <PageShell
      backButton={{ label: "Routines", linkProps: back }}
      description="Pick a Bot, say what it should do, and choose when it starts."
      title="New routine"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <PageCard
          footer={
            <>
              {/* Cancel says nothing was kept. After a partial save the goal is kept, and Go to
                  Routines goes to the same list. */}
              {saved ? (
                <Button
                  render={(props) => (
                    <Link
                      {...props}
                      // The Bot the goal was saved for, not the one the picker shows.
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
                  <form.Subscribe selector={(state) => state.isSubmitting}>
                    {(isSubmitting) => (
                      <Button
                        disabled={
                          Object.keys(shown).length > 0 ||
                          isSubmitting ||
                          createFromPlan.isPending
                        }
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
            </>
          }
        >
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
                      <FieldError>{shown[field.name]}</FieldError>
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
                      <FieldError>{shown[field.name]}</FieldError>
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
                            <FieldError>{shown[field.name]}</FieldError>
                          ) : null}
                        </Field>
                      );
                    }}
                  </form.Field>
                ) : null
              }
            </form.Subscribe>

            {/* When it starts, what starts it, and when it is done: one group, so a choice that
                needs none of them can leave the three out together. Only tell you needs none of
                them, only how often it looks. */}
            <form.Subscribe
              selector={(state) => [state.values.does, state.values.starts]}
            >
              {([does, starts]) =>
                does === "tell" ? (
                  <form.Field name="interval">
                    {(field) => (
                      <Field>
                        <FieldLabel htmlFor={field.name}>How often</FieldLabel>
                        <Select
                          disabled={saved}
                          items={INTERVAL_LABEL}
                          onValueChange={(value) =>
                            field.handleChange(String(value))
                          }
                          value={field.state.value}
                        >
                          <SelectTrigger className="w-full" id={field.name}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {CHECK_IN_INTERVALS.map(({ minutes, label }) => (
                                <SelectItem
                                  key={minutes}
                                  value={String(minutes)}
                                >
                                  {label}
                                </SelectItem>
                              ))}
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
                          <FieldLabel htmlFor={field.name}>Starts</FieldLabel>
                          <Select
                            disabled={saved}
                            items={STARTS_LABEL}
                            onValueChange={(value) =>
                              field.handleChange(value as Starts)
                            }
                            value={field.state.value}
                          >
                            <SelectTrigger className="w-full" id={field.name}>
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
                                      <SelectItem key={repeat} value={repeat}>
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
                                          field.handleChange(String(value))
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
                                          field.handleChange(String(value))
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
                                              <SelectItem key={day} value={day}>
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
                                      const isInvalid = field.name in shown;
                                      return (
                                        <>
                                          <Input
                                            disabled={saved}
                                            aria-invalid={isInvalid}
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
                                            <FieldError>
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
                        <form.Subscribe selector={(state) => state.values}>
                          {(values) => (
                            <FieldDescription>
                              <span className="font-medium text-foreground">
                                {scheduleSentence(values)}
                              </span>
                              , your time ({timeZone}). For anything else, like
                              every other Tuesday, ask the Bot in a
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
                                        {EVENT_SOURCES.map((source) => (
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
                                      Events come from the repositories you
                                      connected in{" "}
                                      <Link to="/connections">Connections</Link>
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
                                      id={field.name}
                                      name={field.name}
                                      onBlur={field.handleBlur}
                                      onChange={(event) =>
                                        field.handleChange(event.target.value)
                                      }
                                      placeholder={
                                        eventSource === "github"
                                          ? "issues.opened"
                                          : undefined
                                      }
                                      value={field.state.value}
                                    />
                                    {isInvalid ? (
                                      <FieldError>
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

                    <form.Field name="doneWhen">
                      {(field) => {
                        const isInvalid = field.name in shown;
                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>
                              Done when (optional)
                            </FieldLabel>
                            <FieldDescription>
                              {starts === "now"
                                ? "Leave it empty and it is done when the work is."
                                : "Leave it empty and it keeps going until you stop it."}
                            </FieldDescription>
                            <Textarea
                              disabled={saved}
                              aria-invalid={isInvalid}
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
                              <FieldError>{shown[field.name]}</FieldError>
                            ) : null}
                          </Field>
                        );
                      }}
                    </form.Field>
                  </>
                )
              }
            </form.Subscribe>

            <form.Subscribe selector={(state) => state.values.agentId}>
              {(agentId) => {
                const shared = conversationsWith(channels.data, agentId);
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
                        <FieldLabel htmlFor={field.name}>Posts in</FieldLabel>
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
                          <SelectTrigger className="w-full" id={field.name}>
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
                      <FieldError>{shown[field.name]}</FieldError>
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>
          {createFromPlan.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {createFromPlan.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}
