import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { BrowserNotifications } from "@/components/settings/browser-notifications";
import { CheckInsSection } from "@/components/settings/check-ins";
import { NativeDevices, RecentDeliveries } from "@/components/settings/devices";
import { UpdateRoutingSection } from "@/components/settings/update-routing";

export const Route = createFileRoute("/_authed/settings/notifications")({
  component: NotificationsPage,
});

/**
 * Where your Bots' updates reach you, for all of your Bots at once: whether they check in for you
 * at all (the first section), which kinds go where, this browser's push notifications, and the
 * phones that get them. Each Bot's own page says how much.
 */
function NotificationsPage() {
  return (
    <PageShell
      description="Choose where you receive updates when you’re away. Set each Bot’s update frequency on its page."
      title="Notifications"
    >
      <CheckInsSection />
      <UpdateRoutingSection />
      <BrowserNotifications />
      <NativeDevices />
      <RecentDeliveries />
    </PageShell>
  );
}
