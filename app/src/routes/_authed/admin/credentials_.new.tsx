import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
import {
  type CredentialFormValues,
  credentialFormSchema,
} from "@/lib/credentials/form";
import { createCredentialMutationOptions } from "@/lib/credentials/mutations";
import {
  type CredentialStatus,
  credentialListQueryOptions,
} from "@/lib/credentials/queries";

export const Route = createFileRoute("/_authed/admin/credentials_/new")({
  component: NewCredentialPage,
});

const BACK = {
  label: "Credentials",
  linkProps: { to: "/admin/credentials" as const },
};

/** Without `items` the trigger draws the raw value, so the type read "model" in lower case. */
const KIND_LABEL = { model: "Model", connector: "Connector" } as const;

/**
 * Adding a credential, on a screen of its own rather than in a dialog over the list.
 *
 * A credential is added once and then lived with, so the form was never on the list page: a
 * permanent four-field form sat above the list somebody came to read, and the secret field invited a
 * password manager to fill it on every visit. Its own address keeps that, and gives the form a page's
 * room, a back button and a URL that can be linked to, as Linear does for its API keys.
 */
function NewCredentialPage() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const createCredential = useMutation(
    createCredentialMutationOptions(queryClient),
  );
  const defaultValues: CredentialFormValues = {
    kind: "model",
    provider: "",
    keyId: "",
    plaintext: "",
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: credentialFormSchema },
    onSubmit: async ({ value }) => {
      await createCredential.mutateAsync({ ...value, metadata: {} });
      await navigate({ to: "/admin/credentials" });
    },
  });

  return (
    <PageShell
      backButton={BACK}
      description="Save a credential for this deployment. You won’t be able to view the secret after saving it."
      title="Add credential"
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
                render={(props) => <Link {...props} to="/admin/credentials" />}
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
                      !canSubmit || isSubmitting || createCredential.isPending
                    }
                    type="submit"
                  >
                    {isSubmitting || createCredential.isPending
                      ? "Saving…"
                      : "Save credential"}
                  </Button>
                )}
              </form.Subscribe>
            </>
          }
        >
          <FieldGroup>
            <form.Field name="kind">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Type</FieldLabel>
                    <FieldDescription>
                      A model provider's key, or one a connector signs in with.
                    </FieldDescription>
                    <Select
                      items={KIND_LABEL}
                      onValueChange={(value) =>
                        field.handleChange(value as "model" | "connector")
                      }
                      value={field.state.value}
                    >
                      <SelectTrigger
                        aria-invalid={isInvalid}
                        className="w-full"
                        id={field.name}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="model">Model</SelectItem>
                          <SelectItem value="connector">Connector</SelectItem>
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
            <form.Field name="provider">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Provider</FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="OpenAI"
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="keyId">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Key ID</FieldLabel>
                    <FieldDescription>
                      Tells this key apart from others for the same provider.
                    </FieldDescription>
                    <Input
                      aria-invalid={isInvalid}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="production"
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="plaintext">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Secret</FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      autoComplete="off"
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      type="password"
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
          {/*
           * Said before the write, not after it.
           *
           * A key holds one live credential, so saving onto a key that already has one is a
           * replacement: the old credential is revoked in the same transaction. The page calls this
           * Add and has no rotate control, so without this line an administrator retires the
           * credential an MCP server or an agent is currently authenticating with, and nothing on
           * screen mentions it until something stops working.
           */}
          <form.Subscribe
            selector={(state) => [
              state.values.kind,
              state.values.provider,
              state.values.keyId,
            ]}
          >
            {([kind, provider, keyId]) =>
              liveCredentialFor(credentials.data, kind, provider, keyId) ? (
                <p className="mt-5 text-amber-600 text-sm dark:text-amber-500">
                  This key already has an active credential. Saving replaces it
                  and revokes the old one.
                </p>
              ) : null
            }
          </form.Subscribe>
          {createCredential.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              Couldn't save the credential. Try again.
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}

/**
 * The live credential a key already holds, if it holds one.
 *
 * `(kind, provider, keyId)` is what `credentials_active_key_idx` is unique on, and revoked rows are
 * outside it, so this is the same question the database asks when the save lands.
 */
function liveCredentialFor(
  credentials: CredentialStatus[] | undefined,
  kind: unknown,
  provider: unknown,
  keyId: unknown,
): CredentialStatus | undefined {
  if (!provider || !keyId) return undefined;
  return credentials?.find(
    (credential) =>
      credential.revokedAt === null &&
      credential.kind === kind &&
      credential.provider === provider &&
      credential.keyId === keyId,
  );
}
