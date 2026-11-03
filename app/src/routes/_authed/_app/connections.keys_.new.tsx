import { createFileRoute } from "@tanstack/react-router";
import { NewCredentialPage } from "@/components/manage/new-credential-page";
import { personalOnly } from "@/lib/edition-guard";

export const Route = createFileRoute("/_authed/_app/connections/keys_/new")({
  beforeLoad: personalOnly("/connections"),
  component: NewCredentialPage,
});
