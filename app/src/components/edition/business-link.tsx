import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Trademark } from "@/components/edition/brand-name";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { openTeamFeatures } from "@/components/edition/team-features-dialog";
import { Button } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Closed for this session only. The link comes back the next time the app starts, or the next tab:
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
 * The home page's way to OpenBot for Business, in the personal edition only. It opens the OpenBot
 * for Business dialog, with its calendar, in the app.
 *
 * An outlined button with OpenBot's mark, so it reads as an offer at a glance without competing
 * with the greeting and the composer below it.
 *
 * Hidden until the deployment says which edition it is, so it never flashes on a team deployment.
 */
export function BusinessLink() {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const [dismissed, setDismissed] = useState(readDismissed);

  if (capabilities?.edition !== "personal" || dismissed) return null;

  return (
    <span className="flex items-center gap-1">
      <Button onClick={openTeamFeatures} size="sm" variant="outline">
        <OpenBotLogo />
        <span>
          Meet OpenBot for Business
          <Trademark />
        </span>
      </Button>
      <Button
        aria-label="Close"
        className="text-muted-foreground"
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISSED, "1");
          } catch {
            // Closed for this page only.
          }
          setDismissed(true);
        }}
        size="icon-xs"
        variant="ghost"
      >
        <IconX />
      </Button>
    </span>
  );
}
