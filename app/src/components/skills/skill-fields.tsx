import { useForm } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type SkillFormValues, skillFormSchema } from "@/lib/skills/form";

/**
 * The four things a person decides about a skill: what they type, what it is called, what it is
 * for, and what the Bot is actually told.
 *
 * Written as its own component rather than inline in the panel because creating and editing a skill
 * are the same four fields, and the second one is coming — a skill whose instructions can only be
 * set once is a skill nobody will correct.
 */
export function SkillFields({
  defaultValues,
  submitLabel,
  onSubmit,
  error,
  onCancel,
  footer,
  slugLocked = false,
}: {
  defaultValues: SkillFormValues;
  submitLabel: string;
  onSubmit: (values: SkillFormValues) => Promise<unknown>;
  error?: Error | null;
  onCancel?: () => void;
  /** Anything that belongs with the skill but saves on its own, shown above the submit button. */
  footer?: React.ReactNode;
  /**
   * Editing, where the command cannot change.
   *
   * THE SLUG IS THE KEY, so saving under a different one would not rename anything: it would write a
   * SECOND skill and leave the first behind, and the person would be looking at a duplicate they did
   * not ask for. Renaming is a create and a delete, which is a decision rather than a typo, so the
   * field is read-only here and the form says why.
   */
  slugLocked?: boolean;
}) {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: skillFormSchema },
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="slug">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Command</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  disabled={slugLocked}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  /*
                   * Lower-cased as they type rather than refused afterwards. The server's pattern
                   * has no capitals in it, and "Standup" is a reasonable thing to type and a
                   * pointless thing to be told off for.
                   */
                  onChange={(event) =>
                    field.handleChange(event.target.value.toLowerCase())
                  }
                  placeholder="standup"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {slugLocked ? (
                      "A command cannot be changed. To rename a skill, write a new one and delete this."
                    ) : (
                      <>
                        What you type after a slash.{" "}
                        <code>
                          /{"{"}command{"}"}
                        </code>
                      </>
                    )}
                  </p>
                )}
              </Field>
            );
          }}
        </form.Field>

        <form.Field name="title">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Title</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="My standup skill"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>

        <form.Field name="summary">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>One-liner</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Turns yesterday's work into a standup update"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Shown beside the command in this list and in the{" "}
                    <code>/</code> menu. Optional.
                  </p>
                )}
              </Field>
            );
          }}
        </form.Field>

        <form.Field name="instructions">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Instructions</FieldLabel>
                <Textarea
                  aria-invalid={isInvalid}
                  className="min-h-40"
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Summarise what I did yesterday from the channel, then list what is left."
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Added to the run when the command is used. Write it as
                    instructions to the Bot, not as a description of them.
                  </p>
                )}
              </Field>
            );
          }}
        </form.Field>
      </FieldGroup>

      {/*
       * Rendered by the caller, between the fields and the buttons, so granting sits with the rest
       * of the skill rather than after the point where the form is finished with.
       *
       * IT IS NOT PART OF THE FORM'S STATE. Each toggle saves the moment it is pressed, while
       * everything above waits for the submit button — so it must not look like a field, and
       * pressing one is never undone by closing the panel without saving.
       */}
      {footer ? <div className="mt-6">{footer}</div> : null}

      {error ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, isSubmitting]) => (
            <Button disabled={!canSubmit || isSubmitting} type="submit">
              {isSubmitting ? "Saving…" : submitLabel}
            </Button>
          )}
        </form.Subscribe>
        {onCancel ? (
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
