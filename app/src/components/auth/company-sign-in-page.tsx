import {
  IconBuilding,
  IconChevronDown,
  IconUserCircle,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useSyncExternalStore } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { companySignInQueryOptions } from "@/lib/auth/company-sign-in";
import { heldOutRefusal, onHoldChange } from "@/lib/auth/held-out";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { switchOrganizationMutationOptions } from "@/lib/organizations/mutations";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { LinkCompanyAccount } from "./link-company-account";
import { failureSaid } from "@/lib/load-failure";

export const SWITCH_ORGANIZATION = "Switch organization";

/** How the page opens the app at home after a switch: the page loaded afresh. A test replaces it to see it asked. */
export const heldPageDeps = {
  openHome: () => window.location.assign("/"),
};

/**
 * The page for a member an organization holds out until they sign in through their company's identity provider
 * (Require SSO): somebody who joined by invitation, signed in some other way. Every screen of that organization is
 * refused to them, so this stands in for whichever one they opened, in the sign-in screen's own layout.
 *
 * It says why in the server's own sentence, and offers the way in: Link your company account, through a provider that
 * counts for the organization, which the server tells them even while it holds them out. The rule is that one
 * organization's, so they keep working in their others: Switch organization lists those, as the account menu does,
 * and opens the app in the one they pick. Sign out is always there.
 */
export function CompanySignInPage({ refusal }: { refusal: string }) {
  const signOut = useSignOut();
  const companySignIn = useQuery(companySignInQueryOptions());
  const providers = companySignIn.data?.providers ?? [];
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center">
      <div className="flex w-full max-w-82 flex-col items-center p-4">
        <AgentOrb size="56px" />
        <h1 className="mt-8 text-center font-medium text-2xl tracking-tight">
          Sign in with your company
        </h1>
        <p
          className="mt-3 text-pretty text-center text-muted-foreground text-sm"
          role="status"
        >
          {refusal}
        </p>
        <div className="mt-8 flex w-full flex-col gap-2">
          <LinkCompanyAccount providers={providers} size="lg" />
          <OtherOrganizations />
          <Button
            className="h-10 w-full tracking-tight"
            disabled={signOut.pending}
            onClick={signOut.run}
            size="lg"
            variant="ghost"
          >
            {signOut.pending ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The signed-in app, until the organization holds the person out while it is open (lib/auth/held-out.ts): from the
 * first refusal for it, the held page, at once, in place of every screen of the organization.
 */
export function HeldOutGate({ children }: { children: ReactNode }) {
  const refusal = useSyncExternalStore(
    onHoldChange,
    heldOutRefusal,
    heldOutRefusal,
  );
  return refusal === undefined ? (
    children
  ) : (
    <CompanySignInPage refusal={refusal} />
  );
}

/**
 * The person's other organizations, to work in one of them instead. Nothing when they have none. Once the server has
 * switched, the app opens at home in the one they picked: the page they were on may be the held organization's own.
 */
function OtherOrganizations() {
  const current = useCurrentOrganizationId();
  const others = (useOrganizationChoices()?.organizations ?? []).filter(
    (organization) => organization.id !== current,
  );
  const switched = switchOrganizationMutationOptions(queryClient);
  const switching = useMutation({
    ...switched,
    /*
     * Once the server works in the one they picked, the app is loaded afresh at home there. Not navigated in place: this
     * page stands in for the sign-in gate's refusal, which the router kept showing after the gate let them through in
     * the new organization (seen on a real OpenBot, while the same steps passed against a fake). Loaded afresh, nothing
     * of the held organization is left to show. Here rather than on the call, whose callbacks are lost when the
     * refusal draws this page afresh.
     */
    onSuccess: async (...done) => {
      await switched.onSuccess?.(...done);
      heldPageDeps.openHome();
    },
  });
  if (others.length === 0) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              className="h-10 w-full tracking-tight"
              disabled={switching.isPending}
              size="lg"
              variant="outline"
            />
          }
        >
          {switching.isPending ? "Switching…" : SWITCH_ORGANIZATION}
          <IconChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-(--anchor-width)">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2">
              Organizations
            </DropdownMenuLabel>
            {others.map((organization) => (
              <DropdownMenuItem
                key={organization.id}
                onClick={() => switching.mutate(organization.id)}
              >
                {organization.personal ? <IconUserCircle /> : <IconBuilding />}
                <span className="min-w-0 truncate">{organization.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {switching.error ? (
        <p className="text-center text-destructive text-sm" role="alert">
          {failureSaid(switching.error)}
        </p>
      ) : null}
    </>
  );
}
