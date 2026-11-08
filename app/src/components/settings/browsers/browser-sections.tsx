import {
  RECORDER_DISCLOSURE_TITLE,
  recorderDisclosureFor,
} from "@openbot/shared/recorder-disclosure";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { RecorderCollectsRows } from "@/components/recorder/recorder-collects";
import { ConnectedBrowsers } from "@/components/settings/browsers/connected-browsers";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * What the Recorder collects, first, so the person reads it before they connect a browser (the Recorder's own setup page
 * says the same, from the same sentences); then this browser's Recorder, then every browser connected as you, the row
 * of this browser's own copy marked.
 *
 * Where a recording goes is said for the edition: an organization's OpenBot in the team edition, the person's own
 * Learning space in the personal one, which has no organization.
 */
export function BrowserSections() {
  const [thisInstallId, setThisInstallId] = useState<string>();
  const edition = useQuery(deploymentCapabilitiesQueryOptions()).data?.edition;
  return (
    <>
      <PageSection
        title={RECORDER_DISCLOSURE_TITLE}
        description={recorderDisclosureFor(edition)}
      >
        <RecorderCollectsRows />
      </PageSection>
      <ThisBrowser onInstallId={setThisInstallId} />
      <ConnectedBrowsers thisInstallId={thisInstallId} />
    </>
  );
}
