import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
  type AddServerByUrlOutcome,
  addServerByUrlMutationOptions,
} from "@/lib/apps/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { setEnterpriseSettingMutationOptions } from "@/lib/enterprise/mutations";
import { enterpriseOverviewQueryOptions } from "@/lib/enterprise/queries";
import { type Failure, failureOf, failureSaid } from "@/lib/load-failure";
import {
  type AddServerFormValues,
  addServerFormSchema,
} from "@/lib/plugins/form";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import { queryClient } from "@/query-client";

type Refusal = Extract<AddServerByUrlOutcome, { added: false }>;

/**
 * Connections, Add custom MCP: an MCP server OpenBot doesn't list, added by its address.
 *
 * Its own screen rather than a dialog over the tiles, because it takes a name, an address and, for
 * some servers, a key (the layout skill's Procedure 5). The server decides the rest. OpenBot asks it
 * how it is reached: one that signs people in sends this person straight to its sign-in page, and
 * one that needs nothing opens on its tools. A refusal it can offer a step for (a key, an admin's
 * approval) is drawn under the form with that step beside it.
 *
 * `from` is the list it was opened from: Connections, or Admin's Apps page, which offers the same
 * form so an admin finds it where the apps are set up. Back, Cancel and a server added with nothing
 * more to do go to that list, and a server's own page is that list's page for it.
 */
