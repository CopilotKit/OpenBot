import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame } from "./frame";

const Field = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
      .describe("Unique key returned with the answer"),
    label: z.string().trim().min(1).max(100),
    type: z.enum(["text", "email", "number", "select", "textarea"]),
    required: z.boolean().optional(),
    help: z.string().max(250).optional(),
    options: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .optional()
      .describe("Required for select fields"),
    min: z.number().optional().describe("Minimum for a number field"),
    max: z.number().optional().describe("Maximum for a number field"),
  })
  .refine(
    (field) =>
      (field.type !== "select" || Boolean(field.options?.length)) &&
      (!field.options ||
        new Set(field.options).size === field.options.length) &&
      (field.min === undefined ||
        field.max === undefined ||
        field.min <= field.max),
    "Select fields need unique options; minimum must not exceed maximum",
  );

export const FormCardArgs = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(500).optional(),
    fields: z.array(Field).min(1).max(8),
    submitLabel: z.string().trim().min(1).max(40).optional(),
  })
  .refine(
    (form) =>
      new Set(form.fields.map((field) => field.id)).size === form.fields.length,
    "Field IDs must be unique",
  );

const Submitted = z.object({
  status: z.literal("submitted"),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
});
type FormArgs = z.infer<typeof FormCardArgs>;
type FormAnswer = z.infer<typeof Submitted>;
type Respond = (
  answer: FormAnswer | { status: "invalid"; message: string },
) => Promise<void>;

