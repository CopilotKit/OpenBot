import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";

export const Route = createFileRoute("/_authed/settings/memory")({
  component: MemorySettingsPage,
});

function MemorySettingsPage() {
  return (
    <PageShell
      action={<RememberFact />}
      description="What your Bots know about you. Facts you tell them reach every Bot; what a Bot learns stays with that Bot."
      title="Memory"
    >
      <MemoryList />
    </PageShell>
  );
}
