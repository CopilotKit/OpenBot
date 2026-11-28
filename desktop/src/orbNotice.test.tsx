import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AGENT_ORB_AT_REST, AGENT_ORB_LISTENING } from "../../shared/agent-orb";

const { NOTICE_MS, NOTICE_RISE_MS, noticeAgain, noticeLevel, noticeLook } =
  await import("./orbNotice");
const { Lockup } = await import("./Sections");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  reducedMotion(false);
});
afterAll(() => GlobalRegistrator.unregister());

function reducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const scaleOf = (orb: HTMLElement) =>
  Number(orb.style.getPropertyValue("--orb-scale"));

/*
 * A click on the setup window's orb is a short "I noticed you": from the app's idle towards its
 * listening and back, about half a second in all.
 */
test("the reaction rises quickly, peaks at listening, and is back at rest by itself", () => {
  expect(NOTICE_MS).toBeLessThanOrEqual(600);
  expect(noticeLevel(0)).toBe(0);
  expect(noticeLevel(NOTICE_RISE_MS)).toBeCloseTo(1);
  expect(noticeLevel(NOTICE_MS)).toBe(0);
  const peak = noticeLook(1);
  expect(peak.scale).toBeCloseTo(
    AGENT_ORB_LISTENING.scale / AGENT_ORB_AT_REST.scale,
  );
  expect(peak.saturation).toBe(AGENT_ORB_LISTENING.saturation);
  expect(peak.glow).toBe(AGENT_ORB_LISTENING.glow);
  expect(noticeLook(0)).toMatchObject({
    scale: 1,
    saturation: AGENT_ORB_AT_REST.saturation,
    glow: AGENT_ORB_AT_REST.glow,
    swirl: 1,
    drift: 1,
  });
});

test("a click during the reaction picks it up where the orb is: no jump, never bigger", () => {
  for (let t = 0; t <= NOTICE_MS + 50; t += 5) {
    const again = noticeAgain(t);
    // Where the second click leaves the orb is where it was.
    if (t >= NOTICE_RISE_MS && t < NOTICE_MS)
      expect(noticeLevel(again)).toBeCloseTo(noticeLevel(t), 6);
    // It is back on the rise, so it swells again from there, to the same peak and no further.
    expect(again).toBeLessThanOrEqual(NOTICE_RISE_MS);
  }
  for (let t = 0; t <= NOTICE_MS; t += 1)
    expect(noticeLevel(t)).toBeLessThanOrEqual(1);
});

test("a click on the orb starts the reaction, and it ends by itself", async () => {
  const { container } = render(<Lockup />);
  const orb = container.querySelector(".orb") as HTMLElement;
  expect(scaleOf(orb)).toBe(1);
  fireEvent.click(orb);
  let peak = 1;
  const until = Date.now() + NOTICE_MS + 400;
  while (Date.now() < until) {
    peak = Math.max(peak, scaleOf(orb));
    await wait(10);
  }
  expect(peak).toBeGreaterThan(1.05);
  expect(scaleOf(orb)).toBe(1);
  expect(orb.style.getPropertyValue("--orb-saturation")).toBe(
    String(AGENT_ORB_AT_REST.saturation),
  );
});

test("a second click while it settles swells it again from where it is", async () => {
  const { container } = render(<Lockup />);
  const orb = container.querySelector(".orb") as HTMLElement;
  fireEvent.click(orb);
  // Into the settle, well past the peak.
  while (scaleOf(orb) === 1) await wait(5);
  await wait(NOTICE_RISE_MS + 120);
  const settling = scaleOf(orb);
  expect(settling).toBeGreaterThan(1);
  fireEvent.click(orb);
  const after: number[] = [];
  for (let i = 0; i < 6; i++) {
    await wait(10);
    after.push(scaleOf(orb));
  }
  // No drop back to rest, and it swells again, to no more than the one peak.
  expect(Math.min(...after)).toBeGreaterThan(settling - 0.01);
  expect(Math.max(...after)).toBeGreaterThan(settling);
  expect(Math.max(...after)).toBeLessThanOrEqual(noticeLook(1).scale + 1e-9);
});

test("under reduced motion a click does nothing", async () => {
  reducedMotion(true);
  const { container } = render(<Lockup />);
  const orb = container.querySelector(".orb") as HTMLElement;
  const before = orb.getAttribute("style");
  fireEvent.click(orb);
  await wait(NOTICE_RISE_MS);
  expect(orb.getAttribute("style")).toBe(before);
});

test("the orb stays decoration: no role, no focus stop", () => {
  const { container } = render(<Lockup />);
  const orb = container.querySelector(".orb") as HTMLElement;
  expect(orb.closest("[aria-hidden='true']")).not.toBeNull();
  expect(orb.getAttribute("role")).toBeNull();
  expect(orb.hasAttribute("tabindex")).toBe(false);
});
