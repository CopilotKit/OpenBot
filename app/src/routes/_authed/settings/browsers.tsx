import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { BrowserSections } from "@/components/settings/browsers/browser-sections";

export const Route = createFileRoute("/_authed/settings/browsers")({
  component: BrowsersPage,
});

/** Connect the OpenBot Recorder in this browser, and see or disconnect every browser connected as you. */
function BrowsersPage() {
  return (
    <PageShell
      title="Browsers"
      description="Connect the OpenBot Recorder in this browser to teach your Bots by doing a task yourself. What you record goes into your own Learning space."
    >
      <BrowserSections />
    </PageShell>
  );
}
