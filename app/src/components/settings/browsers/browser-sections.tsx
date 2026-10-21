import { useState } from "react";
import { ConnectedBrowsers } from "@/components/settings/browsers/connected-browsers";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";

/** This browser's Recorder, then every browser connected as you, the row of this browser's own copy marked. */
export function BrowserSections() {
  const [thisInstallId, setThisInstallId] = useState<string>();
  return (
    <>
      <ThisBrowser onInstallId={setThisInstallId} />
      <ConnectedBrowsers thisInstallId={thisInstallId} />
    </>
  );
}
