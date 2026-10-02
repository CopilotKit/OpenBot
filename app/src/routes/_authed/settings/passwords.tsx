import { IconKey, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/passwords")({
  component: PasswordsPage,
});

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 */
function PasswordsPage() {
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      title="Passwords"
      description="Logins you saved when signing a Bot in to a website. A Bot never sees them, and each use needs your confirmation."
    >
      <PageSection title="Saved logins">
        {logins.isPending ? null : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            Could not load your passwords.
          </p>
        ) : !logins.data.passwordManager ? (
          <PageEmpty>
            Saved passwords are turned off for this workspace. Existing logins
            are kept but not offered.
          </PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty>
            No saved logins. Choose Save to Passwords when you sign a Bot in to
            a website.
          </PageEmpty>
        ) : (
          <PageRows>
            {logins.data.logins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.origin}</ItemTitle>
                    <ItemDescription>
                      {login.username}
                      {login.lastUsedAt
                        ? ` · last used ${new Date(login.lastUsedAt).toLocaleDateString()}`
                        : " · never used"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Delete the login for ${login.origin}`}
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(login.id)}
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
