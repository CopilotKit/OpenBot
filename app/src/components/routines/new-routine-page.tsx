import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
  browserTimeZone,
  cronFrom,
  MONTH_DAYS,
  NEW_CONVERSATION,
  REPEAT_LABEL,
  REPEATS,
  type Repeat,
  type RoutineFormValues,
  routineFormSchema,
  scheduleSentence,
  WEEKDAY_LABEL,
} from "@/lib/routines/form";
import { createRoutineMutationOptions } from "@/lib/routines/mutations";
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

const MONTH_DAY_LABEL = Object.fromEntries(
  MONTH_DAYS.map((day) => [day, day]),
) as Record<string, string>;

const WEEKDAY_ITEMS = Object.fromEntries(
  WEEKDAY_LABEL.map((label, index) => [String(index), label]),
) as Record<string, string>;

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
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const createRoutine = useMutation(createRoutineMutationOptions(queryClient));
  const timeZone = browserTimeZone();

  const defaultValues: RoutineFormValues = {
    agentId: presetAgentId ?? "",
    instruction: "",
    title: "",
    repeat: "weekdays",
    time: "09:00",
    weekday: "1",
    monthDay: "1",
    channelId:
      presetChannelId && presetAgentId ? presetChannelId : NEW_CONVERSATION,
  };

  const form = useForm({
    defaultValues,
    validators: { onSubmit: routineFormSchema },
    onSubmit: async ({ value }) => {
      await createRoutine.mutateAsync({
        agentId: value.agentId,
        instruction: value.instruction.trim(),
        ...(value.title.trim() ? { title: value.title.trim() } : {}),
        cron: cronFrom(value),
        timezone: timeZone,
        channelId: value.channelId,
      });
      await navigate({ to: "/routines" });
    },
  });

  const botItems = Object.fromEntries(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  ) as Record<string, string>;

  return (
    <PageShell
      backButton={{ label: "Routines", linkProps: { to: "/routines" } }}
      description="Pick a Bot, say what it should do, and choose when. It posts what it did in a conversation with you."
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
              <Button
                render={(props) => <Link {...props} to="/routines" />}
                variant="outline"
              >
                Cancel
              </Button>
              <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting]}
              >
                {([canSubmit, isSubmitting]) => (
                  <Button
                    disabled={
                      !canSubmit || isSubmitting || createRoutine.isPending
                    }
                    type="submit"
                  >
                    {isSubmitting || createRoutine.isPending
                      ? "Creating…"
                      : "Create routine"}
                  </Button>
                )}
              </form.Subscribe>
            </>
          }
        >
          <FieldGroup>
            <form.Field name="agentId">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Bot</FieldLabel>
                    <Select
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
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="instruction">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>What to do</FieldLabel>
                    <FieldDescription>
                      Write it as one run of the work. Leave the schedule out.
                    </FieldDescription>
                    <Textarea
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
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>

            <Field>
              <FieldLabel htmlFor="repeat">When</FieldLabel>
              <div className="flex flex-wrap gap-3">
                <form.Field name="repeat">
                  {(field) => (
                    <Select
                      items={REPEAT_LABEL}
                      onValueChange={(value) =>
                        field.handleChange(value as Repeat)
                      }
                      value={field.state.value}
                    >
                      <SelectTrigger className="min-w-40 flex-1" id="repeat">
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
                <form.Subscribe selector={(state) => state.values.repeat}>
                  {(repeat) => (
                    <>
                      {repeat === "weekly" ? (
                        <form.Field name="weekday">
                          {(field) => (
                            <Select
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
                                  {WEEKDAY_LABEL.map((label, index) => (
                                    <SelectItem
                                      key={label}
                                      value={String(index)}
                                    >
                                      {label}
                                    </SelectItem>
                                  ))}
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
                          {(field) => (
                            <Input
                              aria-label="Time"
                              className="w-32"
                              onChange={(event) =>
                                field.handleChange(event.target.value)
                              }
                              step={900}
                              type="time"
                              value={field.state.value}
                            />
                          )}
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
                    , your time ({timeZone}). For anything else, like every
                    other Tuesday, ask the Bot in a conversation.
                  </FieldDescription>
                )}
              </form.Subscribe>
            </Field>

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
                          disabled={!agentId}
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
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                    <FieldDescription>
                      Optional. The Routines page shows it by this name.
                    </FieldDescription>
                    <Input
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
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>
          {createRoutine.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {createRoutine.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}
