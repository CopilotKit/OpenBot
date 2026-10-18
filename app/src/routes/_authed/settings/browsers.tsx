import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { ConnectedBrowsers } from "@/components/settings/browsers/connected-browsers";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";

export const Route = createFileRoute("/_authed/settings/browsers")({
  component: BrowsersPage,
});

/** Connect the OpenBot Recorder in this browser, and see or disconnect every browser connected as you. */
function BrowsersPage() {
  return (
    <PageShell
      title="Browsers"
      description="Connect the OpenBot Recorder in this browser to teach a Bot by doing a task yourself."
    >
      <ThisBrowser />
      <ConnectedBrowsers />
    </PageShell>
  );
}
