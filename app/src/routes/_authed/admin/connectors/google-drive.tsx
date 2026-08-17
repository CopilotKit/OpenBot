import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { connectorKeys } from "@/lib/connectors/queries";

export const Route = createFileRoute("/_authed/admin/connectors/google-drive")({
  component: GoogleDriveConnectorPage,
});

function GoogleDriveConnectorPage() {
  const queryClient = useQueryClient();
  const setup = useMutation({
    mutationFn: async (value: {
      serviceAccountJson: string;
      impersonationSubject: string;
    }) => {
      const response = await fetch("/api/admin/connectors/google-drive/setup", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error("Could not set up Google Drive");
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
  });
  const form = useForm({
    defaultValues: { serviceAccountJson: "", impersonationSubject: "" },
    validators: {
      onSubmit: z.object({
        serviceAccountJson: z
          .string()
          .trim()
          .refine((value) => {
            try {
              const parsed: unknown = JSON.parse(value);
              return Boolean(
                parsed && typeof parsed === "object" && !Array.isArray(parsed),
              );
            } catch {
              return false;
            }
          }, "Paste a valid service-account JSON object."),
        impersonationSubject: z
          .string()
          .email("Enter the Workspace account to impersonate."),
      }),
    },
    onSubmit: async ({ value }) => {
      await setup.mutateAsync(value);
      form.reset();
    },
  });
  return (
    /*
     * THE FORM STAYS ON THE PAGE HERE, unlike the rest of admin. This route exists only to hold it —
     * there is no list behind it to interrupt — so putting it in a dialog would mean navigating to a
     * page whose only content immediately covers itself up.
     */
    <PageShell
      description="Connect an organization service account with domain-wide delegation."
      title="Google Drive"
    >
      <form
        className="mt-8"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="serviceAccountJson">
            {(field) => (
              <Field
                data-invalid={
                  field.state.meta.isTouched && !field.state.meta.isValid
                }
              >
                <FieldLabel htmlFor={field.name}>
                  Service account JSON key
                </FieldLabel>
                <Textarea
                  className="min-h-40 font-mono text-xs"
                  id={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  value={field.state.value}
                />
                {field.state.meta.isTouched && !field.state.meta.isValid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            )}
          </form.Field>
          <form.Field name="impersonationSubject">
            {(field) => (
              <Field
                data-invalid={
                  field.state.meta.isTouched && !field.state.meta.isValid
                }
              >
                <FieldLabel htmlFor={field.name}>
                  Impersonation subject
                </FieldLabel>
                <Input
                  id={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="admin@company.com"
                  value={field.state.value}
                />
                {field.state.meta.isTouched && !field.state.meta.isValid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            )}
          </form.Field>
        </FieldGroup>
        {setup.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not save the Google Drive connection.
          </p>
        ) : null}
        <Button className="mt-4" disabled={setup.isPending} type="submit">
          {setup.isPending ? "Connecting…" : "Connect Google Drive"}
        </Button>
      </form>
    </PageShell>
  );
}
