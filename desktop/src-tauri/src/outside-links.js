// OpenBot's pages in the desktop window: a site outside OpenBot opens in the person's own browser.
//
// The window is a webview, not a browser: it refuses `window.open`, so an app's sign-in claimed in a
// new tab was "blocked", and a link to another site took the whole window there. Here every way out
// becomes a navigation, which the window's guard (`outside_links.rs`) hands to the default browser
// while this page stays. Injected on every load; the flag keeps it to once per page.
(() => {
  if (window.__openbotOutsideLinks) return;
  window.__openbotOutsideLinks = true;

  const loopback = (host) =>
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host.endsWith(".localhost");

  const leaves = (href) => {
    try {
      const url = new URL(href, window.location.href);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !loopback(url.hostname)
      );
    } catch {
      return false;
    }
  };

  const go = (href) =>
    (window.__openbotNavigate ?? ((to) => window.location.assign(to)))(href);

  // A tab claimed before its address is known (an app's consent) answers as a tab would: pointed
  // somewhere, it hands that address over; it reads as closed once the person is back here.
  window.open = (url) => {
    let closed = false;
    const hand = (href) => {
      const to = String(href);
      if (!to || to === "about:blank") return;
      go(to);
      if (leaves(to)) {
        window.addEventListener(
          "focus",
          () => {
            closed = true;
          },
          { once: true },
        );
      } else {
        closed = true;
      }
    };
    if (url) hand(url);
    return {
      opener: null,
      get closed() {
        return closed;
      },
      close() {
        closed = true;
      },
      focus() {},
      blur() {},
      location: {
        assign: hand,
        replace: hand,
        get href() {
          return "about:blank";
        },
        set href(to) {
          hand(to);
        },
      },
    };
  };

  // A link meant for a new tab, to a site outside OpenBot.
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (link?.target !== "_blank" || !leaves(link.href)) return;
      event.preventDefault();
      go(link.href);
    },
    true,
  );
})();
