import { IconBuildingBank, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteIdentityProviderMutationOptions,
  type IdentityProviderInput,
  registerIdentityProviderMutationOptions,
} from "@/lib/identity-providers/mutations";
import { identityProviderListQueryOptions } from "@/lib/identity-providers/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/identity-providers")({
  component: IdentityProvidersPage,
});

const EMPTY = {
  protocol: "saml" as "saml" | "oidc",
  providerId: "",
  domain: "",
  issuer: "",
  entryPoint: "",
  metadata: "",
  clientId: "",
  clientSecret: "",
};

function IdentityProvidersPage() {
  const providers = useQuery(identityProviderListQueryOptions());
  const register = useMutation(
    registerIdentityProviderMutationOptions(queryClient),
  );
  const remove = useMutation(
    deleteIdentityProviderMutationOptions(queryClient),
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY);

  // A removal failure belongs on the page: there is no dialog to put it in. A registration failure
  // is shown inside the dialog instead, where the person who caused it is looking.
  const failure = remove.error;

  function submit(submission: React.FormEvent) {
    submission.preventDefault();
    const input: IdentityProviderInput =
      draft.protocol === "saml"
        ? {
            protocol: "saml",
            providerId: draft.providerId,
            domain: draft.domain,
            issuer: draft.issuer,
            entryPoint: draft.entryPoint,
            metadata: draft.metadata,
          }
        : {
            protocol: "oidc",
            providerId: draft.providerId,
            domain: draft.domain,
            issuer: draft.issuer,
            clientId: draft.clientId,
            clientSecret: draft.clientSecret,
          };

    register.mutate(input, {
      onSuccess: () => {
        setDraft(EMPTY);
        setOpen(false);
      },
    });
  }

  return (
    <PageShell
      action={
        <Button onClick={() => setOpen(true)} size="lg">
          Add a provider
        </Button>
      }
      description="A company's own identity provider, by SAML or OpenID Connect. Somebody types their email address and the domain decides which one they are sent to."
      title="Identity providers"
    >
      <PageSection
        description="Google, Microsoft, Okta and a generic OpenID Connect issuer are configured in the environment instead and do not appear here."
        title="Registered"
      >
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        {providers.isPending ? null : providers.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load identity providers.
          </p>
        ) : providers.data?.length === 0 ? (
          <PageEmpty>
            No identity providers are registered. Add one with the metadata your
            identity team supplied.
          </PageEmpty>
        ) : (
          <PageRows>
            {providers.data?.map((provider, index) => (
              <StaggerItem index={index} key={provider.providerId}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconBuildingBank />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{provider.providerId}</ItemTitle>
                    <ItemDescription>
                      {provider.protocol.toUpperCase()} · {provider.domain} ·{" "}
                      {provider.issuer}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(provider.providerId)}
                      size="sm"
                      variant="destructive"
                    >
                      <IconTrash />
                      Remove
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (providers.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add an identity provider</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit}>
            <DialogBody className="mt-4 space-y-4 overflow-y-auto">
              <div className="flex gap-2">
                {(["saml", "oidc"] as const).map((protocol) => (
                  <Button
                    key={protocol}
                    onClick={() => setDraft({ ...draft, protocol })}
                    size="sm"
                    type="button"
                    variant={
                      draft.protocol === protocol ? "default" : "outline"
                    }
                  >
                    {protocol.toUpperCase()}
                  </Button>
                ))}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="providerId">Name</Label>
                <Input
                  id="providerId"
                  onChange={(event) =>
                    setDraft({ ...draft, providerId: event.target.value })
                  }
                  placeholder="acme-okta"
                  required
                  value={draft.providerId}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="domain">Email domain</Label>
                <Input
                  id="domain"
                  onChange={(event) =>
                    setDraft({ ...draft, domain: event.target.value })
                  }
                  placeholder="acme.com"
                  required
                  value={draft.domain}
                />
                {/* Said out loud because it is the field that decides who this applies to. */}
                <p className="text-muted-foreground text-xs">
                  Anybody signing in with an address at this domain is sent
                  here. Separate several with commas.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="issuer">Issuer</Label>
                <Input
                  id="issuer"
                  onChange={(event) =>
                    setDraft({ ...draft, issuer: event.target.value })
                  }
                  placeholder="https://acme.okta.com"
                  required
                  type="url"
                  value={draft.issuer}
                />
              </div>

              {draft.protocol === "saml" ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="entryPoint">Sign-on URL</Label>
                    <Input
                      id="entryPoint"
                      onChange={(event) =>
                        setDraft({ ...draft, entryPoint: event.target.value })
                      }
                      placeholder="https://acme.okta.com/app/.../sso/saml"
                      required
                      type="url"
                      value={draft.entryPoint}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="metadata">Metadata XML</Label>
                    <Textarea
                      className="font-mono text-xs"
                      id="metadata"
                      onChange={(event) =>
                        setDraft({ ...draft, metadata: event.target.value })
                      }
                      placeholder="<EntityDescriptor …>"
                      required
                      rows={6}
                      value={draft.metadata}
                    />
                    <p className="text-muted-foreground text-xs">
                      The document your identity team supplied. It carries the
                      signing certificate.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="clientId">Client ID</Label>
                    <Input
                      id="clientId"
                      onChange={(event) =>
                        setDraft({ ...draft, clientId: event.target.value })
                      }
                      required
                      value={draft.clientId}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="clientSecret">Client secret</Label>
                    <Input
                      id="clientSecret"
                      onChange={(event) =>
                        setDraft({ ...draft, clientSecret: event.target.value })
                      }
                      required
                      type="password"
                      value={draft.clientSecret}
                    />
                  </div>
                </>
              )}

              {/*
                Here as well as on the page behind, because while this is open the page behind it is
                not visible. A registration refused by the identity provider or by Better Auth left
                the dialog sitting there unchanged, which reads as the button not working.
              */}
              {register.error ? (
                <p className="text-destructive text-sm" role="alert">
                  {register.error.message}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={() => setOpen(false)}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={register.isPending} size="sm" type="submit">
                {register.isPending ? "Adding…" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
