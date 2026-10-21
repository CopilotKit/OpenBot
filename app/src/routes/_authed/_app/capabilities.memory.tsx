import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";

export const Route = createFileRoute("/_authed/_app/capabilities/memory")({
  component: MemoryPage,
});

function MemoryPage() {
  return (
    <CapabilitiesShell>
      <MemoryList
        action={<RememberFact />}
        description="What your Bots know about you. Facts you tell them reach every Bot; what a Bot learns stays with that Bot."
      />
    </CapabilitiesShell>
  );
}
