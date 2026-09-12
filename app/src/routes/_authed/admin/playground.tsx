import { OpenGenerativeUIActivityRenderer } from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteSandboxedMutationOptions,
  publishSandboxedMutationOptions,
  type SandboxedDraftInput,
  saveSandboxedDraftMutationOptions,
} from "@/lib/sandboxed/mutations";
import {
  type SandboxedRecord,
  sandboxedListQueryOptions,
} from "@/lib/sandboxed/queries";

/**
 * Browser-authored components are edited as drafts, previewed in the production sandbox renderer,
 * and used by conversations only after publishing.
 */
export const Route = createFileRoute("/_authed/admin/playground")({
  component: PlaygroundPage,
});

const STARTER = {
  slug: "",
  title: "",
  description: "",
  html: `<div class="card">\n  <h3 id="title">Untitled</h3>\n  <p id="body"></p>\n</div>`,
  css: `.card { font: 14px system-ui; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; }\n.card h3 { margin: 0 0 4px; font-size: 15px; }`,
  jsFunctions: `// The arguments are on window.__args by the time this runs.\nconst args = window.__args || {};\ndocument.getElementById("title").textContent = args.title || "Untitled";\ndocument.getElementById("body").textContent = args.body || "";`,
  argumentSchema: `{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" },\n    "body": { "type": "string" }\n  }\n}`,
  sampleArguments: `{\n  "title": "A worked example",\n  "body": "Edit the panels on the left and this redraws."\n}`,
};

type Draft = typeof STARTER;

type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

type PlaygroundValidation =
  | { ok: true; input: SandboxedDraftInput }
  | {
      ok: false;
      fields: { argumentSchema?: string; sampleArguments?: string };
    };

function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function parseJsonObject(raw: string, label: string): JsonObjectResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (thrown) {
    const reason =
      thrown instanceof SyntaxError ? thrown.message : "invalid JSON";
    return { ok: false, message: `${label} must be valid JSON: ${reason}` };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      message: `${label} must be a JSON object, not ${jsonKind(value)}.`,
    };
  }

  return { ok: true, value: value as Record<string, unknown> };
}

export function validatePlaygroundDraft(draft: Draft): PlaygroundValidation {
  const schema = parseJsonObject(
    draft.argumentSchema,
    "Arguments (JSON Schema)",
  );
  const sample = parseJsonObject(draft.sampleArguments, "Sample arguments");
  if (!schema.ok || !sample.ok) {
    return {
      ok: false,
      fields: {
        ...(!schema.ok ? { argumentSchema: schema.message } : {}),
        ...(!sample.ok ? { sampleArguments: sample.message } : {}),
      },
    };
  }

  return {
    ok: true,
    input: {
      slug: draft.slug,
      title: draft.title,
      description: draft.description,
      html: draft.html,
      css: draft.css,
      jsFunctions: draft.jsFunctions,
      argumentSchema: schema.value,
      sampleArguments: sample.value,
    },
  };
}

