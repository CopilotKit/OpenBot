import { createFileRoute } from "@tanstack/react-router";
import { ProvidersSettingsPage } from "@/components/settings/provider-pages";

export const Route = createFileRoute("/_authed/settings/providers")({
  component: ProvidersSettingsPage,
});
