import {
  type Icon,
  IconAdjustments,
  IconArrowUpRight,
  IconChecks,
  IconCloudComputing,
  IconCode,
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
import {
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  BOOK_A_DEMO_LINE,
  BOOKING_CALENDAR_ORIGIN,
  type BookingCalendarColors,
  BUSINESS_FEATURE_GROUPS,
  BUSINESS_FEATURES_MORE,
  BUSINESS_URL,
  type BusinessFeatureIcon,
  bookingCalendarSrc,
  type DesktopBusinessPlace,
} from "../../shared/openbot-for-business";
import { CloudMarks } from "./CloudMarks";
import { ExternalLink } from "./ExternalLink";
import { recordSetupEvent } from "./telemetry";

/** The same icons the app's OpenBot for Business dialog draws each feature with. */
const FEATURE_ICONS: Record<BusinessFeatureIcon, Icon> = {
  deploy: IconCloudComputing,
  agents: IconCode,
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

/** Which of OpenBot for Business's two ways to run is picked on the first screen. */
export type BusinessWay = "cloud" | "self-hosted";

/** The page's line for each way: who runs it, and where. */
export const BUSINESS_WAY_LINES: Record<BusinessWay, string> = {
  cloud: "We run OpenBot for you on OpenBot Cloud.",
  "self-hosted": "Run it in your own VPC on AWS, Azure or GCP, or on-prem.",
};

/**
 * OpenBot for Business, as the first screen's page draws it (`layout` "page", the default): the
 * picked way's line, Book a demo, and what it adds: one row per group, its name beside a sentence
 * that sums it up, then every feature in a short two-column list. Everything shows; nothing opens.
 * The detail pane scrolls when its copy needs more room.
 *
 * Book a demo swaps the page for the booking step: Back, its own heading (which takes the focus),
 * what booking is for, and the calendar sized to the room the page has (`BookingCalendar` `fit`).
 * The page's own heading (`head`) is the features view's, and gives way to the step's.
 *
 * A calendar that can't load (offline, blocked, silent) gives way to Book a demo, which opens the
 * OpenBot for Business page in the person's browser, as the app's does on the Desktop.
 *
 * The move screen's card keeps the app's view stacked (`layout` "card"): where it runs in big
 * letters, the three lists with their icons, then the calendar below them, which Book a demo
 * scrolls the card to. The words and the Calendly event are the app's own
 * (`shared/openbot-for-business`).
 */
export function BusinessBooker({
  way,
  head,
  layout = "page",
  place = "welcome",
}: {
  /** The picked way: its line, and for Self-Hosted the clouds it runs on. */
  way?: BusinessWay;
  /** The page's heading, shown with the features and not over the booking step. */
  head?: ReactNode;
  layout?: "page" | "card";
  place?: DesktopBusinessPlace;
}) {
  useEffect(() => {
    if (opened.has(place)) return;
    opened.add(place);
    recordSetupEvent({ kind: "business_opened", place });
  }, [place]);
  const [booking, setBooking] = useState(false);
  const bookButton = useRef<HTMLButtonElement>(null);
  const backToFeatures = useRef(false);
  useEffect(() => {
    if (booking || !backToFeatures.current) return;
    backToFeatures.current = false;
    bookButton.current?.focus();
  }, [booking]);
  if (layout === "card") return <StackedBooker place={place} />;
  if (booking) {
    return (
      <BookADemo
        place={place}
        page
        onBack={() => {
          backToFeatures.current = true;
          setBooking(false);
        }}
      />
    );
  }
  return (
    <>
      {head}
      <section
        className="business-page"
        aria-labelledby={way ? "business-way" : undefined}
        aria-label={way ? undefined : "OpenBot for Business"}
      >
        {way && (
          <div className="business-way">
            <p id="business-way">{BUSINESS_WAY_LINES[way]}</p>
            {way === "self-hosted" && <CloudMarks />}
          </div>
        )}
        <div className="business-book">
          <button
            type="button"
            ref={bookButton}
            onClick={() => setBooking(true)}
          >
            Book a demo
          </button>
        </div>
        <div className="business-features">
          {BUSINESS_FEATURE_GROUPS.map((group) => (
            <section className="business-row" key={group.title}>
              <h3>{group.title}</h3>
              <p>{group.summary}</p>
            </section>
          ))}
        </div>
        <ul className="business-all" aria-label="Everything it adds">
          {BUSINESS_FEATURE_GROUPS.flatMap((group) =>
            group.features.map((feature) => (
              <li key={feature.title}>{feature.title}</li>
            )),
          )}
          <li>{BUSINESS_FEATURES_MORE}</li>
        </ul>
      </section>
    </>
  );
}

/**
 * Book a demo: its heading, what booking is for, and the calendar, or the way to book in the
 * browser when the calendar can't load. Its own step (`page`) keeps Back in the footer and
 * focuses the heading as it shows.
 */
function BookADemo({
  place,
  page = false,
  onBack,
  heading,
}: {
  place: DesktopBusinessPlace;
  page?: boolean;
  onBack?: () => void;
  heading?: Ref<HTMLHeadingElement>;
}) {
  const [failed, setFailed] = useState(false);
  const own = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (page) own.current?.focus({ preventScroll: true });
  }, [page]);
  const header = (
    <>
      <h2 id="book-a-demo-title" ref={page ? own : heading} tabIndex={-1}>
        Book a demo
      </h2>
      <p className={page ? "book-a-demo-line lede" : "book-a-demo-line"}>
        {BOOK_A_DEMO_LINE}
      </p>
    </>
  );
  const calendar = failed ? (
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
    <BookingCalendar
      place={place}
      fit={page}
      onFailed={() => setFailed(true)}
      onBooked={() => recordSetupEvent({ kind: "business_booked", place })}
    />
  );
  return (
    <section
      className={page ? "book-a-demo booking-step setup-layout" : "book-a-demo"}
      aria-labelledby="book-a-demo-title"
    >
      {page ? (
        <>
          <header className="setup-header-block">{header}</header>
          <div className="setup-body">
            <div className="setup-booking-surface">{calendar}</div>
          </div>
          <footer className="setup-footer">
            {onBack && (
              <button
                type="button"
                className="quiet booking-back"
                onClick={onBack}
              >
                Back
              </button>
            )}
          </footer>
        </>
      ) : (
        <>
          {header}
          {calendar}
        </>
      )}
    </section>
  );
}

