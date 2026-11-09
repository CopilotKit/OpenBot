/**
 * The OpenBot for Business page, which has the booking calendar for a call inline. Every Book a
 * call, Book a demo and Meet OpenBot for Business in the app opens this one page, so somebody asking
 * about OpenBot for their organization reaches the people who run it.
 */
export const BUSINESS_URL = "https://open.bot/business";

/**
 * The OpenBot for Business booking event on Calendly: the same calls the page above books. The
 * onboarding step embeds it, and falls back to {@link BUSINESS_URL} when it can't load.
 */
export const BOOKING_CALENDAR_URL =
  "https://calendly.com/d/dwfr-k64-8d2/openbot-for-business";

/** Where the calendar is served from, and the only origin its messages are read from. */
export const BOOKING_CALENDAR_ORIGIN = new URL(BOOKING_CALENDAR_URL).origin;

/** Colours for the calendar, as Calendly takes them: six hex digits, no `#`. */
export type BookingCalendarColors = {
  background: string;
  text: string;
  primary: string;
};

/**
 * The address the calendar's frame loads.
 *
 * `embed_domain` and `embed_type=Inline` are what Calendly's own `widget.js` adds for an inline
 * embed: they are what make the page an embed, which posts its height and its bookings to this
 * window, and honours the hide options. The script itself is not loaded, since all it would do here
 * is write this address into an iframe. `hide_event_type_details` drops the event's name, host and
 * length, which the step's own words already say, so the narrow column shows the calendar first.
 * `hide_gdpr_banner` drops Calendly's cookie banner, which otherwise sits over the calendar inside
 * the step.
 * Colours are the app's own, where they could be read.
 */
export function bookingCalendarSrc(
  host: string,
  colors?: BookingCalendarColors,
): string {
  const url = new URL(BOOKING_CALENDAR_URL);
  url.searchParams.set("embed_domain", host);
  url.searchParams.set("embed_type", "Inline");
  url.searchParams.set("hide_event_type_details", "1");
  url.searchParams.set("hide_gdpr_banner", "1");
  if (colors) {
    url.searchParams.set("background_color", colors.background);
    url.searchParams.set("text_color", colors.text);
    url.searchParams.set("primary_color", colors.primary);
  }
  return url.href;
}
