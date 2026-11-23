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
  APP_SIDEBARS,
  APP_SKINS,
  type ApiAnswer,
  type ApiRoute,
  type AppRunStep,
  type AppScene,
  type AppSidebar,
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

/** The words for a skin in a scene's title. */
const SKIN_NAMES: Record<AppSkin, string> = {
  openbot: "OpenBot",
  openduet: "OpenDuet",
  opendots: "OpenDots",
  openfuse: "OpenFuse",
};

/**
 * The sidebar states each skin has. OpenBot keeps its sidebar open or closed in storage
 * (app/src/lib/sidebar.ts); OpenDots keeps its own in React state only (`navCollapsed` in
 * app/src/skins/opendots/frame.tsx), so its closed scene presses "Collapse sidebar" at 1 s; OpenDuet
 * and OpenFuse draw no sidebar (a menu sheet instead), so they get one scene each.
 */
export const SKIN_SIDEBARS: Record<AppSkin, readonly AppSidebar[] | null> = {
  openbot: APP_SIDEBARS,
  openduet: null,
  opendots: APP_SIDEBARS,
  openfuse: null,
};

/** How a skin's sidebar is closed when storage cannot do it: a run step. */
const CLOSE_STEPS: Partial<Record<AppSkin, AppRunStep[]>> = {
  opendots: [{ at: 1, click: "Collapse sidebar" }],
};

/**
 * One scene per skin and sidebar state, from a scene: `<id>-<skin>-sidebar-<open|closed>`, or
 * `<id>-<skin>` for a skin with no sidebar, in the group "App: Skins". The check walks each, so a
 * layout that only goes wrong in one skin, or with the sidebar closed (the window buttons over the
 * page's own header, say), is found too.
 */
export function skinScenes(scene: AppScene): AppScene[] {
  return APP_SKINS.flatMap((skin): AppScene[] => {
    const sidebars = SKIN_SIDEBARS[skin];
    if (!sidebars)
      return [
        {
          ...scene,
          id: `${scene.id}-${skin}`,
          title: `${scene.title}: ${SKIN_NAMES[skin]}`,
          group: "App: Skins",
          start: { ...scene.start, skin },
        },
      ];
    return sidebars.map(
      (sidebar): AppScene => ({
        ...scene,
        id: `${scene.id}-${skin}-sidebar-${sidebar}`,
        title: `${scene.title}: ${SKIN_NAMES[skin]}, sidebar ${sidebar}`,
        group: "App: Skins",
        start: { ...scene.start, skin, sidebar },
        ...(sidebar === "closed" && CLOSE_STEPS[skin]
          ? { run: [...(CLOSE_STEPS[skin] ?? []), ...(scene.run ?? [])] }
          : {}),
      }),
    );
  });
}
