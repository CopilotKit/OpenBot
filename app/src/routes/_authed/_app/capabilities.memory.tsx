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
        description="Manage what your Bots remember about you. Facts you add are shared with all Bots; learned facts stay with the Bot that learned them."
      />
    </CapabilitiesShell>
  );
}
