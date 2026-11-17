/**
 * OpenBot for Business, as the web app and the Desktop app both show it: where it runs, what it
 * adds, and the booking calendar. One copy of the words and the one Calendly event, so the app's
 * OpenBot for Business dialog and Desktop's first screen never drift apart. Each side draws them
 * with its own components and icons.
 */

/**
 * The OpenBot for Business page on the website, which has the same booking calendar inline. In the
 * app every OpenBot for Business entry opens the in-app dialog (`openTeamFeatures`), which embeds
 * the calendar; this page is where a calendar that can't load in the app sends somebody instead.
 */
export const BUSINESS_URL = "https://open.bot/business";

/**
 * The OpenBot for Business booking event on Calendly: the same calls the page above books. The
 * onboarding step, the OpenBot for Business dialog and Desktop's first screen embed it, and fall
 * back to {@link BUSINESS_URL} when it can't load.
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

/** The first line, in big letters: where OpenBot for Business runs. */
export const DEPLOY_LINE =
  "Deploy in your own VPC on AWS, Azure or GCP, on-prem, or on OpenBot Cloud.";

/** Over the calendar: what booking a call is for. */
export const BOOK_A_DEMO_LINE =
  "Pick a time to see a demo or scope a proof of concept with us.";

/** Which icon a feature is drawn with. Each app maps these to its own Tabler icon. */
export type BusinessFeatureIcon =
  | "sign-in"
  | "people"
  | "shared-bots"
  | "learning"
  | "chat"
  | "computer"
  | "controls"
  | "rules"
  | "policies"
  | "governance"
  | "audit";

/**
 * What the team edition has and the personal edition does not, one short line each, in the three
 * things a team gets: its people, where its Bots work, and control over both.
 */
export const BUSINESS_FEATURE_GROUPS: readonly {
  title: string;
  features: readonly { title: string; icon: BusinessFeatureIcon }[];
}[] = [
  {
    title: "For your whole organization",
    features: [
      {
        title: "Sign-in with Google, Microsoft or custom SSO",
        icon: "sign-in",
      },
      { title: "People, roles and admins", icon: "people" },
      {
        title: "Bots shared with your whole organization",
        icon: "shared-bots",
      },
      { title: "Learning shared across your organization", icon: "learning" },
    ],
  },
  {
    title: "Where your Bots work",
    features: [
      { title: "Bots in Slack and Microsoft Teams", icon: "chat" },
      { title: "A computer for each Bot", icon: "computer" },
    ],
  },
  {
    title: "In control",
    features: [
      { title: "Controls over models, apps and networks", icon: "controls" },
      { title: "Rules every Bot follows", icon: "rules" },
      /*
       * Boundaries, team approval rules, auto-review guidance, permissions, the network allowlist
       * and one Bot's app actions are each described in words on their Admin screen, and each
       * replays the result over recorded activity before it is saved.
       */
      {
        title: "Policies in plain English, tested on past activity",
        icon: "policies",
      },
      { title: "Governance for everyone", icon: "governance" },
      { title: "A full audit trail, with export", icon: "audit" },
    ],
  },
];

/** Under the list. */
export const BUSINESS_FEATURES_MORE = "And tons more…";
