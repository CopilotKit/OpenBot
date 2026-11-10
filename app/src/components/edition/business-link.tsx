import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Trademark } from "@/components/edition/brand-name";
import { Button, buttonVariants } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { BUSINESS_URL } from "@/lib/openbot-for-business";
import { cn } from "@/lib/utils";

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
 * The home page's link to OpenBot for Business, in the personal edition only.
 *
 * Hidden until the deployment says which edition it is, so it never flashes on a team deployment.
 */
export function BusinessLink() {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const [dismissed, setDismissed] = useState(readDismissed);

  if (capabilities?.edition !== "personal" || dismissed) return null;

  return (
    <span className="flex items-center gap-0.5">
      {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
      <a
        className={cn(
          buttonVariants({ size: "sm", variant: "ghost" }),
          "text-muted-foreground",
        )}
        href={BUSINESS_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        <span>
          Meet OpenBot for Business
          <Trademark />
        </span>
      </a>
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
