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

const entries: Record<PlaceId, PlaceEntry | undefined> = {
  openbot: openbotPlace,
  conversations: conversationsPlace,
  bots: botsPlace,
  routines: routinesPlace,
  "at-work": atWorkPlace,
};

/** The places that have a list, each registered by its own file. The strip draws a button for each. */
export const PLACE_LISTS: Partial<Record<PlaceId, PlaceEntry>> = {};
for (const [id, entry] of Object.entries(entries)) {
  if (entry) PLACE_LISTS[id as PlaceId] = entry;
}

export function PlacePanel() {
  const place = usePlaceId();
  // A place with no list yet, such as Bots before its own task lands, draws the Conversations
  // list; the store keeps the place that was chosen.
  const shown: PlaceId = PLACE_LISTS[place] ? place : "conversations";
  const Entry = PLACE_LISTS[shown] as PlaceEntry;
  const scrollRoot = useRef<HTMLDivElement>(null);

  return (
    <>
      <SidebarHeader className="h-12 flex-row items-center justify-between p-2">
        <h2 className="truncate px-2 font-semibold text-[14px] tracking-tighter">
          <BrandName>{PLACES[shown].label}</BrandName>
        </h2>
        {Entry.Action ? <Entry.Action /> : null}
      </SidebarHeader>
      <SidebarContent ref={scrollRoot} className="scroll-fade-b">
        <Entry.List scrollRoot={scrollRoot} />
      </SidebarContent>
    </>
  );
}
