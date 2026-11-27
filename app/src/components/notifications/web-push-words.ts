/**
 * What every place that turns notifications on says where a switch or a button can't work yet: on
 * an iPhone or iPad, which gives push notifications only to OpenBot added to the Home Screen, on iOS
 * 16.4 or later (`webPushSupport` in lib/web-push/browser.ts). One sentence for Settings, a Bot's
 * page and the offer in a conversation alike.
 */

/** Safari on an iPhone or iPad, in a tab. */
export const HOME_SCREEN_FIRST =
  "On iPhone and iPad, add OpenBot to your Home Screen first: tap Share, then Add to Home Screen. Open OpenBot from there to turn on notifications. It needs iOS 16.4 or later.";

/** OpenBot opened from the Home Screen of an iPhone or iPad older than iOS 16.4. */
export const NEWER_IOS_FIRST =
  "Notifications on iPhone and iPad need iOS 16.4 or later. Update iOS, then open OpenBot from your Home Screen to turn them on.";
