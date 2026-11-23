import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SetupChecklist } from "@/components/setup/setup-checklist";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { mayOpenSetup } from "@/lib/setup/queries";

/**
 * Settings → Setup: the setup checklist, where an admin checks what OpenBot has and still needs. Its
 * fixes say "set this, then restart OpenBot", so this is where they come back to check again.
 *
 * On a hosted OpenBot (`hostedSignIn`) nobody in an organization sets a variable or restarts
 * anything: OpenBot by CopilotKit runs it. The server sends its admin only fixes that are a page in
 * the app, so the description says to use those and leaves the rest to OpenBot by CopilotKit.
 *
 * For an admin, and for the one person running OpenBot on their own machine. A member is sent to
 * General: they can't change any of it, and their admin sets it up.
 */
export const Route = createFileRoute("/_authed/settings/setup")({
  beforeLoad: async ({ context }) => {
    const [user, capabilities] = await Promise.all([
      context.queryClient.ensureQueryData(currentUserQueryOptions()),
      // A failed read means no local install is known of, so the role alone decides.
      context.queryClient
        .ensureQueryData(deploymentCapabilitiesQueryOptions())
        .catch(() => undefined),
    ]);
    if (!mayOpenSetup(user, capabilities)) throw redirect({ to: "/settings" });
  },
  component: SetupSettingsPage,
});

function SetupSettingsPage() {
  const navigate = useNavigate();
  const hosted =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;
  return (
    <PageShell
      description={
        hosted
          ? "See what's ready and what still needs setting up. Fix what you can on the page a row links to, then check again here. OpenBot by CopilotKit looks after the rest."
          : "See what's ready and what still needs setting up. After you change a setting and restart OpenBot, check again here."
      }
      title="Setup"
    >
      <SetupChecklist openPage={(target) => navigate({ to: target.path })} />
    </PageShell>
  );
}
