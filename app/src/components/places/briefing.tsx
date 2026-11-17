import { useWaitingCount } from "@/components/bot-profile/attention";
import { Button } from "@/components/ui/button";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { useAtWork } from "@/lib/places/at-work";
import { briefingParts } from "@/lib/places/openbot-sections";
import type { PlaceId } from "@/lib/places/places";
import { setPlace } from "@/lib/places/store";

/**
 * WHAT NEEDS THE PERSON AND WHAT IS WORKING, said on the home page while places are on: a line at the foot of the page
 * with one button for each thing there is to say. A button shows its place in the sidebar, opened if it was shut.
 * Floats over the page on a solid surface like the working note it replaces, and is drawn only when there is something
 * to say.
 */
export function Briefing() {
  const parts = briefingParts(useWaitingCount(), useAtWork().rows.length);
  const sidebar = useOptionalSidebar();
  if (parts.needsYou === null && parts.working === null) return null;

  const show = (place: PlaceId) => {
    setPlace(place);
    if (!sidebar) return;
    if (sidebar.isMobile) sidebar.setOpenMobile(true);
    else sidebar.setOpen(true);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-popover p-1 text-popover-foreground shadow-lg">
        {parts.needsYou !== null ? (
          <Button
            className="rounded-full px-3 py-1.5 text-sm"
            onClick={() => show("openbot")}
            type="button"
            variant="ghost"
          >
            {parts.needsYou}
          </Button>
        ) : null}
        {parts.working !== null ? (
          <Button
            className="rounded-full px-3 py-1.5 text-sm"
            onClick={() => show("at-work")}
            type="button"
            variant="ghost"
          >
            {parts.working}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
