import { createFileRoute } from "@tanstack/react-router";
import { InvitationPage } from "@/components/organizations/invitations-page";
import { organizationsOnly } from "@/lib/organizations/guard";

export const Route = createFileRoute("/_authed/_app/invitations/$invitationId")(
  {
    beforeLoad: organizationsOnly,
    component: RouteComponent,
  },
);

/** The page an invitation's link opens, for whoever is signed in, in whichever organization. */
function RouteComponent() {
  const { invitationId } = Route.useParams();
  return <InvitationPage invitationId={invitationId} />;
}
