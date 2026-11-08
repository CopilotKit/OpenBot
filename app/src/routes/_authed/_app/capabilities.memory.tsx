import { createFileRoute, redirect } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/capabilities/memory")({
  // The personal edition has no memory (see `offersMemory`), so its Bots page is where this goes.
  // `/memory` and `/settings/memory` forward here and land there too.
  beforeLoad: async ({ context }) => {
    if (!(await deploymentOffersMemory(context.queryClient))) {
      throw redirect({ to: "/bots", replace: true });
    }
  },
  component: MemoryPage,
});

function MemoryPage() {
  return (
    <CapabilitiesShell>
      <MemoryList
        action={<RememberFact />}
        description="Manage what your Bots remember about you. Facts you add are shared with all Bots; learned facts stay with the Bot that learned them."
      />
    </CapabilitiesShell>
  );
}
