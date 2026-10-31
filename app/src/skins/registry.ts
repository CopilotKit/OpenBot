import { appConfig } from "@/lib/generated/application-config";
import { opendots } from "./opendots";
import { openduet } from "./openduet";
import { openmuse } from "./openmuse";
import { useSkinId } from "./store";
import type { Skin, SkinId } from "./types";

/*
 * The default is the product as `brand.yaml` names it, so a deployment that renames OpenBot sees
 * its own name here too. The description says nothing a rename could make untrue.
 */
const openbot: Skin = {
  id: "openbot",
  name: appConfig.brand.productName,
  description: "The standard look, with your conversations in a sidebar.",
};

/** Keyed by every id in `SKIN_IDS`, so a skin cannot be listed without being registered. */
export const SKINS: Record<SkinId, Skin> = {
  openbot,
  openduet,
  opendots,
  openmuse,
};

export function useActiveSkin(): Skin {
  return SKINS[useSkinId()];
}
