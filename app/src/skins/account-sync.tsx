import { useIsMutating } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  saveSkinMutationKey,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { parseStoredSkin, setSkin } from "./store";

/**
 * Draws the skin saved on the person's account, whenever their preferences load or change.
 *
 * The browser's cache paints first, so a reload never flashes the default. When the account says
 * otherwise (the person chose another skin on another device, or somebody else used this browser
 * before them), the account wins. Mounted once, inside the signed-in boundary.
 *
 * While the person's own save is out it stands aside: the picker already drew their choice, and a
 * read that started before the save would otherwise put the old skin back for a moment.
 */
export function SkinAccountSync() {
  const accountSkin = useUserPreferences().data?.skin;
  const saving = useIsMutating({ mutationKey: saveSkinMutationKey }) > 0;

  useEffect(() => {
    if (saving || accountSkin === undefined) return;
    setSkin(parseStoredSkin(accountSkin));
  }, [accountSkin, saving]);

  return null;
}
