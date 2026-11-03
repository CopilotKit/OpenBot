import { createFileRoute } from "@tanstack/react-router";
import { NewCredentialPage } from "@/components/manage/new-credential-page";

export const Route = createFileRoute(
  "/_authed/settings/_personal/credentials_/new",
)({ component: NewCredentialPage });
