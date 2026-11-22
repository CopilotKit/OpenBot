/*
 * Home scenes: the page a signed-in person lands on, with and without Bots, and the update banner
 * of OpenBot Desktop as it offers, downloads and installs a newer version.
 *
 * The banner (components/layout/update-banner.tsx) shows only inside OpenBot Desktop. It reads
 * `update_offer` (lib/desktop/queries.ts): every 60 s while its last answer has no install, every
 * 500 ms after an answer that has one. "Update and restart" calls `install_update`, which does not
 * answer until the app restarts (main.rs `install_app_update_now`), so the run answers it with
 * "never" and moves the install on through `update_offer`.
 *
 * What the scene shows, as the real app does: nothing reads `update_offer` again after the click
 * (the mutation never settles, so it does not refetch, and the next read is 60 s after the last).
 * So from 3 s to the end the banner says "Downloading…" with no share, beside "ready to install".
 * The answers at 3.5, 5 and 7 are there for the first read after the 60 s; this scene ends first.
 */

import type { AppScene } from "../../../desktop/workbench/appContract";
import { getListBotsResponseMock } from "../../src/lib/api/generated/bots/bots.msw";
import type { Bot, BotPage } from "../../src/lib/api/generated/model";
import type { DesktopAppUpdate } from "../../src/lib/desktop/queries";
import { DEFAULT_SESSION } from "../session";

const BOTS_ROUTE = "GET /api/v2/organizations/:organizationId/bots";
const UPDATE_OFFER = "plugin:openbot-desktop|update_offer";
const INSTALL_UPDATE = "plugin:openbot-desktop|install_update";

/** A Bot like the generated list's first, with a made-up id and name. */
function bot(id: string, name: string): Bot {
  const [first] = getListBotsResponseMock().bots;
  if (!first) throw new Error("The generated Bots list is empty.");
  return { ...first, id, name, avatarSeed: id };
}

const THREE_BOTS = {
  bots: [
    bot("general-assistant", "General Assistant"),
    bot("research-desk", "Research Desk"),
    bot("inbox-helper", "Inbox Helper"),
  ],
  nextCursor: null,
} satisfies BotPage;

const NO_BOTS = { bots: [], nextCursor: null } satisfies BotPage;

/** What `update_offer` says of version 1.3.0, with an install at `installing` (or none). */
function offer(installing: DesktopAppUpdate["installing"]): DesktopAppUpdate {
  return {
    version: "1.3.0",
    current: "1.2.0",
    installing,
    updatesItself: true,
    // Downloaded in the background: "OpenBot 1.3.0 is ready to install. It takes a few minutes."
    ready: { state: "ready" },
  } satisfies DesktopAppUpdate;
}

export const HOME_SCENES: readonly AppScene[] = [
  {
    kind: "app",
    id: "app-home-no-bots",
    title: "Home with no Bots",
    group: "App: Home",
    start: {
      route: "/",
      host: "desktop",
      session: DEFAULT_SESSION,
      api: { [BOTS_ROUTE]: { mode: "value", body: NO_BOTS } },
      agents: [],
    },
  },
  {
    kind: "app",
    id: "app-home-bots",
    title: "Home with Bots",
    group: "App: Home",
    start: {
      route: "/",
      host: "desktop",
      session: DEFAULT_SESSION,
      api: { [BOTS_ROUTE]: { mode: "value", body: THREE_BOTS } },
      agents: THREE_BOTS.bots.map((b) => b.id),
    },
  },
  {
    kind: "app",
    id: "app-update-offered",
    title: "An update is offered",
    group: "App: Home",
    start: {
      route: "/",
      host: "desktop",
      session: DEFAULT_SESSION,
      answers: { [UPDATE_OFFER]: { mode: "value", value: offer(null) } },
    },
    run: [
      // The person presses the banner's button. The app waits for the restart: no answer comes.
      { at: 3, answer: INSTALL_UPDATE, with: { mode: "never" } },
      { at: 3, click: "Update and restart" },
      // What the next read of the offer finds: a quarter downloaded ("Downloading… 25%").
      {
        at: 3.5,
        answer: UPDATE_OFFER,
        with: {
          mode: "value",
          value: offer({
            downloaded: 20_000_000,
            total: 80_000_000,
            restarting: false,
          }),
        },
      },
      // Three quarters ("Downloading… 75%").
      {
        at: 5,
        answer: UPDATE_OFFER,
        with: {
          mode: "value",
          value: offer({
            downloaded: 60_000_000,
            total: 80_000_000,
            restarting: false,
          }),
        },
      },
      // All of it is here ("Restarting…"). The real app closes and opens the new version now.
      {
        at: 7,
        answer: UPDATE_OFFER,
        with: {
          mode: "value",
          value: offer({
            downloaded: 80_000_000,
            total: 80_000_000,
            restarting: true,
          }),
        },
      },
      // The end: the same answer again, so the run ends at 9.
      {
        at: 9,
        answer: UPDATE_OFFER,
        with: {
          mode: "value",
          value: offer({
            downloaded: 80_000_000,
            total: 80_000_000,
            restarting: true,
          }),
        },
      },
    ],
  },
];
