import { createFileRoute } from "@tanstack/react-router";
import { InvitationsPage } from "@/components/organizations/invitations-page";
import { organizationsOnly } from "@/lib/organizations/guard";

export const Route = createFileRoute("/_authed/_app/invitations/")({
  beforeLoad: organizationsOnly,
  component: InvitationsPage,
});