export function AddServerPage({
  from = "connections",
}: {
  from?: "connections" | "admin";
} = {}) {
  const navigate = useNavigate();
  const admin = from === "admin";
  const back = admin
    ? { label: "Apps", linkProps: { to: "/admin/plugins" as const } }
    : { label: "Connections", linkProps: { to: "/connections" as const } };
  /** A server's own page, under the list this form was opened from. */
  const openServer = (key: string) =>
    admin
      ? navigate({ to: "/admin/plugins/$key", params: { key } })
      : navigate({ to: "/connections/$key", params: { key } });
  /** Added with nothing more to do: Connections opens it, Admin goes back to Apps, where it's listed. */
  const added = (key: string) =>
    admin ? navigate({ to: "/admin/plugins" }) : openServer(key);
  const me = useQuery(currentUserQueryOptions()).data;
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  /*
   * A server is added for everyone in the organization, so only an admin adds one, with its key if
   * it needs one. Personal: the one person. Read as allowed until the role is known, so the form
   * doesn't flash away for an admin; the server refuses anybody else whatever is drawn.
   */
  const mayGiveKey = personal || isOrganizationAdmin(me?.role);
  const mayAdd = mayGiveKey || me === undefined;
  const add = useMutation(addServerByUrlMutationOptions(queryClient));
  // The sign-in comes back to the server's page under the same list.
  const connect = useMutation(
    connectAccountMutationOptions(admin ? "admin" : "settings"),
  );
  const approve = useMutation(setEnterpriseSettingMutationOptions(queryClient));
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);

  async function signIn(serverId: string, title: string) {
    setSigningIn(title);
    let start: Awaited<ReturnType<typeof connect.mutateAsync>>;
    try {
      start = await connect.mutateAsync(serverId);
    } catch (thrown) {
      setSigningIn(null);
      // Added, and the sign-in could not start: its page says so and offers Connect again.
      setRefusal({
        added: false,
        error: failureOf(thrown, "Couldn't connect that account."),
        serverId,
      });
      return;
    }
    if (!start || !("authorizationUrl" in start)) {
      await openServer(serverId);
      return;
    }
    /*
     * OpenBot Desktop opens the sign-in in the person's own browser and stays where it is, so it
     * waits on the server's page; the sign-in hands the person back to it when they are done.
     */
    if (desktopShell()) {
      await openServer(serverId);
    }
    window.location.href = start.authorizationUrl;
  }

  async function submit(value: AddServerFormValues) {
    setRefusal(null);
    const outcome = await add.mutateAsync({
      title: value.title.trim(),
      url: value.url.trim(),
      ...(mayGiveKey && value.token.trim()
        ? { token: value.token.trim() }
        : {}),
    });
    if (!outcome.added) {
      setRefusal(outcome);
      return;
    }
    if (outcome.signIn) {
      await signIn(outcome.server.id, outcome.server.title);
      return;
    }
    await added(outcome.server.id);
  }

  const defaultValues: AddServerFormValues = { title: "", url: "", token: "" };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: addServerFormSchema },
    onSubmit: ({ value }) => submit(value),
  });

  /** The admin's own step for a refused address: put it on the allowlist, then add it. */
  async function approveAndAdd() {
    const values = form.state.values;
    const overview = await queryClient.fetchQuery(
      enterpriseOverviewQueryOptions(),
    );
    const allowlist = overview.settings.mcpAllowlist;
    await approve.mutateAsync({
      key: "mcpAllowlist",
      value: {
        ...allowlist,
        servers: [...allowlist.servers, values.url.trim()],
      },
    });
    await submit(values);
  }

  const busy = add.isPending || connect.isPending || approve.isPending;

  if (!mayAdd)
    return (
      <PageShell backButton={back} title="Add custom MCP">
        <PageCard>
          <p className="text-sm" data-testid="add-server-admin-only">
            Only an admin can add a server, because it's added for everyone in
            the organization. Ask an admin to add it.
          </p>
        </PageCard>
      </PageShell>
    );

  return (
    <PageShell
      backButton={back}
      description="Give your Bots the tools of an MCP server OpenBot doesn't list, from its address. If it asks you to sign in, you'll go to its sign-in page next."
      title="Add custom MCP"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                render={(props) => <Link {...props} {...back.linkProps} />}
                variant="outline"
              >
                Cancel
              </Button>
              <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting]}
              >
                {([canSubmit, isSubmitting]) => (
                  <Button
                    disabled={!canSubmit || isSubmitting || busy || !!signingIn}
                    type="submit"
                  >
                    {signingIn
                      ? "Opening sign-in…"
                      : isSubmitting || add.isPending
                        ? "Adding…"
                        : "Add custom MCP"}
                  </Button>
                )}
              </form.Subscribe>
            </>
          }
        >
          <FieldGroup>
            <form.Field name="title">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                    <FieldDescription>
                      What you and your Bots call it.
                    </FieldDescription>
                    <Input
                      aria-invalid={isInvalid}
                      autoComplete="off"
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="Figma"
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="url">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Server address</FieldLabel>
                    <FieldDescription>
                      The MCP server's URL, from its documentation. It usually
                      ends in /mcp.
                    </FieldDescription>
                    <Input
                      aria-invalid={isInvalid}
                      autoComplete="off"
                      id={field.name}
                      inputMode="url"
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="https://mcp.figma.com/mcp"
                      spellCheck={false}
                      type="url"
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
            {mayGiveKey ? (
              <form.Field name="token">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>
                      Key{" "}
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FieldLabel>
                    <FieldDescription>
                      Only if the server gave you a key or token. Leave it empty
                      for a server you sign in to.
                    </FieldDescription>
                    <Input
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
                  </Field>
                )}
              </form.Field>
            ) : null}
          </FieldGroup>

          {refusal ? (
            <RefusalNotice
              admin={admin}
              busy={busy}
              mayGiveKey={mayGiveKey}
              onApprove={() => void approveAndAdd()}
              refusal={refusal}
            />
          ) : null}
          {approve.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {failureSaid(approve.error)}
            </p>
          ) : null}
          {signingIn && desktopShell() ? (
            <p className="mt-5 text-muted-foreground text-sm" role="status">
              Finish signing in to {signingIn} in your browser.
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}

/** Why the server wasn't added, and the one step that would let it be, where there is one. */
function RefusalNotice({
  refusal,
  admin,
  mayGiveKey,
  busy,
  onApprove,
}: {
  refusal: Refusal;
  /** Opened from Admin's Apps page, so "Open it" opens the server's page there. */
  admin: boolean;
  mayGiveKey: boolean;
  busy: boolean;
  onApprove: () => void;
}) {
  const sentence: Failure =
    refusal.code === "needs-key" && !mayGiveKey
      ? {
          message:
            "This server needs a key, and only an admin can add one. Ask an admin to add it.",
        }
      : refusal.error;
  return (
    <div
      className="mt-5 flex flex-col items-start gap-3"
      data-testid="add-server-refusal"
    >
      <p className="break-words text-destructive text-sm" role="alert">
        {failureSaid(sentence)}
      </p>
      {refusal.code === "not-approved" && mayGiveKey ? (
        <Button
          disabled={busy}
          onClick={onApprove}
          size="sm"
          type="button"
          variant="outline"
        >
          Approve and add
        </Button>
      ) : refusal.serverId ? (
        <Button
          render={(props) => (
            <Link
              {...props}
              params={{ key: refusal.serverId ?? "" }}
              to={admin ? "/admin/plugins/$key" : "/connections/$key"}
            />
          )}
          size="sm"
          variant="outline"
        >
          Open it
        </Button>
      ) : null}
    </div>
  );
}