/**
 * The app's OpenBot for Business view stacked for the move screen's card: where it runs and what
 * it adds, then the calendar to book a call. The calendar sits below the lists, past the bottom of
 * the window, and the card scrolls to it. Book a demo under the first line takes the person there:
 * its heading comes to the top of the card and takes the focus, and the calendar follows it.
 */
function StackedBooker({ place }: { place: DesktopBusinessPlace }) {
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
        OpenBot for Business
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
      <BookADemo heading={booking} place={place} />
    </section>
  );
}

/**
 * The places whose booker came on screen since the setup window's page loaded: `business_opened` is
 * said once each. Coming back to setup from OpenBot loads the page again, which starts it afresh.
 */
const opened = new Set<DesktopBusinessPlace>();

/** For tests: a new window, where no booker has come on screen yet. */
export function forgetBusinessOpened() {
  opened.clear();
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
 * follows what it reports, so it never scrolls inside the card. As the booking step (`fit`) it is
 * fitted into the available page surface at its full reported height, including the day's times.
 */
function BookingCalendar({
  place,
  onBooked,
  fit = false,
  onFailed,
}: {
  /** Fill the reserved page surface; card embeds retain Calendly’s reported height. */
  fit?: boolean;
  place: DesktopBusinessPlace;
  onBooked: () => void;
  onFailed: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [src] = useState(() =>
    bookingCalendarSrc(window.location.host, place, windowColors()),
  );
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  useLayoutEffect(() => {
    const element = box.current;
    if (!fit || !element) return;
    const measure = () => setRoom(element.clientHeight);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  const scale = fit && room > 0 ? Math.min(1, room / height) : 1;
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const booked = useRef(onBooked);
  booked.current = onBooked;

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
      } else if (message.event === "calendly.event_scheduled") {
        booked.current();
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
    <div
      ref={box}
      className="booking-calendar"
      data-ready={ready ? "" : undefined}
    >
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
        style={{
          colorScheme: "light",
          height,
          ...(fit && {
            width: `${100 / scale}%`,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }),
        }}
        title="Booking calendar"
      />
      {ready ? null : (
        <div className="booking-calendar-loading" role="status">
          <span className="step-spinner" aria-hidden="true" />
          <span>Loading available times…</span>
        </div>
      )}
    </div>
  );
}
