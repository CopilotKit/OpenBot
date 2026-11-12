import { IconKey, IconLockOff, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
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

/**
 * The logins you saved from a private sign-in form, as the Vault's Logins section.
 *
 * The site and username only: a password is write-only, and this list can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 */
export function SavedLogins() {
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <>
      {logins.isPending ? null : logins.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your saved logins. Reload the page.
        </p>
      ) : !logins.data.passwordManager ? (
        <PageEmpty icon={IconLockOff} title="Saved logins are off">
          An admin turned them off. Your logins are kept but won't be offered.
        </PageEmpty>
      ) : logins.data.logins.length === 0 ? (
        <PageEmpty icon={IconKey} title="No saved logins yet">
          Choose Save to Vault when you sign a Bot in to a website.
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
                    aria-label={`Delete login for ${login.origin}`}
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
    </>
  );
}
