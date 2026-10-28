import { IconKey, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { revokeCredentialMutationOptions } from "@/lib/credentials/mutations";
import { credentialListQueryOptions } from "@/lib/credentials/queries";

export const Route = createFileRoute("/_authed/admin/credentials")({
  component: CredentialsPage,
});

function CredentialsPage() {
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const revokeCredential = useMutation(
    revokeCredentialMutationOptions(queryClient),
  );

  return (
    <PageShell
      action={
        // Its own screen, `credentials_.new.tsx`, which says why the form is not on this page.
        <Button
          render={(props) => <Link {...props} to="/admin/credentials/new" />}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          Add credential
        </Button>
      }
      description="Manage this deployment’s keys and tokens. Saved secrets cannot be viewed again."
      title="Credentials"
    >
      <PageSection title="Saved credentials">
        {credentials.isPending ? null : credentials.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load credentials. Reload the page.
          </p>
        ) : credentials.data?.length === 0 ? (
          <PageEmpty
            action={
              <Button
                render={(props) => (
                  <Link {...props} to="/admin/credentials/new" />
                )}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                Add credential
              </Button>
            }
            icon={IconKey}
            title="No credentials yet"
          >
            Keys and tokens for models and connectors are kept here.
          </PageEmpty>
        ) : (
          <PageRows>
            {credentials.data?.map((credential, index) => (
              <StaggerItem index={index} key={credential.id}>
                <Item size="sm">
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
                        Boolean(credential.revokedAt) ||
                        revokeCredential.isPending
                      }
                      onClick={() => revokeCredential.mutate(credential.id)}
                      size="sm"
                      variant="outline"
                    >
                      Revoke
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (credentials.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
