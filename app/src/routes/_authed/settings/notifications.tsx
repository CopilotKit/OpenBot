import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { CheckInsSection } from "@/components/settings/check-ins";
import { NativeDevices, RecentDeliveries } from "@/components/settings/devices";
import { UpdateRoutingSection } from "@/components/settings/update-routing";

export const Route = createFileRoute("/_authed/settings/notifications")({
  component: NotificationsPage,
});

/**
 * Whether your Bots check in for you, and where their updates reach you, for all of your Bots at once.
 * Each Bot's own page says how much.
 */
function NotificationsPage() {
  return (
    <PageShell
      description="Choose where you receive updates when you’re away. Set each Bot’s update frequency on its page."
      title="Notifications"
    >
      <CheckInsSection />
      <UpdateRoutingSection />
      <NativeDevices />
      <RecentDeliveries />
    </PageShell>
  );
}
