import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

/**
 * Memory: what your Bots remember about you, and facts you add for all of them. The every-Bot page
 * of Memory, in the main menu beside Bots; which apps one Bot learns from is on that Bot's Memory
 * page.
 */
export const Route = createFileRoute("/_authed/_app/memory")({
  // The personal edition has no memory (see `offersMemory`), so its Bots page is where this goes.
  // `/settings/memory` and `/capabilities/memory` forward here and land there too.
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
      description="Your Bots remember facts about you, like your role and how you like to work, and use them in every conversation. Facts you add, or ask a Bot to remember, reach all your Bots. A fact a Bot notices by itself stays with that Bot, and you can confirm or forget it here."
      title="Memory"
    >
      <MemoryList action={<RememberFact />} />
    </PageShell>
  );
}
