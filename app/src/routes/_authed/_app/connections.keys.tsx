import { createFileRoute } from "@tanstack/react-router";
import { CredentialsPage } from "@/components/manage/credentials-page";
import { personalOnly } from "@/lib/edition-guard";

/** The keys and tokens apps use, beside the apps. The personal edition's; see `manage-paths`. */
export const Route = createFileRoute("/_authed/_app/connections/keys")({
  beforeLoad: personalOnly("/connections"),
  component: CredentialsPage,
});
