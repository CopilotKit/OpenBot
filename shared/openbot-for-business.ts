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

/**
 * Every place OpenBot for Business's calendar is embedded from, as the booking's `utm_content`, so
 * a call booked inside OpenBot says which screen it came from. In the web app: the account menu's
 * entry (`account_menu`, in every skin), the home page's Meet OpenBot for Business (`home`), an
 * Admin page that applies only to a team (`admin`), a Bot's line about a computer of its own
 * (`computer_line`), the self-hosting bar's Book a call (`self_host_banner`), OpenBot Cloud's
 * sign-in screen (`sign_in`) and onboarding's Book a demo step (`onboarding`). On Desktop: the
 * first screen (`welcome`) and Move to Cloud (`move_to_cloud`).
 */
export type BusinessPlace = AppBusinessPlace | DesktopBusinessPlace;

/** The web app's places, which open the OpenBot for Business dialog or onboarding's step. */
export type AppBusinessPlace =
  | "account_menu"
  | "home"
  | "admin"
  | "computer_line"
  | "self_host_banner"
  | "sign_in"
  | "onboarding";

/** Desktop's setup window's places, which draw its own booker (`BusinessBooker`). */
export type DesktopBusinessPlace = "welcome" | "move_to_cloud";

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
 * `utm_source=openbot_app` and `utm_medium=in_app` say the call was booked from inside OpenBot,
 * the web app or Desktop, and `utm_content` the screen it was booked from ({@link BusinessPlace}).
 * Calendly keeps an embed address's UTM tags on the booking, so without them a booking made here
 * counts as a direct one.
 * Colours are the app's own, where they could be read.
 */
export function bookingCalendarSrc(
  host: string,
  place: BusinessPlace,
  colors?: BookingCalendarColors,
): string {
  const url = new URL(BOOKING_CALENDAR_URL);
  url.searchParams.set("embed_domain", host);
  url.searchParams.set("embed_type", "Inline");
  url.searchParams.set("hide_event_type_details", "1");
  url.searchParams.set("hide_gdpr_banner", "1");
  url.searchParams.set("utm_source", "openbot_app");
  url.searchParams.set("utm_medium", "in_app");
  url.searchParams.set("utm_content", place);
  if (colors) {
    url.searchParams.set("background_color", colors.background);
    url.searchParams.set("text_color", colors.text);
    url.searchParams.set("primary_color", colors.primary);
  }
  return url.href;
}

/** Over the calendar: what booking a call is for. */
export const BOOK_A_DEMO_LINE =
  "Pick a time to see a demo or scope a proof of concept with us.";

/** Which icon a feature is drawn with. Each app maps these to its own Tabler icon. */
export type BusinessFeatureIcon =
  | "deploy"
  | "agents"
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
 * things a team gets: its people, where its Bots work, and control over both. Each group's
 * `summary` says the group in one sentence: Desktop's OpenBot for Business page shows it beside the
 * group's name, over the full list.
 *
 * Where it runs leads the list, so it is findable alongside the other features.
 */
export const BUSINESS_FEATURE_GROUPS: readonly {
  title: string;
  summary: string;
  features: readonly { title: string; icon: BusinessFeatureIcon }[];
}[] = [
  {
    title: "For your whole organization",
    summary:
      "Everyone signs in with single sign-on, has a role, and shares Bots and learning with the organization.",
    features: [
      {
        title:
          "Deploy in your own VPC on AWS, Azure or GCP, on-prem, or on OpenBot Cloud",
        icon: "deploy",
      },
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
      {
        title:
          "Deploy custom agents built with any agent stack, or bring your own custom harness, with a great user experience and governance",
        icon: "agents",
      },
    ],
  },
  {
    title: "Where your Bots work",
    summary:
      "Your Bots work in Slack and Microsoft Teams, each on a computer of its own.",
    features: [
      { title: "Bots in Slack and Microsoft Teams", icon: "chat" },
      { title: "A computer for each Bot", icon: "computer" },
    ],
  },
  {
    title: "In control",
    summary:
      "You govern models, apps and networks with rules and policies in plain English, and keep a full audit trail.",
    features: [
      { title: "Top-to-bottom enterprise governance", icon: "governance" },
      { title: "A full audit trail, with export", icon: "audit" },
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
    ],
  },
];

/** Under the list. */
export const BUSINESS_FEATURES_MORE = "And tons more…";
