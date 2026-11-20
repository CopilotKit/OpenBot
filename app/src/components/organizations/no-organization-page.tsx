import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { CopilotKitMark } from "@/components/auth/provider-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { hostedSignInAddress } from "@/lib/auth/hosted";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { IN_NONE } from "@/lib/organizations/in-no-organization";
import { organizationKeys } from "@/lib/organizations/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * The page for somebody signed in who is in no organization here: never added, or removed from the last one. Every
 * screen of the app works in an organization, so this stands in for whichever one they opened, in the sign-in screen's
 * own layout, and offers only what acts on no organization.
 *
 * Try again reads their organizations afresh, for somebody added again meanwhile. On a hosted OpenBot, signing in again
 * through OpenBot by CopilotKit is how a membership added there reaches this OpenBot, so that is offered first. Sign out
 * is always there.
 */
export function NoOrganizationPage() {
  const router = useRouter();
  const signOut = useSignOut();
  const [retrying, setRetrying] = useState(false);
  const hosted =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;

  const tryAgain = async () => {
    setRetrying(true);
    try {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center">
      <div className="flex w-full max-w-82 flex-col items-center p-4">
        <AgentOrb size="56px" />
        <h1 className="mt-8 text-center font-medium text-2xl tracking-tight">
          You're not in an organization
        </h1>
        <p
          className="mt-3 text-pretty text-center text-muted-foreground text-sm"
          role="status"
        >
          {IN_NONE}
        </p>
        <div className="mt-8 flex w-full flex-col gap-2">
          {hosted ? (
            <a
              className={cn(
                buttonVariants({ size: "lg", variant: "outline" }),
                "h-10 w-full justify-start gap-3 px-3 tracking-tight",
              )}
              href={hostedSignInAddress(window.location.origin)}
            >
              <CopilotKitMark />
              <span className="flex-1 text-center">
                Continue with OpenBot by CopilotKit
              </span>
              <span aria-hidden="true" className="size-[18px]" />
            </a>
          ) : null}
          <Button
            className="h-10 w-full tracking-tight"
            disabled={retrying}
            onClick={() => void tryAgain()}
            size="lg"
            variant="outline"
          >
            {retrying ? "Trying again…" : "Try again"}
          </Button>
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
