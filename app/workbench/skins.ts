/*
 * The app frame's skin and sidebar, and the scenes that walk every skin with the sidebar open and
 * closed.
 *
 * The skin is saved on the person's account (`skin` in their preferences), and SkinAccountSync
 * (app/src/skins/account-sync.tsx) applies the account's skin over the stored one once the
 * preferences load. So a frame with a skin answers the preferences read with it, as well as having
 * it in storage (appFrameConfig), where the app reads it before the first paint.
 */

import type { Preferences } from "@/lib/api/generated/model";
import { getGetPreferencesResponseMock } from "@/lib/api/generated/people/people.msw";
import {
  type ApiAnswer,
  type ApiRoute,
  type AppSkin,
  PREFERENCES_ROUTE,
} from "../../desktop/workbench/appContract";

/** The preferences answer for a skin, or none (the scene's own answers) for no skin. */
export function skinApi(
  skin: AppSkin | null,
): Partial<Record<ApiRoute, ApiAnswer>> {
  if (skin === null) return {};
  const body = {
    ...getGetPreferencesResponseMock(),
    skin,
  } satisfies Preferences;
  return { [PREFERENCES_ROUTE]: { mode: "value", body } };
}
