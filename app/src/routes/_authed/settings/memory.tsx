import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

/**
 * Settings → Memory: what your Bots remember about you, and facts you add for all of them. The
 * every-Bot page of Memory; which apps one Bot learns from is on that Bot's Memory page.
 */
export const Route = createFileRoute("/_authed/settings/memory")({
  // The personal edition has no memory (see `offersMemory`), so its Bots page is where this goes.
  // `/memory` and `/capabilities/memory` forward here and land there too.
  beforeLoad: async ({ context }) => {
    if (!(await deploymentOffersMemory(context.queryClient))) {
      throw redirect({ to: "/bots", replace: true });
    }
  },
  component: MemoryPage,
});

function MemoryPage() {
  return (
    <PageShell
      className="@container"
      description="Manage what your Bots remember about you. Facts you add are shared with all Bots; learned facts stay with the Bot that learned them."
      title="Memory"
    >
      <MemoryList action={<RememberFact />} />
    </PageShell>
  );
}