function isRespond(value: unknown): value is Respond {
  return typeof value === "function";
}
function readAnswer(result: unknown): FormAnswer | null {
  try {
    const parsed = Submitted.safeParse(
      typeof result === "string" ? JSON.parse(result) : result,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Decision render props remain wrapped, just like askApproval and askChoice. */
export function FormCard(props: Record<string, unknown>) {
  const parsed = FormCardArgs.safeParse(props.args);
  if (props.status === "inProgress") {
    return (
      <GalleryFrame title="Preparing your form…">
        <p className="text-sm text-muted-foreground">
          The assistant is putting the questions together.
        </p>
      </GalleryFrame>
    );
  }
  if (!parsed.success) {
    return (
      <InvalidForm
        complete={props.status === "complete"}
        respond={isRespond(props.respond) ? props.respond : undefined}
      />
    );
  }
  return (
    <FormEntry
      args={parsed.data}
      complete={props.status === "complete"}
      result={readAnswer(props.result)}
      respond={isRespond(props.respond) ? props.respond : undefined}
    />
  );
}

/** A malformed tool call must release the suspended run so the Bot can repair its questions. */
function InvalidForm({
  complete,
  respond,
}: {
  complete: boolean;
  respond?: Respond;
}) {
  const attempted = useRef(false);
  const [failed, setFailed] = useState(false);
  const [returned, setReturned] = useState(complete);
  const returnToBot = useCallback(async () => {
    if (!respond || attempted.current || complete) return;
    attempted.current = true;
    setFailed(false);
    try {
      await respond({
        status: "invalid",
        message:
          "The form could not be displayed because its questions were invalid. Send a corrected form with unique field IDs, valid types, and options for each select field.",
      });
      setReturned(true);
    } catch {
      attempted.current = false;
      setFailed(true);
    }
  }, [respond, complete]);
  useEffect(() => {
    void returnToBot();
  }, [returnToBot]);
  return (
    <GalleryFrame title="Form unavailable">
      <p role="alert" className="text-sm text-muted-foreground">
        {returned
          ? "The form had invalid questions. The Bot can send a corrected form."
          : "The form has invalid questions and could not be displayed."}
      </p>
      {failed && (
        <Button className="mt-3" size="sm" onClick={() => void returnToBot()}>
          Return to the Bot
        </Button>
      )}
    </GalleryFrame>
  );
}

function FormEntry({
  args,
  complete,
  result,
  respond,
}: {
  args: FormArgs;
  complete: boolean;
  result: FormAnswer | null;
  respond?: Respond;
}) {
  const prefix = useId();
  const [values, setValues] = useState(new Map<string, string>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [failure, setFailure] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState<FormAnswer | null>(null);
  const sendingRef = useRef(false);
  const answer = result ?? submitted;
  const finished = complete || answer !== null;

  async function submit(form: HTMLFormElement) {
    if (!respond || sendingRef.current || finished) return;
    const problems = new Map<string, string>();
    const entries: [string, string | number][] = [];
    for (const field of args.fields) {
      const control = form.elements.namedItem(field.id);
      if (control instanceof HTMLInputElement && control.validity.badInput) {
        problems.set(field.id, "Enter a valid number.");
        continue;
      }
      const value = (values.get(field.id) ?? "").trim();
      if (!value) {
        if (field.required)
          problems.set(field.id, `${field.label} is required.`);
        continue;
      }
      if (value.length > 2000)
        problems.set(field.id, "Use 2,000 characters or fewer.");
      else if (field.type === "email" && !z.email().safeParse(value).success)
        problems.set(field.id, "Enter a valid email address.");
      else if (field.type === "select" && !field.options?.includes(value))
        problems.set(field.id, "Choose one of the listed options.");
      else if (field.type === "number") {
        const number = Number(value);
        if (!Number.isFinite(number))
          problems.set(field.id, "Enter a valid number.");
        else if (field.min !== undefined && number < field.min)
          problems.set(field.id, `Enter ${field.min} or more.`);
        else if (field.max !== undefined && number > field.max)
          problems.set(field.id, `Enter ${field.max} or less.`);
      }
      entries.push([field.id, field.type === "number" ? Number(value) : value]);
    }
    setErrors(problems);
    if (problems.size) {
      const firstId = problems.keys().next().value;
      const control = firstId ? form.elements.namedItem(firstId) : null;
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setFailure(false);
    const response: FormAnswer = {
      status: "submitted",
      values: Object.fromEntries(entries),
    };
    try {
      await respond(response);
      setSubmitted(response);
    } catch {
      sendingRef.current = false;
      setFailure(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <GalleryFrame
      title={args.title}
      caption={args.description}
      action={
        <Badge tone={finished ? "positive" : "caution"}>
          {finished ? "Submitted" : "Waiting on you"}
        </Badge>
      }
    >
      {finished ? (
        <div role="status">
          {answer ? (
            <dl className="space-y-3">
              {args.fields.map((field) => (
                <div
                  key={field.id}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 text-sm"
                >
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="whitespace-pre-wrap break-words font-medium">
                    {Object.hasOwn(answer.values, field.id)
                      ? answer.values[field.id]
                      : "Not provided"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              This form has been completed. Its saved answers are unavailable.
            </p>
          )}
        </div>
      ) : (
        <form
          noValidate
          aria-label={args.title}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <p className="text-xs text-muted-foreground">
            Fields marked * are required. Your answers will be shared with the
            Bot.
          </p>
          {args.fields.map((field) => {
            const id = `${prefix}-${field.id}`;
            const error = errors.get(field.id);
            const shared = {
              id,
              name: field.id,
              required: field.required,
              disabled: sending || !respond,
              value: values.get(field.id) ?? "",
              "aria-invalid": Boolean(error),
              "aria-describedby":
                [field.help ? `${id}-help` : "", error ? `${id}-error` : ""]
                  .filter(Boolean)
                  .join(" ") || undefined,
            };
            const change = (value: string) => {
              setValues((current) => new Map(current).set(field.id, value));
              setErrors((current) => {
                const next = new Map(current);
                next.delete(field.id);
                return next;
              });
            };
            return (
              <div key={field.id} className="space-y-1.5">
                <label htmlFor={id} className="block text-sm font-medium">
                  {field.label}
                  {field.required ? (
                    <span
                      aria-hidden="true"
                      className="ml-1 text-muted-foreground"
                    >
                      *
                    </span>
                  ) : null}
                </label>
                {field.type === "textarea" ? (
                  <Textarea
                    {...shared}
                    maxLength={2000}
                    rows={3}
                    onChange={(event) => change(event.target.value)}
                  />
                ) : field.type === "select" ? (
                  <select
                    {...shared}
                    className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                    onChange={(event) => change(event.target.value)}
                  >
                    <option value="">Choose an option</option>
                    {field.options?.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    {...shared}
                    type={field.type}
                    min={field.min}
                    max={field.max}
                    step={field.type === "number" ? "any" : undefined}
                    maxLength={2000}
                    onChange={(event) => change(event.target.value)}
                  />
                )}
                {field.help && (
                  <p
                    id={`${id}-help`}
                    className="text-xs text-muted-foreground"
                  >
                    {field.help}
                  </p>
                )}
                {error && (
                  <p
                    id={`${id}-error`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {error}
                  </p>
                )}
              </div>
            );
          })}
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              Your answers could not be sent. Try again.
            </p>
          )}
          <div className="flex justify-end border-t border-border pt-3">
            <Button type="submit" size="sm" disabled={sending || !respond}>
              {sending ? "Sending…" : (args.submitLabel ?? "Submit answers")}
            </Button>
          </div>
        </form>
      )}
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "askForm",
    title: "Form",
    kind: "decision",
    description:
      "Ask the person to fill in a short form and WAIT for their answers. Use when several related details are needed together. Provide up to eight labeled text, email, number, select, or textarea fields with unique IDs. Mark required fields and give options for selects. Never request passwords or secrets. The result has status submitted and values keyed by field ID; numbers are returned as numbers and blank optional fields are omitted.",
    parameters: FormCardArgs,
    Component: FormCard,
    preview: {
      status: "executing",
      args: {
        title: "Plan your next project",
        description: "A few details to prepare a useful first draft.",
        fields: [
          { id: "team", label: "Team name", type: "text", required: true },
          { id: "email", label: "Work email", type: "email", required: true },
          {
            id: "priority",
            label: "Priority",
            type: "select",
            options: ["This week", "This month", "Exploring"],
          },
          { id: "seats", label: "People involved", type: "number", min: 1 },
          {
            id: "notes",
            label: "What would a good outcome look like?",
            type: "textarea",
          },
        ],
        submitLabel: "Prepare my brief",
      },
      respond: async () => {},
    },
  },
];
