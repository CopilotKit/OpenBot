import { useSelector } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import {
  ScheduleWhen,
  useRoutineForm,
} from "@/components/routines/schedule-when";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { UpdateRoutineRequest } from "@/lib/api/generated/model";
import {
  browserTimeZone,
  cronFrom,
  ROUTINE_FORM_DEFAULTS,
  type RoutineFormValues,
  routineFormSchema,
  scheduleFrom,
} from "@/lib/routines/form";
import { updateRoutineMutationOptions } from "@/lib/routines/mutations";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

/** The fields this dialog draws, each with the first rule its answer breaks. */
type Edited = "title" | "instruction" | "time";
type Messages = Partial<Record<Edited, string>>;

const EDITED: readonly Edited[] = ["title", "instruction", "time"];

/** The rules New routine holds a routine on, for the fields this dialog draws. */
function brokenRules(values: RoutineFormValues): Messages {
  const messages: Messages = {};
  const parsed = routineFormSchema.safeParse(values);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const name = issue.path[0] as Edited;
      if (EDITED.includes(name)) messages[name] ??= issue.message;
    }
  return messages;
}

function sameMessages(a: Messages, b: Messages): boolean {
  const names = Object.keys(a) as Edited[];
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => a[name] === b[name])
  );
}

/**
 * Every time zone the browser knows, with the routine's own and the person's first. A zone the
 * browser doesn't list (an older alias the routine was saved with) is still offered, so opening the
 * dialog never changes it.
 */
function timeZones(current: string): string[] {
  let known: string[] = [];
  try {
    known = Intl.supportedValuesOf("timeZone");
  } catch {
    known = [];
  }
  return [...new Set([current, browserTimeZone(), "UTC", ...known])];
}

/**
 * Edit routine: its name, what the Bot does, when it runs and the time zone that's read in. The same
 * fields and the same schedule picker as New routine, prefilled with what it is now. Saving changes
 * only what was changed, and the routine keeps its id, its conversation and its runs.
 *
 * A schedule the picker can't express (a Bot wrote "every other Tuesday") is offered first, by the
 * words its row uses, and kept unless another is picked. A routine that runs a goal does what its
 * goal says, so it has no What to do here.
 */
export function EditRoutineDialog({
  routine,
  open,
  onOpenChange,
}: {
  routine: RoutineRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit routine</DialogTitle>
          <DialogDescription>
            It keeps its runs and its conversation.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so each one starts from the routine as it is now. */}
        {open ? (
          <EditRoutineForm
            onDone={() => onOpenChange(false)}
            routine={routine}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditRoutineForm({
  routine,
  onDone,
}: {
  routine: RoutineRecord;
  onDone: () => void;
}) {
  const formId = useId();
  const update = useMutation(updateRoutineMutationOptions(queryClient));
  // Taken once, when the dialog opened: a refetch landing while it is open must not reset the answers.
  const [opened] = useState(() => {
    const schedule = scheduleFrom(routine.cron);
    return {
      schedule,
      values: {
        ...ROUTINE_FORM_DEFAULTS,
        ...(schedule ?? {}),
        agentId: routine.botId,
        channelId: routine.conversation.id,
        instruction: routine.instruction,
        title: routine.title ?? "",
      } satisfies RoutineFormValues,
    };
  });
  const [keeping, setKeeping] = useState(opened.schedule === null);
  const [timeZone, setTimeZone] = useState(routine.timezone);
  const [zones] = useState(() => timeZones(routine.timezone));
  const runsGoal = routine.goalId !== null;

  const form = useRoutineForm(opened.values, async (value) => {
    if (Object.keys(brokenRules(value)).length > 0) return;
    const changes: UpdateRoutineRequest = {};
    const title = value.title.trim();
    if (title !== (routine.title ?? "")) changes.title = title;
    const instruction = value.instruction.trim();
    if (!runsGoal && instruction !== routine.instruction)
      changes.instruction = instruction;
    if (!keeping) {
      const cron = cronFrom(value);
      if (cron !== routine.cron) changes.cron = cron;
    }
    if (timeZone !== routine.timezone) changes.timezone = timeZone;
    // Nothing changed is not a save: close as Cancel would.
    if (Object.keys(changes).length === 0) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync({ id: routine.id, changes });
    } catch {
      // Said under the fields, from `update.error`. Staying open says it wasn't saved.
      return;
    }
    onDone();
  });

  // A message shows once its field was worked on, or on every field once Save was pressed.
  const shown = useSelector(
    form.store,
    (state) => {
      const pressed = state.submissionAttempts > 0;
      const messages: Messages = {};
      for (const [name, message] of Object.entries(
        brokenRules(state.values),
      ) as [Edited, string][])
        if (pressed || state.fieldMeta[name]?.isTouched)
          messages[name] = message;
      return messages;
    },
    { compare: sameMessages },
  );

  // Each press of Save with a message showing moves focus to the first field that has one.
  const formRef = useRef<HTMLFormElement>(null);
  const attempts = useSelector(form.store, (state) => state.submissionAttempts);
  const focusedFor = useRef(0);
  useEffect(() => {
    if (attempts === focusedFor.current) return;
    focusedFor.current = attempts;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [attempts]);

  const saving = update.isPending;
  return (
    <>
      <DialogBody className="mt-4">
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving) void form.handleSubmit();
          }}
          ref={formRef}
        >
          <FieldGroup>
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
                      aria-describedby={
                        isInvalid ? `${field.name}-error` : undefined
                      }
                      aria-invalid={isInvalid}
                      disabled={saving}
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
                      <FieldError id={`${field.name}-error`}>
                        {shown[field.name]}
                      </FieldError>
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>

            {runsGoal ? null : (
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
                        aria-describedby={
                          isInvalid ? `${field.name}-error` : undefined
                        }
                        aria-invalid={isInvalid}
                        disabled={saving}
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
                        <FieldError id={`${field.name}-error`}>
                          {shown[field.name]}
                        </FieldError>
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
            )}

            <ScheduleWhen
              describe={
                keeping ? ". Pick another to change it." : `, ${timeZone} time.`
              }
              disabled={saving}
              form={form}
              keep={
                opened.schedule === null
                  ? {
                      words: routine.schedule,
                      keeping,
                      onKeepingChange: (next) => {
                        setKeeping(next);
                        update.reset();
                      },
                    }
                  : undefined
              }
              label="Schedule"
              timeError={shown.time}
            />

            <Field>
              <FieldLabel htmlFor="timezone">Time zone</FieldLabel>
              <Combobox
                autoHighlight
                disabled={saving}
                items={zones}
                onValueChange={(value: string | null) => {
                  if (value) setTimeZone(value);
                  update.reset();
                }}
                value={timeZone}
              >
                <ComboboxInput
                  className="w-full"
                  disabled={saving}
                  id="timezone"
                  placeholder="Search time zones"
                />
                <ComboboxContent>
                  <ComboboxEmpty>No matches.</ComboboxEmpty>
                  <ComboboxList>
                    {(zone: string) => (
                      <ComboboxItem key={zone} value={zone}>
                        {zone}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <FieldDescription>
                The schedule's times are read in this time zone.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
        {update.error ? (
          <p className="text-destructive text-sm" role="alert">
            {failureSaid(update.error)}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button
          disabled={saving}
          onClick={onDone}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button disabled={saving} form={formId} size="sm" type="submit">
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </>
  );
}
