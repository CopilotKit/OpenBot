import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { openTeamFeatures } from "@/components/edition/team-features-dialog";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import {
  SidebarToggle,
  SidebarToggleBar,
} from "@/components/layout/sidebar-toggle";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Closed for this session only. The bar comes back the next time the app starts, or the next tab:
 * it is an offer, not a setting, so closing it is not saved anywhere that outlives the window.
 *
 * The desktop window hides when closed rather than quitting, so there it comes back after Quit.
 */
const DISMISSED = "openbot:business-link-dismissed";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED) === "1";
  } catch {
    // Storage refused (a locked-down browser): show it, and closing still works until a reload.
    return false;
  }
}

/**
 * The home page's top band, and in the personal edition its way to OpenBot for Business: the bar
 * Figma draws across the top of the page, whose link opens the OpenBot for Business dialog, with
 * its calendar, in the app.
 *
 * The same sentence as the team edition's self-host bar (`SelfHostBanner`), which the server never
 * turns on in the personal edition, so a person only ever sees one of the two.
 *
 * Until the deployment says which edition it is, and once the bar is closed, the band is the plain
 * one every screen keeps for the sidebar's toggle, at the bar's height, so nothing below it moves.
 */
export function BusinessLink() {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const [dismissed, setDismissed] = useState(readDismissed);

  if (capabilities?.edition !== "personal" || dismissed) {
    return <SidebarToggleBar />;
  }

  return (
    <AnnouncementBar
      action="Talk to an engineer"
      label="OpenBot for Business"
      leading={<SidebarToggle className="-ml-3.5" />}
      message="Self-host OpenBot for your organization."
      onAction={openTeamFeatures}
      onDismiss={() => {
        try {
          sessionStorage.setItem(DISMISSED, "1");
        } catch {
          // Closed for this page only.
        }
        setDismissed(true);
      }}
    />
  );
}
