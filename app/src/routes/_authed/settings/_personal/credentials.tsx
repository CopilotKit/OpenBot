import { createFileRoute } from "@tanstack/react-router";
import { CredentialsPage } from "@/components/manage/credentials-page";

export const Route = createFileRoute("/_authed/settings/_personal/credentials")(
  { component: CredentialsPage },
);
