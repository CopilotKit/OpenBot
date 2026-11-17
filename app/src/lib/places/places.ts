import { type Icon, IconBolt, IconPlayerPlay } from "@tabler/icons-react";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { appConfig } from "@/lib/generated/application-config";
import { primitive } from "@/lib/primitives";

export const PLACE_IDS = [
  "openbot",
  "conversations",
  "bots",
  "routines",
  "at-work",
] as const;

export type PlaceId = (typeof PLACE_IDS)[number];

export const DEFAULT_PLACE: PlaceId = "conversations";

export const PLACES: Record<PlaceId, { label: string; icon: Icon }> = {
  openbot: { label: appConfig.brand.productName, icon: OpenBotLogo },
  conversations: {
    label: primitive("conversations").label,
    icon: primitive("conversations").icon,
  },
  bots: { label: "Bots", icon: IconBolt },
  routines: {
    label: primitive("routines").label,
    icon: primitive("routines").icon,
  },
  "at-work": { label: "At work", icon: IconPlayerPlay },
};

/** The place whose pages these are, or null when the address belongs to no place but the one already chosen. */
export function placeForPath(pathname: string): PlaceId | null {
  const first = pathname.split("/")[1];
  if (first === "bots") return "bots";
  if (first === "routines") return "routines";
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
