import { IconBuildingBank, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useId, useState } from "react";
import { SignInSection } from "@/components/admin/controls/sign-in-section";
import { TeamPage } from "@/components/edition/for-a-team";
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
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  deleteIdentityProviderMutationOptions,
  type IdentityProviderInput,
  registerIdentityProviderMutationOptions,
} from "@/lib/identity-providers/mutations";
import { identityProviderListQueryOptions } from "@/lib/identity-providers/queries";
import { identityProviderWords } from "@/lib/identity-providers/words";
import { loadFailure, failureSaid } from "@/lib/load-failure";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { ONLY_ORGANIZATION } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/identity-providers")({
  /*
   * On OpenBot by CopilotKit (`hostedSignIn`) people sign in with their CopilotKit account, so an
   * organization has no identity provider of its own to set up: an old link or bookmark lands on the
   * Admin overview, as Admin lists no such page there. Admin's route has already read the answer, so
   * this waits on nothing and the page never draws first.
   */
  beforeLoad: async ({ context }) => {
    const deployment = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    if (deployment?.hostedSignIn)
      throw redirect({ to: "/admin", replace: true });
  },
  component: IdentityProvidersPageInEveryEdition,
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
  const organization = useCurrentOrganizationId();
  // Outside `default`, an organization's providers are its own: they apply to its members.
  const organizationOnly =
    organization !== undefined && organization !== ONLY_ORGANIZATION;
  // A hosted OpenBot: people also sign in with their OpenBot by CopilotKit account, set in no environment of theirs.
  const hosted =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;
  const words = identityProviderWords(organizationOnly, hosted);
  const providers = useQuery(identityProviderListQueryOptions());
  const register = useMutation(
    registerIdentityProviderMutationOptions(queryClient),
  );
  const remove = useMutation(
    deleteIdentityProviderMutationOptions(queryClient),
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const formId = useId();

  // A removal failure belongs on the page: there is no dialog to put it in. A registration failure
  // is shown inside the dialog instead, where the person who caused it is looking.
  const failure = remove.error;

  /*
   * Not this organization's: an admin of an organization that does not run OpenBot reads why, and
   * is offered nothing to press. Sign-in is to OpenBot as a whole, so its providers, requiring SSO
   * and directory provisioning are kept by the admins who run it (lib/identity-providers/queries.ts).
   */
  if (providers.data?.managedHere === false)
    return (
      <PageShell
        description="People sign in to OpenBot as a whole, before they pick an organization."
        title="Identity providers"
      >
        <PageEmpty icon={IconBuildingBank} title="Set up for all of OpenBot">
          Identity providers and SSO apply to everyone who signs in here, not to
          one organization. Ask whoever runs OpenBot to add or change one.
        </PageEmpty>
      </PageShell>
    );
  const listed = providers.data?.managedHere ? providers.data.providers : [];
  // This organization's own, to register and remove; and, outside `default`, the deployment's, which count here too.
  const registered = listed.filter((provider) => !provider.deployment);
  const deploymentWide = listed.filter((provider) => provider.deployment);

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
        // Offered once the server has said the providers are this organization's to change.
        providers.data?.managedHere ? (
          <Button onClick={() => setOpen(true)} size="lg">
            Add a provider
          </Button>
        ) : undefined
      }
      description={words.description}
      title="Identity providers"
    >
      <PageSection description={words.registeredDescription} title="Registered">
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        {providers.isPending ? null : providers.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {loadFailure(
              providers.error,
              "Couldn't load identity providers. Try again in a moment.",
            )}
          </p>
        ) : registered.length === 0 ? (
          <PageEmpty
            action={
              <Button onClick={() => setOpen(true)} size="sm" variant="outline">
                Add a provider
              </Button>
            }
            icon={IconBuildingBank}
            title="No identity providers yet"
          >
            Use the metadata from your identity team.
          </PageEmpty>
        ) : (
          <PageRows>
            {registered.map((provider, index) => (
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
                {index !== registered.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
      {/*
       * Read-only: set up for everybody who signs in to OpenBot, they count for this organization's Require SSO as its
       * own do, and only whoever runs OpenBot changes them.
       */}
      {deploymentWide.length > 0 ? (
        <PageSection
          description={
            /*
             * Only while the organization has none of its own: once it has, only those count for its Require SSO.
             * On a hosted OpenBot whoever runs it is OpenBot by CopilotKit, whom an organization admin has no way
             * to ask, so the sentence stops at what is true.
             */
            registered.length > 0
              ? hosted
                ? "Set up for everyone who signs in to OpenBot. This organization has its own, so only those count for its Require SSO."
                : "Set up for everyone who signs in to OpenBot. This organization has its own, so only those count for its Require SSO. Ask whoever runs OpenBot to change one of these."
              : hosted
                ? "Set up for everyone who signs in to OpenBot. They count for this organization too."
                : "Set up for everyone who signs in to OpenBot. They count for this organization too. Ask whoever runs OpenBot to change one."
          }
          title="For all of OpenBot"
        >
          <PageRows>
            {deploymentWide.map((provider, index) => (
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
                  {registered.length > 0 ? (
                    // Read-only: a value, not a control.
                    <ItemActions>
                      <span className="text-right text-muted-foreground text-xs">
                        Not used for this organization's rule
                      </span>
                    </ItemActions>
                  ) : null}
                </Item>
                {index !== deploymentWide.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      {/* Requiring SSO is the deployment's too: drawn once the server has answered for the providers. */}
      {providers.isPending ? null : (
        <SignInSection organizationOnly={organizationOnly} />
      )}

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add an identity provider</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 space-y-4 overflow-y-auto">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form className="flex flex-col gap-4" id={formId} onSubmit={submit}>
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
                  {words.domainHelp}
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
                      The file from your identity team. It includes the signing
                      certificate.
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
            </form>
            {/*
                Here as well as on the page behind, because while this is open the page behind it is
                not visible. A registration refused by the identity provider or by Better Auth left
                the dialog sitting there unchanged, which reads as the button not working.
              */}
            {register.error ? (
              <p className="text-destructive text-sm" role="alert">
                {failureSaid(register.error)}
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
            <Button
              disabled={register.isPending}
              form={formId}
              size="sm"
              type="submit"
            >
              {register.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

/** The personal edition shows this page's title, and that it applies to a team. */
function IdentityProvidersPageInEveryEdition() {
  return (
    <TeamPage
      description="Configure your company’s SAML or OpenID Connect provider. Email domains determine which provider people use to sign in."
      more="Here, nobody signs in."
      title="Identity providers"
    >
      <IdentityProvidersPage />
    </TeamPage>
  );
}
