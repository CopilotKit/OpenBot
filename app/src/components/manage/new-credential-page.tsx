import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
  type ModelKeyName,
  type ModelProvider,
  modelKeyQueryOptions,
} from "@/lib/credentials/queries";
import { useManagePaths } from "@/lib/manage-paths";

/** Without `items` the trigger draws the raw value, so the type read "model" in lower case. */
const KIND_LABEL = { model: "Model", connector: "Connector" } as const;

/** The AI providers a model key can be for, by the name a person knows them by. */
const PROVIDER_LABEL: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/**
 * Adding a credential, on a screen of its own rather than in a dialog over the list.
 *
 * A credential is added once and then lived with, so the form was never on the list page: a
 * permanent four-field form sat above the list somebody came to read, and the secret field invited a
 * password manager to fill it on every visit. Its own address keeps that, and gives the form a page's
 * room, a back button and a URL that can be linked to, as Linear does for its API keys.
 */
export function NewCredentialPage() {
  const paths = useManagePaths();
  const modelKey = useQuery(modelKeyQueryOptions());
  return (
    <PageShell
      backButton={{
        label: paths.credentialsLabel,
        linkProps: paths.credentials(),
      }}
      description={
        paths.edition === "personal"
          ? "Save a key to your vault. You won’t be able to view it after saving it."
          : `Save a credential for ${paths.deploymentName}. You won’t be able to view the secret after saving it.`
      }
      title={paths.edition === "personal" ? "Add key" : "Add credential"}
    >
      {/*
       * The form starts on the provider the Bots run on, so it waits for the answer. A failed read
       * still offers the form: the server files a model key under the Bots' name either way.
       */}
      {modelKey.isPending ? null : (
        <CredentialForm modelKey={modelKey.data ?? null} />
      )}
    </PageShell>
  );
}

/**
 * A MODEL KEY IS ASKED ONLY WHICH PROVIDER IT IS FOR. The Bots read one entry, the provider they
 * run on under one name, and the form used to ask for a free-text provider and key ID with
 * "OpenAI" and "production" as placeholders: a person who followed them saved a key nothing read,
 * and OpenBot still couldn't answer. The provider is now a choice of the ones the Bots run on, and
 * the server files the key under the name they read. A connector key still names itself.
 */
function CredentialForm({ modelKey }: { modelKey: ModelKeyName | null }) {
  const paths = useManagePaths();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const createCredential = useMutation(
    createCredentialMutationOptions(queryClient),
  );
  const modelProvider: ModelProvider = modelKey?.provider ?? "openai";
  const defaultValues: CredentialFormValues = {
    kind: "model",
    provider: modelProvider,
    keyId: "",
    plaintext: "",
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: credentialFormSchema },
    onSubmit: async ({ value }) => {
      await createCredential.mutateAsync(
        value.kind === "model"
          ? {
              kind: "model",
              provider: value.provider,
              plaintext: value.plaintext,
              metadata: {},
            }
          : { ...value, metadata: {} },
      );
      await navigate(paths.credentials());
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
      <PageCard
        footer={
          <>
            <Button
              render={(props) => <Link {...props} {...paths.credentials()} />}
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
                    onValueChange={(value) => {
                      const kind = value as "model" | "connector";
                      field.handleChange(kind);
                      // A model key picks from the list; a connector names its own provider.
                      form.setFieldValue(
                        "provider",
                        kind === "model" ? modelProvider : "",
                      );
                      form.setFieldValue("keyId", "");
                    }}
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
          <form.Subscribe selector={(state) => state.values.kind}>
            {(kind) =>
              kind === "model" ? (
                <form.Field name="provider">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor={field.name}>Provider</FieldLabel>
                      {modelKey ? (
                        <FieldDescription>
                          {field.state.value === modelKey.provider
                            ? `Your Bots run on ${PROVIDER_LABEL[modelKey.provider]} and will use this key.`
                            : `Your Bots run on ${PROVIDER_LABEL[modelKey.provider]}, so they won't use this key.`}
                        </FieldDescription>
                      ) : null}
                      <Select
                        items={PROVIDER_LABEL}
                        onValueChange={(value) =>
                          field.handleChange(value as ModelProvider)
                        }
                        value={field.state.value}
                      >
                        <SelectTrigger className="w-full" id={field.name}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="anthropic">Anthropic</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </form.Field>
              ) : (
                <>
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
                            placeholder="GitHub"
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
                            Tells this key apart from others for the same
                            provider.
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
                </>
              )
            }
          </form.Subscribe>
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
                    onChange={(event) => field.handleChange(event.target.value)}
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
            liveCredentialFor(
              credentials.data,
              kind,
              provider,
              kind === "model" ? modelKey?.keyId : keyId,
            ) ? (
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
