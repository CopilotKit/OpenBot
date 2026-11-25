import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Button, buttonVariants } from "@/components/ui/button";
import { type HostedInvitation, hostedSignInAddress } from "@/lib/auth/hosted";
import { authProvidersQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { searchTextEntry } from "@/lib/search-text";
import { cn } from "@/lib/utils";

/**
 * Where the button in a hosted OpenBot's invitation email opens: `?ticket=` is the invitation's
 * one-time ticket and `?organization=` the OpenBot organization it invites to. `__clerk_ticket` is
 * the same ticket under the name the hosted sign-in gives it, when somebody opens the hosted sign-in's
 * own invitation link and it sends them here, with `__clerk_status` beside it (see `invitationFrom`).
 *
 * Not behind sign-in: the person invited usually has no OpenBot account yet. The page says it is
 * joining, then leaves for the hosted sign-in carrying the ticket, which signs them in or up with it
 * (up, with the address from the invitation, when the hosted sign-in says it has no account yet)
 * and brings them back to this OpenBot working in the organization. Somebody already signed in goes
 * the same way, so they land in the organization they were invited to.
 *
 * Without a ticket, or on an OpenBot that does not sign in through the hosted sign-in, there is
 * nothing to carry, so the page says so and offers the way into OpenBot, where any invitation waits.
 *
 * Every value is read as the text it was in the address (`searchText`): a ticket made of digits must
 * not become a number, or a different ticket.
 */
export const Route = createFileRoute("/accept-invite")({
  validateSearch: (search: Record<string, unknown>): AcceptInviteSearch => ({
    ...searchTextEntry("ticket", search.ticket),
    ...searchTextEntry("__clerk_ticket", search.__clerk_ticket),
    ...searchTextEntry("__clerk_status", search.__clerk_status),
    ...searchTextEntry("organization", search.organization),
  }),
  beforeLoad: async ({ context }) => {
    // Loaded first, like the sign-in screen, so the page paints with its answer. A failure is the
    // page's to say, not the router's.
    await context.queryClient
      .ensureQueryData(authProvidersQueryOptions())
      .catch(() => undefined);
  },
  component: AcceptInviteScreen,
});

type AcceptInviteSearch = {
  ticket?: string;
  __clerk_ticket?: string;
  __clerk_status?: string;
  organization?: string;
};

/**
 * What the hosted sign-in should carry for the invitation in the address: its ticket and
 * organization; only the organization once the hosted sign-in says it is already accepted; or null
 * when the address carries no invitation at all.
 *
 * `__clerk_status=complete` is the hosted sign-in reporting that the person already had an account
 * and is signed in there, with the invitation accepted. The ticket is spent then, so it is not
 * passed on, and the person still has to sign in to this OpenBot, in that organization.
 *
 * `__clerk_status=sign_up` is the hosted sign-in reporting that the invited address has no account
 * yet. It is carried on, so the person is sent to sign up with the ticket, which takes the address
 * from the invitation. A sign-in with the ticket could only tell them there is no such account.
 */
function invitationFrom(
  search: AcceptInviteSearch,
): { invitation?: HostedInvitation } | null {
  const organizationId = search.organization?.trim() || undefined;
  if (search.__clerk_status === "complete")
    return organizationId ? { invitation: { organizationId } } : {};
  const ticket = (search.ticket ?? search.__clerk_ticket)?.trim();
  if (!ticket) return null;
  const signUp = search.__clerk_status === "sign_up";
  return {
    invitation: {
      ticket,
      ...(organizationId ? { organizationId } : {}),
      ...(signUp ? { signUp } : {}),
    },
  };
}

function AcceptInviteScreen() {
  const carried = invitationFrom(Route.useSearch());
  const signIn = useQuery(authProvidersQueryOptions());
  const hosted = signIn.data?.hosted === true;
  /*
   * Back to this OpenBot's own origin, like every sign-in; the server sends a person back nowhere
   * else whatever this says. `replace`, so Back from the hosted sign-in does not land here and send
   * the person straight out again.
   */
  const leaveFor =
    carried !== null && hosted
      ? hostedSignInAddress(window.location.origin, carried.invitation)
      : null;

  useEffect(() => {
    if (leaveFor) window.location.replace(leaveFor);
  }, [leaveFor]);

  if (signIn.isPending) return null;

  if (leaveFor)
    return (
      <AcceptInviteFrame
        title="Joining your organization…"
        description={`Taking you to ${appConfig.brand.productName} to accept the invitation.`}
      />
    );

  if (signIn.isError)
    return (
      <AcceptInviteFrame
        title="Couldn't open the invitation"
        description={`Couldn't reach ${appConfig.brand.productName}. Try again in a moment.`}
      >
        <Button
          className="h-10 w-full tracking-tight"
          disabled={signIn.isFetching}
          onClick={() => void signIn.refetch()}
          size="lg"
          variant="outline"
        >
          {signIn.isFetching ? "Trying again…" : "Try again"}
        </Button>
      </AcceptInviteFrame>
    );

  return (
    <AcceptInviteFrame
      title="Couldn't open the invitation"
      description={
        carried === null
          ? "This link is missing part of the invitation. Open it again from your email, or sign in to see your invitations."
          : "Sign in to see your invitations."
      }
    >
      <Link
        className={cn(
          buttonVariants({ size: "lg", variant: "outline" }),
          "h-10 w-full tracking-tight",
        )}
        to="/"
      >
        Open {appConfig.brand.productName}
      </Link>
    </AcceptInviteFrame>
  );
}

/** The sign-in screen's own layout: the orb, a heading, one line, and what to do next. */
function AcceptInviteFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="-mt-12 flex h-dvh w-full flex-col items-center justify-center">
      <div className="flex w-full max-w-82 flex-col items-center p-4">
        <AgentOrb size="56px" />
        <h1 className="mt-8 text-center font-medium text-2xl tracking-tight">
          {title}
        </h1>
        <p
          className="mt-3 text-pretty text-center text-muted-foreground text-sm"
          role="status"
        >
          {description}
        </p>
        {children ? (
          <div className="mt-8 flex w-full flex-col gap-2">{children}</div>
        ) : null}
      </div>
    </div>
  );
}
