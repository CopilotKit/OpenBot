import { IconKey, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { revokeCredentialMutationOptions } from "@/lib/credentials/mutations";
import { credentialListQueryOptions } from "@/lib/credentials/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { queryClient } from "@/query-client";

/**
 * Admin's keys and tokens for this deployment. The personal edition shows the same list as the
 * Vault's Keys section (`components/vault/vault-page.tsx`).
 */
export function CredentialsPage() {
  const paths = useManagePaths();
  return (
    <PageShell
      action={
        // Its own screen, `credentials_.new.tsx`, which says why the form is not on this page.
        <Button
          render={(props) => <Link {...props} {...paths.newCredential()} />}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          Add credential
        </Button>
      }
      description="Manage this deployment’s keys and tokens. Saved secrets cannot be viewed again."
      title={paths.credentialsLabel}
    >
      <PageSection title="Saved credentials">
        <CredentialsList />
      </PageSection>
    </PageShell>
  );
}

/** The saved keys and tokens, each with Revoke, or an empty state that offers to add one. */
export function CredentialsList() {
  const paths = useManagePaths();
  const personal = paths.edition === "personal";
  const noun = personal ? "key" : "credential";
  const credentials = useQuery(credentialListQueryOptions());
  const revokeCredential = useMutation(
    revokeCredentialMutationOptions(queryClient),
  );

  if (credentials.isPending) return null;
  if (credentials.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        Couldn't load {noun}s. Reload the page.
      </p>
    );
  if (credentials.data.length === 0)
    return (
      <PageEmpty
        action={
          <Button
            render={(props) => <Link {...props} {...paths.newCredential()} />}
            size="sm"
            variant="outline"
          >
            <IconPlus />
            Add {noun}
          </Button>
        }
        icon={IconKey}
        title={`No ${noun}s yet`}
      >
        {personal
          ? "Keys and tokens for your models and apps are kept here."
          : "Keys and tokens for models and connectors are kept here."}
      </PageEmpty>
    );
  return (
    <PageRows>
      {credentials.data.map((credential, index) => (
        <StaggerItem index={index} key={credential.id}>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconKey />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{credential.provider}</ItemTitle>
              <ItemDescription>
                {credential.kind} · {credential.keyId} ·{" "}
                {credential.revokedAt ? "revoked" : "active"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={
                  Boolean(credential.revokedAt) || revokeCredential.isPending
                }
                onClick={() => revokeCredential.mutate(credential.id)}
                size="sm"
                variant="outline"
              >
                Revoke
              </Button>
            </ItemActions>
          </Item>
          {index !== credentials.data.length - 1 && <Separator />}
        </StaggerItem>
      ))}
    </PageRows>
  );
}
