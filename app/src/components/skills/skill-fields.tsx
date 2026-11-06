import { useForm } from "@tanstack/react-form";
import { PageCard, PageSection } from "@/components/layout/page-shell";
import { SkillTools } from "@/components/skills/skill-tools";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type SkillFormValues, skillFormSchema } from "@/lib/skills/form";
import { cn } from "@/lib/utils";

const TOOLS_HINT =
  "Using this skill loads these tools for that reply. It doesn't give access. A Bot only uses tools it already has.";

/**
 * The things a person decides about a skill: what they type, what it is called, what it is for,
 * what the Bot is told, and which tools it needs.
 *
 * Two layouts of the same form. In the Capabilities panel it is one stacked column. On a page of its
 * own (`sections`) it is three sections, Name, Instructions and Tools: the name's fields in a card,
 * the instructions as one text box, and the tools as rows, with Cancel and the submit button below.
 */
export function SkillFields({
  defaultValues,
  submitLabel,
  onSubmit,
  error,
  onCancel,
  footer,
  sections,
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
   * On a page of its own: one `PageSection` per part, with `cancel` beside the submit button.
   * `flush` drops the first section's top margin when the form is the page's first content, since
   * `PageShell` already spaces the title from it.
   */
  sections?: { cancel?: React.ReactNode; flush?: boolean };
  /**
   * Editing, where the command cannot change.
   *
   * THE SLUG IS THE KEY, so saving under a different one would not rename anything: it would write a
   * SECOND skill and leave the first behind. Renaming is a create and a delete, which is a decision
   * rather than a typo, so the field is read-only here and the form says why.
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

  const slugField = (
    <form.Field name="slug">
      {(field) => {
        const isInvalid =
          field.state.meta.isTouched && !field.state.meta.isValid;
        return (
          <Field data-invalid={isInvalid}>
            <FieldLabel htmlFor={field.name}>Command</FieldLabel>
            <Input
              aria-invalid={isInvalid}
              className={sections ? "font-mono" : undefined}
              disabled={slugLocked}
              id={field.name}
              name={field.name}
              onBlur={field.handleBlur}
              /*
               * Lower-cased as they type rather than refused afterwards. The server's pattern has no
               * capitals in it, and "Standup" is a reasonable thing to type.
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
              <FieldDescription>
                {slugLocked ? (
                  "You can't change a command. To rename this skill, write a new one and delete this one."
                ) : (
                  <>
                    What people type after <code>/</code>. Lower-case letters,
                    numbers and hyphens.
                  </>
                )}
              </FieldDescription>
            )}
          </Field>
        );
      }}
    </form.Field>
  );

  const titleField = (
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
              placeholder="Standup notes"
              value={field.state.value}
            />
            {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
          </Field>
        );
      }}
    </form.Field>
  );

  const summaryField = (
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
              <FieldDescription>
                Shown beside the command in the <code>/</code> menu. Optional.
              </FieldDescription>
            )}
          </Field>
        );
      }}
    </form.Field>
  );

  const instructionsField = (
    <form.Field name="instructions">
      {(field) => {
        const isInvalid =
          field.state.meta.isTouched && !field.state.meta.isValid;
        return (
          <Field data-invalid={isInvalid}>
            {/* On a page the section heading names it, so the label is for screen readers only. */}
            <FieldLabel
              className={sections ? "sr-only" : undefined}
              htmlFor={field.name}
            >
              Instructions
            </FieldLabel>
            <Textarea
              aria-invalid={isInvalid}
              className={sections ? "min-h-56" : "min-h-40"}
              id={field.name}
              name={field.name}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="Summarise what I did yesterday in this conversation, then list what is left."
              value={field.state.value}
            />
            {isInvalid ? (
              <FieldError errors={field.state.meta.errors} />
            ) : sections ? null : (
              <FieldDescription>
                What the Bot is told when you use the command. Write it as
                instructions to the Bot.
              </FieldDescription>
            )}
          </Field>
        );
      }}
    </form.Field>
  );

  const toolsField = (
    <form.Field name="tools">
      {(field) => (
        <SkillTools
          onChange={field.handleChange}
          selected={field.state.value}
        />
      )}
    </form.Field>
  );

  const submit = (
    <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
      {([canSubmit, isSubmitting]) => (
        <Button disabled={!canSubmit || isSubmitting} type="submit">
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      )}
    </form.Subscribe>
  );

  const failure = error ? (
    <p className="mt-4 text-sm text-destructive" role="alert">
      {error.message}
    </p>
  ) : null;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      {sections ? (
        <>
          <PageSection
            className={cn(sections.flush && "mt-0")}
            description="How the skill shows in the / menu, and what people type to run it."
            title="Name"
          >
            <PageCard className="mt-4">
              <FieldGroup>
                {titleField}
                {slugField}
                {summaryField}
              </FieldGroup>
            </PageCard>
          </PageSection>

          <PageSection
            description="What the Bot is told when someone uses this skill. Write it as instructions to the Bot."
            title="Instructions"
          >
            {/* The box alone: a card around one text box is a frame around a frame. */}
            <div className="mt-4">{instructionsField}</div>
          </PageSection>

          <PageSection description={TOOLS_HINT} title="Tools">
            {toolsField}
          </PageSection>

          {failure}
          <div className="mt-8 flex justify-end gap-2">
            {sections.cancel}
            {submit}
          </div>
        </>
      ) : (
        <>
          <FieldGroup>
            {slugField}
            {titleField}
            {summaryField}
            {instructionsField}
            <Field>
              <FieldLabel>Tools it needs</FieldLabel>
              {toolsField}
              <FieldDescription>{TOOLS_HINT}</FieldDescription>
            </Field>
          </FieldGroup>
          {/*
           * Rendered by the caller, between the fields and the buttons, so granting sits with the
           * rest of the skill. IT IS NOT PART OF THE FORM'S STATE: each toggle saves the moment it is
           * pressed, so it must not look like a field.
           */}
          {footer ? <div className="mt-6">{footer}</div> : null}
          {failure}
          <div className="mt-4 flex justify-end gap-2">
            {onCancel ? (
              <Button onClick={onCancel} type="button" variant="outline">
                Cancel
              </Button>
            ) : null}
            {submit}
          </div>
        </>
      )}
    </form>
  );
}
