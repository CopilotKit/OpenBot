import { useForm } from "@tanstack/react-form";
import type { ReactNode } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
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
import {
  MONTH_DAYS,
  REPEAT_LABEL,
  REPEATS,
  type Repeat,
  type RoutineFormValues,
  scheduleSentence,
  WEEKDAY_LABEL,
} from "@/lib/routines/form";

/**
 * The form New routine and Edit routine both fill in: the same answers, so the schedule picker below
 * is one component and reads the same on both. Only the default values and what Save does differ.
 */
export function useRoutineForm(
  defaultValues: RoutineFormValues,
  onSubmit: (value: RoutineFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues,
    onSubmit: ({ value }) => onSubmit(value),
  });
}

export type RoutineForm = ReturnType<typeof useRoutineForm>;

const MONTH_DAY_LABEL = Object.fromEntries(
  MONTH_DAYS.map((day) => [day, day]),
) as Record<string, string>;

const WEEKDAY_ITEMS = Object.fromEntries(
  WEEKDAY_LABEL.map((label, index) => [String(index), label]),
) as Record<string, string>;

/** The When picker's choice that keeps a schedule it can't show, until another is picked. */
const KEEP = "keep";

/**
 * When a routine runs: how often, the day where that asks for one, and the time, read back as a
 * sentence under it ("Every weekday at 9:00 AM").
 *
 * `keep` is for Edit routine, when the routine's schedule is one the picker can't express (a Bot
 * wrote "every other Tuesday"): the picker offers it first, by the words its row uses, and while it
 * is chosen nothing about the schedule changes. Picking any other choice replaces it.
 */
export function ScheduleWhen({
  form,
  disabled,
  timeError,
  describe,
  keep,
  label = "When",
}: {
  form: RoutineForm;
  /** The picker's label: When on New routine, Schedule where it changes one. */
  label?: string;
  disabled: boolean;
  /** What the time breaks, once the person worked on it or pressed save. */
  timeError?: string;
  /** What follows the sentence under the picker: where the time is read, and anything else to say. */
  describe: ReactNode;
  keep?: {
    /** The schedule as its row says it. */
    words: string;
    keeping: boolean;
    onKeepingChange: (keeping: boolean) => void;
  };
}) {
  const keeping = keep?.keeping === true;
  const repeatItems: Record<string, string> = keep
    ? { [KEEP]: keep.words, ...REPEAT_LABEL }
    : REPEAT_LABEL;
  return (
    <Field>
      <FieldLabel htmlFor="repeat">{label}</FieldLabel>
      <div className="flex flex-wrap gap-3">
        <form.Field name="repeat">
          {(field) => (
            <Select
              disabled={disabled}
              items={repeatItems}
              onValueChange={(value) => {
                if (value === KEEP) {
                  keep?.onKeepingChange(true);
                  return;
                }
                keep?.onKeepingChange(false);
                field.handleChange(value as Repeat);
              }}
              value={keeping ? KEEP : field.state.value}
            >
              <SelectTrigger className="min-w-40 flex-1" id="repeat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {keep ? (
                    <SelectItem value={KEEP}>{keep.words}</SelectItem>
                  ) : null}
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
        {keeping ? null : (
          <form.Subscribe selector={(state) => state.values.repeat}>
            {(repeat) => (
              <>
                {repeat === "weekly" ? (
                  <form.Field name="weekday">
                    {(field) => (
                      <Select
                        disabled={disabled}
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
                              <SelectItem key={label} value={String(index)}>
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
                        disabled={disabled}
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
                      <>
                        <Input
                          disabled={disabled}
                          aria-invalid={timeError !== undefined}
                          aria-describedby={
                            timeError !== undefined ? "time-error" : undefined
                          }
                          aria-label="Time"
                          className="w-32"
                          onBlur={field.handleBlur}
                          onChange={(event) =>
                            field.handleChange(event.target.value)
                          }
                          step={900}
                          type="time"
                          value={field.state.value}
                        />
                        {timeError !== undefined ? (
                          <FieldError id="time-error">{timeError}</FieldError>
                        ) : null}
                      </>
                    )}
                  </form.Field>
                )}
              </>
            )}
          </form.Subscribe>
        )}
      </div>
      <form.Subscribe selector={(state) => state.values}>
        {(values) => (
          <FieldDescription>
            <span className="font-medium text-foreground">
              {keeping && keep ? keep.words : scheduleSentence(values)}
            </span>
            {describe}
          </FieldDescription>
        )}
      </form.Subscribe>
    </Field>
  );
}
