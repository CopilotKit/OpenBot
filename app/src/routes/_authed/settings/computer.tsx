import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { ComputersPage } from "@/components/manage/computers-page";
import { BrowserSections } from "@/components/settings/browsers/browser-sections";
import { ThisComputerSections } from "@/components/settings/this-computer-sections";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { editionOf } from "@/lib/edition-guard";
import { useScrollToSection } from "@/lib/settings/computer-sections";

/**
 * Settings → Computer: where your Bots browse, run commands and keep files, for every Bot. It was
 * the personal edition's Computer, This computer and Browsers. Each section shows only where it
 * exists:
 *
 * 1. The computer your Bots work on, with their browsers and Reset, and the folders on this
 *    computer they may read: the personal edition's. In the team edition those are an admin's,
 *    under Admin.
 * 2. This computer: what OpenBot runs here, with Restart and Stop. Only inside OpenBot Desktop.
 * 3. The browsers signed in to the Recorder as you.
 *
 * An address may name a section in its hash (`COMPUTER_SECTION`), and the page opens there.
 *
 * A Bot's own part of this (its folders, its browser) is on its Computer page.
 */
export const Route = createFileRoute("/_authed/settings/computer")({
  // The edition decides where the disclosure says a recording goes, so it is read before the page draws.
  beforeLoad: async ({ context }) => {
    await editionOf(context.queryClient);
  },
  component: ComputerPage,
});

function ComputerPage() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const desktop = desktopShell() !== null;
  // Desktop's Status and the extension's popup open this page at their section.
  useScrollToSection();
  return (
    <PageShell
      description={
        personal
          ? "Your Bots share one computer, where each keeps its own browser signed in. A command one Bot runs can still read another Bot's files. Choose folders they can read here, and connect the browsers you teach them in."
          : desktop
            ? "Connect the browsers you teach your Bots in, and see what OpenBot runs on this computer."
            : "Connect the browsers you teach your Bots in."
      }
      title="Computer"
    >
      {personal ? <ComputersPage embedded /> : null}
      {desktop ? <ThisComputerSections /> : null}
      <BrowserSections />
    </PageShell>
  );
}
