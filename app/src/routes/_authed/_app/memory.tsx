import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { MemorySources } from "@/components/memory/sources";
export const Route = createFileRoute("/_authed/_app/memory")({
  component: MemoryPage,
});
function MemoryPage() {
  return (
    <PageShell
      title="Memory"
      description="Suggestions from your Bots, background research, and which connected apps feed them facts."
    >
      <div className="grid gap-6">
        <p className="text-muted-foreground text-sm">
          What your Bots remember about you, and facts you tell them, are in{" "}
          <Link className="underline underline-offset-4" to="/settings/memory">
            Settings → Memory
          </Link>
          .
        </p>
        <SuggestionsInbox />
        <ProactiveResearchSettings />
        <MemorySources />
      </div>
    </PageShell>
  );
}
