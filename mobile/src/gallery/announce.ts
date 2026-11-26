/**
 * Tells OpenBot which cards this app can draw, as the web app does on every load (announceComponents).
 *
 * A Bot is offered a card only once its organization has the component on record, and the record is made by an app
 * announcing it. Somebody who only ever uses the phone, in an organization where nobody has opened the web app, would
 * otherwise never see a chart: their Bot is told it has none, and draws one with a command on its computer instead.
 *
 * Only the cards that show something are announced, the ones OpenBot answers itself when no screen is open. What a
 * model reads about each is OpenBot's own wording: the server replaces the description below with the one its build
 * ships, for every component nobody in the organization has edited. The description here is only what a server that
 * doesn't ship a component keeps. An announcement never changes a component the organization already has.
 */
import { ORGANIZATION_ID } from "../api";
import { announceComponents } from "../api/generated/components/components";
import { ANNOUNCED } from "./announced";

/** Announce the cards once a person is signed in and set up. Never throws: a card missing is not worth a failure. */
export async function announceGallery(): Promise<void> {
  try {
    await announceComponents(ORGANIZATION_ID, {
      components: ANNOUNCED.map((entry) => ({ ...entry })),
    });
  } catch {
    // An older OpenBot without the operation, or a moment offline: the next start tries again.
  }
}
