import { useRef } from "react";
import { BrandName } from "@/components/edition/brand-name";
import { SidebarContent, SidebarHeader } from "@/components/ui/sidebar";
import { PLACES, type PlaceId } from "@/lib/places/places";
import { usePlaceId } from "@/lib/places/store";
import { atWorkPlace } from "./at-work-place";
import { botsPlace } from "./bots-place";
import { conversationsPlace } from "./conversations-place";
import { openbotPlace } from "./openbot-place";
import type { PlaceEntry } from "./place-row";
import { routinesPlace } from "./routines-place";

/** The list each place draws, registered by its own file. The strip draws a button for each. */
export const PLACE_LISTS: Record<PlaceId, PlaceEntry> = {
  openbot: openbotPlace,
  conversations: conversationsPlace,
  bots: botsPlace,
  routines: routinesPlace,
  "at-work": atWorkPlace,
};

export function PlacePanel() {
  const place = usePlaceId();
  const Entry = PLACE_LISTS[place];
  const scrollRoot = useRef<HTMLDivElement>(null);

  return (
    <>
      <SidebarHeader className="h-12 flex-row items-center justify-between p-2">
        <h2 className="truncate px-2 font-semibold text-[14px] tracking-tighter">
          <BrandName>{PLACES[place].label}</BrandName>
        </h2>
        {Entry.Action ? <Entry.Action /> : null}
      </SidebarHeader>
      <SidebarContent ref={scrollRoot} className="scroll-fade-b">
        <Entry.List scrollRoot={scrollRoot} />
      </SidebarContent>
    </>
  );
}
