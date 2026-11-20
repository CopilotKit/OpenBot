import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * The sections of Settings → Computer an address can open at, by the hash it carries. OpenBot
 * Desktop's tray Status opens `/settings/this-computer`, and the browser extension's popup opens
 * `/settings/browsers`; both old addresses redirect here with the hash, and the page scrolls to the
 * section.
 */
export const COMPUTER_SECTION = {
  thisComputer: "this-computer",
  browsers: "browsers",
} as const;

/** What the person does to move the page themselves, after which it is theirs to scroll. */
const PERSON_MOVED = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/** How long the page keeps the named section in view while the sections above it load. */
const SETTLE_MS = 3000;

/**
 * Scroll to the section the address's hash names, and keep it there while the page settles.
 *
 * The router scrolls to a hash once, when the route resolves. On this page that is too early: the
 * sections draw after their data loads (what Desktop runs is read from the shell, the browsers from
 * the server), so the one named may not exist yet, and a section above it that loads later pushes
 * it back below the fold. So this scrolls when the section appears and again as the page grows,
 * until it has settled or the person scrolls, clicks or types themselves.
 */
export function useScrollToSection() {
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    if (!hash) return;
    let done = false;
    const show = () => {
      if (done) return;
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    };
    const observer = new MutationObserver(show);
    const stop = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      for (const event of PERSON_MOVED) window.removeEventListener(event, stop);
    };
    const timer = window.setTimeout(stop, SETTLE_MS);
    for (const event of PERSON_MOVED)
      window.addEventListener(event, stop, { passive: true });
    observer.observe(document.body, { childList: true, subtree: true });
    show();
    return stop;
  }, [hash]);
}
