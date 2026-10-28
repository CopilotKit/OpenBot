import {
  RECORDER_DISCLOSURE,
  RECORDER_DISCLOSURE_TITLE,
} from "@openbot/shared/recorder-disclosure";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { RecorderCollectsRows } from "@/components/recorder/recorder-collects";
import { ConnectedBrowsers } from "@/components/settings/browsers/connected-browsers";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";

/**
 * What the Recorder collects, first, so the person reads it before they connect a browser (the Recorder's own setup page
 * says the same, from the same sentences); then this browser's Recorder, then every browser connected as you, the row
 * of this browser's own copy marked.
 */
export function BrowserSections() {
  const [thisInstallId, setThisInstallId] = useState<string>();
  return (
    <>
      <PageSection
        title={RECORDER_DISCLOSURE_TITLE}
        description={RECORDER_DISCLOSURE}
      >
        <RecorderCollectsRows />
      </PageSection>
      <ThisBrowser onInstallId={setThisInstallId} />
      <ConnectedBrowsers thisInstallId={thisInstallId} />
    </>
  );
}