function PlaygroundPage() {
  const [deleting, setDeleting] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: components } = useQuery(sandboxedListQueryOptions());
  const [draft, setDraft] = useState<Draft>(STARTER);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (field: keyof Draft) => (value: string) => {
    setError(null);
    setNotice(null);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const validation = validatePlaygroundDraft(draft);
  const sample = validation.ok ? validation.input.sampleArguments : null;

  /* Every write here reports into the same banner, so they share one failure handler. */
  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const saveDraft = useMutation({
    ...saveSandboxedDraftMutationOptions(queryClient),
    ...report,
  });
  const publishDraft = useMutation({
    ...publishSandboxedMutationOptions(queryClient),
    ...report,
  });
  const removeComponent = useMutation({
    ...deleteSandboxedMutationOptions(queryClient),
    ...report,
  });
  const busy =
    saveDraft.isPending || publishDraft.isPending || removeComponent.isPending;
  const canWrite = Boolean(draft.slug && draft.title) && validation.ok && !busy;

  const input = (): SandboxedDraftInput | null => {
    const current = validatePlaygroundDraft(draft);
    if (!current.ok) {
      setNotice(null);
      setError(
        Object.values(current.fields)[0] ??
          "Fix the JSON fields before saving.",
      );
      return null;
    }
    return current.input;
  };

  const save = () => {
    setError(null);
    setNotice(null);
    const payload = input();
    if (!payload) return;
    saveDraft.mutate(payload, { onSuccess: () => setNotice("Draft saved.") });
  };

  const publish = () => {
    setError(null);
    setNotice(null);
    const payload = input();
    if (!payload) return;
    publishDraft.mutate(payload, { onSuccess: () => setNotice("Published.") });
  };

  const load = (component: SandboxedRecord) =>
    setDraft({
      slug: component.name.replace(/^custom_/, ""),
      title: component.title,
      description: component.draftDescription,
      html: component.draftHtml,
      css: component.draftCss,
      jsFunctions: component.draftJsFunctions,
      argumentSchema: JSON.stringify(component.draftArgumentSchema, null, 2),
      sampleArguments: JSON.stringify(component.sampleArguments, null, 2),
    });

  return (
    /*
     * THE ONE PAGE THAT KEEPS ITS OWN GEOMETRY. Everything else in admin is a column you scroll;
     * this is an editor beside a live preview, and the preview is the entire point — put it in the
     * standard prose column and it lands below the fold, so you would be typing at something you
     * cannot see. It takes the header and the controls, and keeps the two panes.
     */
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-start justify-between gap-4 border-border border-b px-6 py-4">
        {/* Inline rather than in a band of its own: this screen is an editor beside a live preview
            and every 48px of height is taken from the thing being previewed. */}
        <div className="flex items-start gap-2">
          <SidebarToggle className="-ml-2 shrink-0" />
          <div>
            <h1 className="font-bold text-2xl">Playground</h1>
            <p className="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed">
              Write a component here and publish it without a deployment. What
              you edit is a draft; a conversation only ever draws what is
              published.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={!canWrite}
            onClick={save}
            size="sm"
            type="button"
            variant="outline"
          >
            Save draft
          </Button>
          <Button
            /* `publish` saves first, since publishing acts on the stored draft, not the editors. */
            disabled={!canWrite}
            onClick={publish}
            size="sm"
            type="button"
          >
            Publish
          </Button>
        </div>
      </header>

      {error ? (
        <div
          className="border-border border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className="border-border border-b bg-emerald-50 px-6 py-2 text-emerald-700 text-sm"
          role="status"
        >
          {notice}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto px-6 py-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <TextField
              label="Name"
              onChange={set("slug")}
              placeholder="refund_card"
              value={draft.slug}
            />
            <TextField
              label="Title"
              onChange={set("title")}
              placeholder="Refund card"
              value={draft.title}
            />
          </div>
          <TextField
            label="What the model is told about it"
            onChange={set("description")}
            placeholder="Show a refund with its amount, reason and status."
            value={draft.description}
          />
          <CodeField label="HTML" onChange={set("html")} value={draft.html} />
          <CodeField label="CSS" onChange={set("css")} value={draft.css} />
          <CodeField
            label="JavaScript"
            onChange={set("jsFunctions")}
            value={draft.jsFunctions}
          />
          <CodeField
            error={
              !validation.ok ? validation.fields.argumentSchema : undefined
            }
            label="Arguments (JSON Schema)"
            onChange={set("argumentSchema")}
            value={draft.argumentSchema}
          />
          <CodeField
            error={
              !validation.ok ? validation.fields.sampleArguments : undefined
            }
            label="Sample arguments"
            onChange={set("sampleArguments")}
            value={draft.sampleArguments}
          />
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="mb-2 text-sm font-medium">Preview</div>
            {sample === null ? (
              <p className="text-sm text-destructive">
                {validation.ok
                  ? "The sample arguments are not available."
                  : (validation.fields.sampleArguments ??
                    "Fix the JSON fields before previewing.")}
              </p>
            ) : (
              <OpenGenerativeUIActivityRenderer
                activityType="open-generative-ui"
                agent={null}
                content={{
                  css: draft.css,
                  cssComplete: true,
                  html: [draft.html],
                  htmlComplete: true,
                  // Provide sample args in the same sandbox evaluation as the component code.
                  jsFunctions: `window.__args = ${JSON.stringify(sample)};\n${draft.jsFunctions}`,
                  jsFunctionsComplete: true,
                  generating: false,
                }}
                key={`${draft.html}${draft.css}${draft.jsFunctions}${draft.sampleArguments}`}
                message={null}
              />
            )}
          </div>

          <div className="rounded-lg border border-border bg-card">
            <div className="border-border border-b px-4 py-2 font-medium text-sm">
              Saved here
            </div>
            {(components ?? []).length === 0 ? (
              <p className="px-4 py-3 text-muted-foreground text-sm">
                Nothing yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {(components ?? []).map((component) => (
                  <li
                    className="flex items-center justify-between px-4 py-2 text-sm"
                    key={component.name}
                  >
                    <div>
                      <div className="font-mono text-xs">{component.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {component.published
                          ? `published, revision ${component.revision}`
                          : "draft only, no Bot can draw it"}
                        {component.hasUnpublishedChanges
                          ? " · edited since publishing"
                          : ""}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => load(component)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Open
                      </Button>
                      <Button
                        onClick={() => setDeleting(component.name)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-border border-t px-4 py-2 text-muted-foreground text-xs">
              Publishing makes it available to every Bot. Switch it off for a
              particular Bot on the Components page, the same as for a component
              this build ships.
            </p>
          </div>
        </div>
      </div>

      {/*
       * Deleting was a bare button on a row of one-line entries, and it does not come back. The
       * dialog names the component, so what is agreed to says which one it removes.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        open={deleting !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting}?</DialogTitle>
            <DialogDescription>
              It is removed from this deployment. Any Bot that could draw it no
              longer can, and this cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDeleting(null)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              onClick={() => {
                const name = deleting;
                setDeleting(null);
                if (name) {
                  setError(null);
                  removeComponent.mutate(name);
                }
              }}
              size="sm"
              variant="destructive"
            >
              Delete it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  /*
   * An explicit `htmlFor`, not a wrapping label. The label used to wrap a bare `<input>`; now that
   * the control is a component the association has to be written down rather than implied by
   * nesting, or it exists for sighted people only.
   */
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </Field>
  );
}

function CodeField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={Boolean(error)}
        className="h-32 font-mono text-xs"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        value={value}
      />
      {error ? (
        <FieldDescription className="text-destructive" id={`${id}-error`}>
          {error}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
