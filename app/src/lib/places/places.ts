import { type Icon, IconBolt } from "@tabler/icons-react";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { primitive } from "@/lib/primitives";

/**
 * `openbot` is the For you place: the id stays what browsers already remember. What a Bot does on
 * its own is a setting on the Bot ("When it works"), so it has no place of its own; a browser that
 * remembered the old Routines place starts in For you.
 */
export const PLACE_IDS = ["openbot", "conversations", "bots"] as const;

export type PlaceId = (typeof PLACE_IDS)[number];

/** A new browser starts in For you, which holds the latest conversations as well as what needs the person. */
export const DEFAULT_PLACE: PlaceId = "openbot";

export const PLACES: Record<PlaceId, { label: string; icon: Icon }> = {
  openbot: { label: "For you", icon: OpenBotLogo },
  conversations: {
    label: primitive("conversations").label,
    icon: primitive("conversations").icon,
  },
  bots: { label: "Bots", icon: IconBolt },
};

/**
 * The place whose pages these are, or null when the address belongs to no place but the one already
 * chosen. A routine's pages are a Bot's: what it does on its own is part of the Bot.
 */
export function placeForPath(pathname: string): PlaceId | null {
  const first = pathname.split("/")[1];
  if (first === "bots" || first === "routines") return "bots";
  return null;
}

function isPlaceId(value: unknown): value is PlaceId {
  return PLACE_IDS.some((id) => id === value);
}

export function parseStoredPlace(value: string | null): PlaceId {
  return isPlaceId(value) ? value : DEFAULT_PLACE;
}

/** Known ids in the stored order, then any the stored order did not have, in the default order. */
export function parseStoredOrder(value: string | null): PlaceId[] {
  let parsed: unknown;
  try {
    parsed = value === null ? null : JSON.parse(value);
  } catch {
    return [...PLACE_IDS];
  }
  if (!Array.isArray(parsed)) return [...PLACE_IDS];
  const order: PlaceId[] = [];
  for (const id of parsed) {
    if (isPlaceId(id) && !order.includes(id)) order.push(id);
  }
  for (const id of PLACE_IDS) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

/** A new order with `id` swapped one step; a copy of the same order at either end or when `id` is not in it. */
export function movePlace(
  order: readonly PlaceId[],
  id: PlaceId,
  delta: -1 | 1,
): PlaceId[] {
  const next = [...order];
  const from = next.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The place the person is in, for this tab only. */
export const PLACE_STORAGE_KEY = "openbot-place";
/** The order of the strip, kept across visits. */
export const PLACE_ORDER_STORAGE_KEY = "openbot-place-order";
/** Whether the places strip is on, kept across visits. */
export const PLACES_FLAG_STORAGE_KEY = "openbot-places";
export const PLACES_DEFAULT_ON = false;

/**
 * `?places=on` or `?places=off` sets the switch and is remembered; without one, what was
 * remembered stands, and with nothing remembered the default does. Storage that throws counts as
 * nothing remembered.
 */
export function readPlacesFlag(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem">,
): boolean {
  const asked = new URLSearchParams(search).get("places");
  if (asked === "on" || asked === "off") {
    try {
      storage.setItem(PLACES_FLAG_STORAGE_KEY, asked);
    } catch {}
    return asked === "on";
  }
  let stored: string | null = null;
  try {
    stored = storage.getItem(PLACES_FLAG_STORAGE_KEY);
  } catch {}
  if (stored === "on" || stored === "off") return stored === "on";
  return PLACES_DEFAULT_ON;
}
