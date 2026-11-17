import type { RefObject } from "react";
import { ConversationRoster } from "@/components/app-sidebar/conversation-roster";
import type { PlaceEntry } from "./place-row";

export function ConversationsPlace({
  scrollRoot,
}: {
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  return <ConversationRoster scrollRoot={scrollRoot} />;
}

export const conversationsPlace: PlaceEntry | undefined = {
  List: ConversationsPlace,
};
