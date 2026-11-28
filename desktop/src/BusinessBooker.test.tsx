import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BOOKING_CALENDAR_ORIGIN,
  BUSINESS_URL,
} from "../../shared/openbot-for-business";

// Keep the shared marks component real: replacing it would leak into later window tests.
mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
  ButtonMark: () => null,
  MarkImage: ({ id, name }: { id: string; name: string }) => (
    <img alt={name} data-mark={id} />
  ),
}));
const { BusinessBooker } = await import("./BusinessBooker");

beforeAll(() =>
  GlobalRegistrator.register({
    settings: {
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ request, window }) =>
            new URL(request.url).hostname === "calendly.com"
              ? new window.Response("<!doctype html><title></title>", {
                  headers: { "content-type": "text/html" },
                })
              : undefined,
        },
      },
    },
  }),
);
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function calendly(
  frame: HTMLIFrameElement,
  height: number,
  origin = BOOKING_CALENDAR_ORIGIN,
  source = frame.contentWindow,
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: { event: "calendly.page_height", payload: { height } },
      }),
    );
  });
}

test("page booking retains its surface and footer through loading, ready and failure", async () => {
  const user = userEvent.setup({ document });
  const view = render(<BusinessBooker way="cloud" />);
  const book = view.getByRole("button", { name: "Book a demo" });
  await user.click(book);
  const heading = view.getByRole("heading", { name: "Book a demo" });
  expect(document.activeElement).toBe(heading);
  const owner = heading.closest(".booking-step.setup-layout");
  expect(owner).not.toBeNull();
  const surface = owner?.querySelector(
    ":scope > .setup-body > .setup-booking-surface",
  );
  expect(surface).not.toBeNull();
  const back = view.getByRole("button", { name: "Back" });
  expect(back.parentElement?.classList.contains("setup-footer")).toBe(true);
  expect(back.classList.contains("quiet")).toBe(true);
  expect(back.querySelector("svg")).toBeNull();
  expect(view.getByRole("status").textContent).toContain(
    "Loading available times…",
  );
  const frame = view.getByTitle("Booking calendar") as HTMLIFrameElement;
  expect(frame.style.height).toBe("700px");
  calendly(frame, 640, "https://example.com");
  expect(view.getByRole("status")).toBeTruthy();
  calendly(frame, 640, BOOKING_CALENDAR_ORIGIN, window);
  expect(view.getByRole("status")).toBeTruthy();
  calendly(frame, 26);
  expect(view.getByRole("status")).toBeTruthy();
  calendly(frame, 640);
  expect(view.queryByRole("status")).toBeNull();
  expect(frame.style.height).toBe("640px");
  expect(owner?.querySelector(".setup-booking-surface")).toBe(surface);
  act(() => frame.dispatchEvent(new Event("error")));
  expect(view.queryByTitle("Booking calendar")).toBeNull();
  expect(owner?.querySelector(".setup-booking-surface")).toBe(surface);
  expect(surface?.contains(view.getByRole("status"))).toBe(true);
  expect(
    view.getByRole("link", { name: "Book a demo" }).getAttribute("href"),
  ).toBe(BUSINESS_URL);
  expect(view.getByRole("button", { name: "Back" })).toBe(back);
  await user.click(back);
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Book a demo" }),
  );
});

test("card booking keeps reported calendar heights without opting into page geometry", () => {
  const view = render(<BusinessBooker layout="card" />);
  const frame = view.getByTitle("Booking calendar") as HTMLIFrameElement;
  expect(view.container.querySelector(".setup-layout")).toBeNull();
  expect(frame.style.height).toBe("700px");
  calendly(frame, 640);
  expect(frame.style.height).toBe("640px");
  calendly(frame, 2000);
  expect(frame.style.height).toBe("1400px");
});

test("offline page booking keeps the reserved surface and Back beside the browser fallback", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: false,
  });
  try {
    const user = userEvent.setup({ document });
    const view = render(<BusinessBooker way="cloud" />);
    await user.click(view.getByRole("button", { name: "Book a demo" }));
    const surface = view.container.querySelector(
      ".setup-body > .setup-booking-surface",
    );
    expect(surface).not.toBeNull();
    expect(view.queryByTitle("Booking calendar")).toBeNull();
    expect(surface?.contains(view.getByRole("status"))).toBe(true);
    expect(
      surface?.contains(view.getByRole("link", { name: "Book a demo" })),
    ).toBe(true);
    expect(
      view.getByRole("button", { name: "Back" }).closest(".setup-footer"),
    ).not.toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "onLine", descriptor);
    else Reflect.deleteProperty(navigator, "onLine");
  }
});
