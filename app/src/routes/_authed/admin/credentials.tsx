import { createFileRoute } from "@tanstack/react-router";
import { CredentialsPage } from "@/components/manage/credentials-page";

export const Route = createFileRoute("/_authed/admin/credentials")({
  component: CredentialsPage,
});
