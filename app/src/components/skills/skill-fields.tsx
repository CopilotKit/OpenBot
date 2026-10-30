import { useForm } from "@tanstack/react-form";
import { Fragment, useRef, useState } from "react";
import {
  PageCard,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  SkillToolApps,
  SkillToolStep,
  scrollParent,
  TOOLS_EXPLAINED,
  type ToolSource,
} from "@/components/skills/skill-tools";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { type SkillFormValues, skillFormSchema } from "@/lib/skills/form";

/**
 * The four things a person decides about a skill: what they type, what it is called, what it is
 * for, and what the Bot is actually told.
 *
 * Written as its own component rather than inline in a screen because creating and editing a skill
 * are the same four fields. Laid out a section per part of the skill, each in its own container, the
 * way Linear lays out a settings screen, with the buttons under the last.
 */
export function SkillFields({
  defaultValues,
  submitLabel,
  onSubmit,
  error,
  onCancel,
  beforeActions,
  afterForm,
  slugLocked = false,
}: {
  defaultValues: SkillFormValues;
  submitLabel: string;
  onSubmit: (values: SkillFormValues) => Promise<unknown>;
  error?: Error | null;
  onCancel?: () => void;
  /** Sections that belong to the form and come before its buttons. */
  beforeActions?: React.ReactNode;
  /**
   * Sections after the form and its buttons, for anything that saves on its own — granting, deleting.
   * Outside the form on purpose: what sits after Save is visibly not waiting for it.
   */
  afterForm?: React.ReactNode;
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

  /*
   * The app whose tools are showing, in place of the fields. A step inside the form rather than a
   * route of its own, so nothing typed above has to survive a navigation, and rather than a dialog,
   * because one app can offer eighty tools and a dialog is the wrong size for a list that long.
   */
  const [toolStep, setToolStep] = useState<ToolSource | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldsScroll = useRef(0);

  /*
   * A step starts with the page at its top, where its list is sized to fit, and the fields come back
   * scrolled to where the list of apps was, so the person returns to the row they opened rather than
   * to the Command field.
   */
  const goTo = (next: ToolSource | null) => {
    const scroller = scrollParent(formRef.current);
    if (toolStep === null) fieldsScroll.current = scroller?.scrollTop ?? 0;
    setToolStep(next);
    requestAnimationFrame(() => {
      if (scroller)
        scroller.scrollTop = next === null ? fieldsScroll.current : 0;
    });
  };

  /*
   * The Details card: one settings row each for what you type, what it is called and
   * what it is for, the label and its hint on the left and the control on the right, as Linear draws
   * a settings screen. A field's error takes the hint's place, so a row never grows a third line.
   */
  const settingsRows = [
    {
      key: "slug",
      node: (
        <form.Field name="slug">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <SettingsRow
                error={isInvalid ? field.state.meta.errors : undefined}
                hint={
                  slugLocked
                    ? "Can't be changed. To rename it, write a new skill and delete this one."
                    : "What you type after a slash to use it."
                }
                htmlFor={slugLocked ? undefined : field.name}
                label="Command"
              >
                {slugLocked ? (
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-sm">
                    /{field.state.value}
                  </code>
                ) : (
                  <InputGroup className="w-full sm:w-72">
                    <InputGroupAddon>/</InputGroupAddon>
                    <InputGroupInput
                      aria-invalid={isInvalid}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      /*
                       * Lower-cased as they type rather than refused afterwards. The server's
                       * pattern has no capitals in it, and "Standup" is a reasonable thing to type
                       * and a pointless thing to be told off for.
                       */
                      onChange={(event) =>
                        field.handleChange(event.target.value.toLowerCase())
                      }
                      placeholder="standup"
                      value={field.state.value}
                    />
                  </InputGroup>
                )}
              </SettingsRow>
            );
          }}
        </form.Field>
      ),
    },
    {
      key: "title",
      node: (
        <form.Field name="title">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <SettingsRow
                error={isInvalid ? field.state.meta.errors : undefined}
                hint="What it's called in your list of skills."
                htmlFor={field.name}
                label="Title"
              >
                <Input
                  aria-invalid={isInvalid}
                  className="w-full sm:w-72"
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="My standup skill"
                  value={field.state.value}
                />
              </SettingsRow>
            );
          }}
        </form.Field>
      ),
    },
    {
      key: "summary",
      node: (
        <form.Field name="summary">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <SettingsRow
                error={isInvalid ? field.state.meta.errors : undefined}
                hint="Shown beside the command here and in the / menu. Optional."
                htmlFor={field.name}
                label="One-liner"
              >
                <Input
                  aria-invalid={isInvalid}
                  className="w-full sm:w-72"
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Turns yesterday's work into a standup"
                  value={field.state.value}
                />
              </SettingsRow>
            );
          }}
        </form.Field>
      ),
    },
  ];

  const submit = (
    <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
      {([canSubmit, isSubmitting]) => (
        <Button disabled={!canSubmit || isSubmitting} type="submit">
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      )}
    </form.Subscribe>
  );

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    /*
     * Not from a step. Enter in its search box is an implicit submit, and saving the skill from
     * there would save fields the person cannot see, or fail on one they cannot reach.
     */
    if (toolStep !== null) return;
    form.handleSubmit();
  };

  const step =
    toolStep === null ? null : (
      <form.Field name="tools">
        {(field) => (
          <SkillToolStep
            key={toolStep}
            onChange={field.handleChange}
            selected={field.state.value}
            source={toolStep}
          />
        )}
      </form.Field>
    );

  /*
   * Both return to the fields, because a tick is already in the form; there is nothing on a step to
   * keep or throw away. Done is there so the step ends on a confirmation like every other one.
   */
  const leaveStep = () => goTo(null);

  const stepping = toolStep !== null;
  return (
    <>
      <form noValidate onSubmit={handleSubmit} ref={formRef}>
        {stepping ? (
          <PageCard
            footer={
              <>
                <Button onClick={leaveStep} type="button" variant="outline">
                  Back
                </Button>
                <Button onClick={leaveStep} type="button">
                  Done
                </Button>
              </>
            }
          >
            {step}
          </PageCard>
        ) : null}

        {/*
         * Hidden rather than unmounted while a step shows, so every field comes back exactly as
         * it was left: what was typed, what was touched, which error was showing.
         */}
        <div hidden={stepping}>
          {/* No gap above the first: the page title already stands 32px over it. */}
          <PageSection className="mt-0" title="Details">
            <PageRows>
              {settingsRows.map((row, index) => (
                <Fragment key={row.key}>
                  {index > 0 ? <Separator /> : null}
                  {row.node}
                </Fragment>
              ))}
            </PageRows>
          </PageSection>

          <form.Field name="instructions">
            {(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <PageSection
                  description="What the Bot is told when you use the command. Write it as instructions to the Bot."
                  title="Instructions"
                >
                  <Textarea
                    aria-invalid={isInvalid}
                    aria-label="Instructions"
                    className="mt-4 min-h-48 bg-card"
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="Summarise what I did yesterday in this conversation, then list what is left."
                    value={field.state.value}
                  />
                  {isInvalid ? (
                    <FieldError
                      className="mt-2"
                      errors={field.state.meta.errors}
                    />
                  ) : null}
                </PageSection>
              );
            }}
          </form.Field>

          <PageSection description={TOOLS_EXPLAINED} title="Tools">
            <form.Field name="tools">
              {(field) => (
                <SkillToolApps onOpen={goTo} selected={field.state.value} />
              )}
            </form.Field>
          </PageSection>

          {beforeActions}

          {error ? (
            <p className="mt-6 text-destructive text-sm" role="alert">
              {error.message}
            </p>
          ) : null}

          <div className="mt-8 flex justify-end gap-2">
            {onCancel ? (
              <Button onClick={onCancel} type="button" variant="outline">
                Cancel
              </Button>
            ) : null}
            {submit}
          </div>
        </div>
      </form>
      {afterForm ? <div hidden={stepping}>{afterForm}</div> : null}
    </>
  );
}

/** One row of the Details card: the label and its hint, or its error, beside the control. */
function SettingsRow({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint: string;
  error?: React.ComponentProps<typeof FieldError>["errors"];
  /** The control's id, so pressing the label focuses it. Absent for a value that is only shown. */
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <Item data-invalid={error ? true : undefined} size="sm">
      <ItemContent className="min-w-0">
        <ItemTitle>
          {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
        </ItemTitle>
        {error ? (
          <FieldError errors={error} />
        ) : (
          <ItemDescription>{hint}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions className="w-full sm:w-auto">{children}</ItemActions>
    </Item>
  );
}
