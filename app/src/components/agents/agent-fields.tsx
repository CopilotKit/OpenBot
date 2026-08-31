import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { type AgentFormValues, agentFormSchema } from "@/lib/agents/form";
import {
  type ConnectionVerdict,
  testAgentConnection,
} from "@/lib/agents/queries";

/** The two ways a coworker can be seen, as a card each. */
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

export function AgentFields({
  defaultValues,
  hasAuth = false,
  submitLabel,
  onSubmit,
  error,
  onCancel,
}: {
  defaultValues: AgentFormValues;
  /** Whether this coworker already has a key, so the field can say so without showing it. */
  hasAuth?: boolean;
  submitLabel: string;
  onSubmit: (values: AgentFormValues) => Promise<unknown>;
  error?: Error | null;
  onCancel?: () => void;
}) {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: agentFormSchema },
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });

  const [connection, setConnection] = useState<ConnectionVerdict | null>(null);
  const [testing, setTesting] = useState(false);

  /** Test endpoint reachability from the server, which is what runs will use. */
  const testConnection = async (endpoint: string, key: string) => {
    setTesting(true);
    setConnection(null);
    try {
      setConnection(await testAgentConnection(endpoint, key));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="name">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Expense Manager"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
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
                  placeholder="Finance Operations"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="roleDescription">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Role</FieldLabel>
                <Textarea
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Review receipts, categorize expenses, and prepare reimbursement reports."
                  rows={4}
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="visibility">
          {(field) => (
            <Field>
              <FieldLabel>Visibility</FieldLabel>
              <RadioGroup
                className="grid-cols-2 gap-3"
                onValueChange={(value) =>
                  field.handleChange(value as AgentFormValues["visibility"])
                }
                value={field.state.value}
              >
                {VISIBILITY_OPTIONS.map((option) => (
                  <label
                    className="flex cursor-pointer flex-col gap-1 rounded-lg border border-border bg-card p-3 transition-colors has-data-checked:border-primary has-data-checked:ring-2 has-data-checked:ring-primary/30"
                    htmlFor={`visibility-${option.value}`}
                    key={option.value}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm">
                        {option.title}
                      </span>
                      <RadioGroupItem
                        id={`visibility-${option.value}`}
                        value={option.value}
                      />
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {option.description}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </Field>
          )}
        </form.Field>
        <form.Field name="endpoint">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>
                  Agent endpoint (optional)
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    aria-invalid={isInvalid}
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      setConnection(null);
                      field.handleChange(event.target.value);
                    }}
                    placeholder="https://your-agent.example.com/ag-ui"
                    value={field.state.value}
                  />
                  <Button
                    disabled={!field.state.value || testing}
                    onClick={() =>
                      void testConnection(
                        field.state.value,
                        form.getFieldValue("authValue") ?? "",
                      )
                    }
                    type="button"
                    variant="outline"
                  >
                    {testing ? "Testing…" : "Test"}
                  </Button>
                </div>
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
                {connection ? (
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
                    Leave empty to use the built-in Bot. Anything that speaks
                    AG-UI works. This server dials your agent, so an agent on
                    your own machine has to be reachable from here.
                  </p>
                )}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="authValue">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>
                Key for that agent (optional)
              </FieldLabel>
              <Input
                autoComplete="off"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={
                  hasAuth
                    ? "A key is set. Type a new one to replace it."
                    : "Bearer …"
                }
                // Never repopulated; `hasAuth` communicates that a key exists without exposing it.
                type="password"
                value={field.state.value}
              />
              <p className="text-muted-foreground text-sm">
                Sent as an <code>Authorization</code> header on every run, and
                kept in the credential vault. Leave empty to keep the current
                key.
              </p>
            </Field>
          )}
        </form.Field>
      </FieldGroup>

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
