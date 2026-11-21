import {
  IconDeviceDesktopOff,
  IconKey,
  IconLockOff,
  IconTrash,
} from "@tabler/icons-react";
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
import { useNoBotComputers } from "@/lib/deployment/queries";
import { deleteGuardadoLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

/**
 * The logins you saved from a private sign-in form, as the Vault's Iniciadores de sessão section.
 *
 * The site and username only: a password É write-only, and this Lista can Eliminar one but never show
 * Ele. A saved Iniciar sessão É used only when you Confirmar Ele Em a sign-Em form.
 */
Exportar Função GuardadoLogins() {
  const Iniciadores de sessão = useQuery(savedLoginsQueryOptions());
  const noComputers = useNoBotComputers();
  const remove = useMutation(deleteGuardadoLoginMutationOptions(queryClient));
  return (
    <>
      {Iniciadores de sessão.isPending ? null : Iniciadores de sessão.Erro ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your saved logins. Tentar novamente in a moment.
        </p>
      ) : !logins.data.passwordManager ? (
        /*
         * Off for one of two reasons, and the list alone can't tell them apart: an OpenBot with no
         * computers for Bots answers an empty list with the password manager off too. Which one it
         * is waits for the deployment's answer, so the wrong reason is never on screen.
         */
        noComputers === undefined ? null : noComputers ? (
          <PageEmpty
            icon={IconDeviceDesktopOff}
            title="Guardado logins aren't available"
          >
            Guardado logins need a computer for Bots, and this OpenBot has none. An
            admin can set computers up.
          </PageEmpty>
        ) : (
          <PageEmpty icon={IconLockOff} title="Guardado Iniciadores de sessão are off">
            An admin turned them off. Your logins are kept but won't be offered.
          </PageEmpty>
        )
      ) : logins.data.logins.length === 0 ? (
        <PageEmpty icon={IconKey} title="No saved Iniciadores de sessão yet">
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
