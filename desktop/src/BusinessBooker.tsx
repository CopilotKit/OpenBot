import {
  type Icon,
  IconAdjustments,
  IconArrowUpRight,
  IconChecks,
  IconDeviceDesktop,
  IconHistory,
  IconListCheck,
  IconLogin2,
  IconMessages,
  IconSchool,
  IconSparkles,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import {
  BOOK_A_DEMO_LINE,
  BOOKING_CALENDAR_ORIGIN,
  type BookingCalendarColors,
  BUSINESS_FEATURE_GROUPS,
  BUSINESS_FEATURES_MORE,
  BUSINESS_URL,
  type BusinessFeatureIcon,
  bookingCalendarSrc,
  DEPLOY_LINE,
} from "../../shared/openbot-for-business";
import { ExternalLink } from "./ExternalLink";

/** The same icons the app's OpenBot for Business dialog draws each feature with. */
const FEATURE_ICONS: Record<BusinessFeatureIcon, Icon> = {
  "sign-in": IconLogin2,
  people: IconUsers,
  "shared-bots": IconUsersGroup,
  learning: IconSchool,
  chat: IconMessages,
  computer: IconDeviceDesktop,
  controls: IconAdjustments,
  rules: IconListCheck,
  policies: IconSparkles,
  governance: IconChecks,
  audit: IconHistory,
};

/**
 * The first screen's lower half when OpenBot for Business is picked: the app's OpenBot for Business
 * view, stacked for the setup card. Where it runs and what it adds, then the calendar to book a
 * call. The words and the Calendly event are the app's own (`shared/openbot-for-business`).
 *
 * A calendar that can't load (offline, blocked, silent) gives way to Book a demo, which opens the
 * OpenBot for Business page in the person's browser, as the app's does on the Desktop.
 *
 * The calendar sits below the lists, past the bottom of the setup window, and the card scrolls to
 * it. Book a demo under the first line takes the person there, so the way to book is in view the
 * moment OpenBot for Business is picked: its heading comes to the top of the card and takes the
 * focus, and the calendar follows it.
 */
export function BusinessBooker() {
  const [failed, setFailed] = useState(false);
  const booking = useRef<HTMLHeadingElement>(null);
  const toBooking = () => {
    const heading = booking.current;
    if (!heading) return;
    heading.scrollIntoView?.({ behavior: "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  };
  return (
    <section className="business-booker" aria-labelledby="business-deploy">
      <p id="business-deploy" className="business-deploy">
        {DEPLOY_LINE}
      </p>
      <div className="business-book">
        <button type="button" onClick={toBooking}>
          Book a demo
        </button>
      </div>
      {BUSINESS_FEATURE_GROUPS.map((group) => (
        <section className="business-group" key={group.title}>
          <h3>{group.title}</h3>
          <ul className="business-list">
            {group.features.map((feature) => {
              const FeatureIcon = FEATURE_ICONS[feature.icon];
              return (
                <li key={feature.title}>
                  <span className="business-icon" aria-hidden="true">
                    <FeatureIcon stroke={1.75} />
                  </span>
                  {feature.title}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="business-more">{BUSINESS_FEATURES_MORE}</p>
      <section className="book-a-demo" aria-labelledby="book-a-demo-title">
        <h2 id="book-a-demo-title" ref={booking} tabIndex={-1}>
          Book a demo
        </h2>
        <p className="book-a-demo-line">{BOOK_A_DEMO_LINE}</p>
        {failed ? (
          <div className="book-a-demo-fallback">
            <p role="status">
              Couldn't load the calendar. Book a demo opens it in your browser.
            </p>
            <ExternalLink className="button-link primary" href={BUSINESS_URL}>
              Book a demo
              <IconArrowUpRight aria-hidden="true" stroke={1.75} />
            </ExternalLink>
          </div>
        ) : (
          <BookingCalendar onFailed={() => setFailed(true)} />
        )}
      </section>
    </section>
  );
}

/** The height Calendly's embed instructions give an inline calendar, until it reports its own. */
const DEFAULT_HEIGHT = 700;
/** Below this a reported height is Calendly's page still starting (it reports 2 and 26 px first). */
const MIN_HEIGHT = 320;
/** Above this a reported height is not believed, so a bad message can't stretch the card forever. */
const MAX_HEIGHT = 1400;
/** How long the calendar has to say it is there before the card offers the browser instead. */
export const BOOKING_CALENDAR_TIMEOUT_MS = 20_000;

/**
 * One of the window's colour tokens as six hex digits, read as the page is drawn, so the dark theme
 * is what the calendar gets. Painted to a one-pixel canvas, which turns any CSS colour (the tokens
 * are `oklch`) into sRGB. Undefined where there is no canvas or the colour doesn't parse; the
 * calendar then keeps Calendly's own colours.
 */
function tokenHex(token: string): string | undefined {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  if (!value) return undefined;
  const context = document
    .createElement("canvas")
    .getContext?.("2d", { willReadFrequently: true });
  if (!context) return undefined;
  const unset = "#010203";
  context.fillStyle = unset;
  context.fillStyle = value;
  if (context.fillStyle === unset) return undefined;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue]
    .map((channel) => (channel ?? 0).toString(16).padStart(2, "0"))
    .join("");
}

function windowColors(): BookingCalendarColors | undefined {
  try {
    const background = tokenHex("--card");
    const text = tokenHex("--foreground");
    const primary = tokenHex("--primary");
    return background && text && primary
      ? { background, text, primary }
      : undefined;
  } catch {
    return undefined;
  }
}

/** What Calendly posts to the window it is embedded in: `{ event: "calendly.…", payload }`. */
type CalendlyMessage = {
  event?: unknown;
  payload?: { height?: unknown };
};

/**
 * The OpenBot for Business calendar, inline in the setup card, as the app's `BookingCalendar` is in
 * its dialog. The window's guard lets Calendly and the frames it embeds load in their frame, and a
 * link in it that opens a new window opens in the person's browser (`outside_links.rs`).
 *
 * ITS OWN MESSAGES SAY IT LOADED. A frame's `load` fires for an error page too, so the calendar
 * counts as there only once Calendly, from its own origin and this frame, says so. Until then a
 * spinner stands in its place. Offline, an `error` from the frame, or no word from it in
 * {@link BOOKING_CALENDAR_TIMEOUT_MS} on screen, and `onFailed` hands back to Book a demo. Its height
 * follows what it reports, so it never scrolls inside the card.
 */
function BookingCalendar({ onFailed }: { onFailed: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() =>
    bookingCalendarSrc(window.location.host, windowColors()),
  );
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const failed = useRef(onFailed);
  failed.current = onFailed;

  useEffect(() => {
    if (!navigator.onLine) {
      failed.current();
      return;
    }
    let heard = false;
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== BOOKING_CALENDAR_ORIGIN ||
        !frame.current ||
        event.source !== frame.current.contentWindow
      ) {
        return;
      }
      const message = (event.data ?? {}) as CalendlyMessage;
      if (message.event === "calendly.page_height") {
        const reported = Number.parseFloat(String(message.payload?.height));
        if (Number.isFinite(reported) && reported >= MIN_HEIGHT) {
          heard = true;
          setReady(true);
          setHeight(Math.min(Math.ceil(reported), MAX_HEIGHT));
        }
      } else if (message.event === "calendly.event_type_viewed") {
        heard = true;
        setReady(true);
      }
    };
    window.addEventListener("message", onMessage);
    // React doesn't attach `onError` to an iframe, so the frame's own event is listened to.
    const element = frame.current;
    const onError = () => failed.current();
    element?.addEventListener("error", onError);
    /*
     * The wait starts once the calendar is on screen: it sits below the list in the card, a browser
     * holds back a frame scrolled out of view, and Calendly says nothing until it is drawn.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startWaiting = () => {
      timer ??= setTimeout(() => {
        if (!heard) failed.current();
      }, BOOKING_CALENDAR_TIMEOUT_MS);
    };
    let seen: IntersectionObserver | undefined;
    if (element && typeof IntersectionObserver === "function") {
      seen = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          startWaiting();
          seen?.disconnect();
        }
      });
      seen.observe(element);
    } else {
      startWaiting();
    }
    return () => {
      window.removeEventListener("message", onMessage);
      element?.removeEventListener("error", onError);
      seen?.disconnect();
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="booking-calendar" data-ready={ready ? "" : undefined}>
      <iframe
        ref={frame}
        referrerPolicy="strict-origin-when-cross-origin"
        // Everything a booking needs, and nothing that lets the frame move this window.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        src={src}
        /*
         * Light, whatever the window's theme. Calendly's page declares no colour scheme, and a frame
         * whose scheme differs from its element's is painted on an opaque white canvas: in the dark
         * theme its last pixels, below its content, showed as a white line in the app.
         */
        style={{ colorScheme: "light", height }}
        title="Booking calendar"
      />
      {ready ? null : (
        <div className="booking-calendar-loading" role="status">
          <span className="step-spinner" aria-hidden="true" />
          <span className="sr-only">Loading the calendar</span>
        </div>
      )}
    </div>
  );
}
