import { useQuery } from "@tanstack/react-query";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { Button } from "@/components/ui/button";
import { companySignInQueryOptions } from "@/lib/auth/company-sign-in";
import { LinkCompanyAccount } from "./link-company-account";

/**
 * The page for a member an organization holds out until they sign in through their company's identity provider
 * (Require SSO): somebody who joined by invitation, signed in some other way. Every screen of the organization is
 * refused to them, so this stands in for whichever one they opened, in the sign-in screen's own layout.
 *
 * It says why in the server's own sentence, and offers the way in: Link your company account, through a provider that
 * counts for the organization, which the server tells them even while it holds them out. Sign out is always there.
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
