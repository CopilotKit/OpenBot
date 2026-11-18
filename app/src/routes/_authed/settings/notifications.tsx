import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { CheckInsSection } from "@/components/settings/check-ins";
import { NativeDevices, RecentDeliveries } from "@/components/settings/devices";
import { UpdateRoutingSection } from "@/components/settings/update-routing";

export const Route = createFileRoute("/_authed/settings/notifications")({
  component: NotificationsPage,
});

/**
 * Where your Bots' updates reach you, for all of your Bots at once. Each Bot's own page says how
 * much. Whether they check in for you is here too, as it is under Routines: with the places strip
 * there is no every-Bot Routines page, and this switch is the only way to turn check-ins back on.
 */
function NotificationsPage() {
  return (
    <PageShell
      description="Choose where you receive updates when you’re away. Set each Bot’s update frequency on its page."
      title="Notifications"
    >
      <UpdateRoutingSection />
      <NativeDevices />
      <RecentDeliveries />
      <CheckInsSection title="Check-ins" />
    </PageShell>
  );
}
