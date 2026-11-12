import { createServer, type Server } from "node:http";
import { BIND_HOST } from "../harness/config";

/**
 * A small website the Bots browse in the computer journeys: a garden shop with a page to read, a
 * second page to go to, a form to fill in and a checkout to pay at.
 *
 * SERVED BY THE RUN, NOT A THIRD-PARTY SITE. A real site changes, is slow, or blocks a headless
 * browser, and a journey that reads it is not the same twice. This one answers the same bytes every
 * time, so the page a Bot reads in replay is the page it read when the fixtures were recorded.
 *
 * WHERE THE BOT REACHES IT. The Bot's browser runs in the computer's container, which reaches this
 * machine as `host.docker.internal` (docker-compose.yml gives the computer that name). Docker
 * Desktop carries it to this machine's loopback, so the site listens on loopback only, unless the
 * run names another address (`BIND_HOST`, for a Linux engine).
 *
 * A FIXED PORT, whatever `E2E_PORT_OFFSET` says, because the address is in what the person asks
 * the Bot ("open http://host.docker.internal:46600/…"), and that is what a fixture is matched on. A
 * port that moved with the offset would make every recording answer one offset only.
 *
 * WHAT IT REMEMBERS. Every application sent and every order placed, so a journey can tell an action
 * the Bot actually took from one it only said it took: Allow once places one order, Deny places none.
 */

export const SITE_PORT = 46600;
/** The site as the Bot's browser addresses it. */
export const SITE = `http://host.docker.internal:${SITE_PORT}`;
/** The host part a page's address shows, in the address bar and on an approval card. */
export const SITE_HOST = `host.docker.internal:${SITE_PORT}`;

/** What the shop sells, by the address of its checkout page. */
export const ITEMS = {
  tomato: { name: "Heirloom tomato seeds", price: "$4.50", order: "FH-2041" },
  basil: { name: "Genovese basil seeds", price: "$3.25", order: "FH-2042" },
  marigold: { name: "French marigold seeds", price: "$2.75", order: "FH-2043" },
  sunflower: {
    name: "Giant sunflower seeds",
    price: "$3.80",
    order: "FH-2044",
  },
  lavender: {
    name: "English lavender seeds",
    price: "$5.10",
    order: "FH-2045",
  },
  chamomile: {
    name: "German chamomile seeds",
    price: "$2.95",
    order: "FH-2046",
  },
} as const;
export type Item = keyof typeof ITEMS;

export type Application = {
  fullName: string;
  email: string;
  shift: string;
  agreed: boolean;
};

/** The member who signs in to the members' area, and the password only the person knows. */
export const MEMBER = { username: "robin.okafor", password: "marigold-7731" };

export type SignIn = { username: string; ok: boolean };

export type Site = {
  /** Orders placed, oldest first, by item. */
  orders: Item[];
  /** Volunteer applications sent, oldest first. */
  applications: Application[];
  /** Sign-ins to the members' area, oldest first, and whether the password was right. */
  signIns: SignIn[];
  stop: () => Promise<void>;
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 18px/1.5 Georgia, serif; margin: 0; color: #1f2a1f; background: #f6f3ea; }
  header { background: #2f5d3a; color: #fff; padding: 18px 40px; }
  header a { color: #fff; margin-right: 18px; }
  main { padding: 24px 40px; max-width: 760px; }
  label { display: block; margin-top: 14px; }
  input[type=text], input[type=email] { font: inherit; padding: 6px 8px; width: 340px; }
  button { font: inherit; margin-top: 18px; padding: 8px 18px; background: #2f5d3a; color: #fff; border: 0; }
  .total { font-size: 22px; font-weight: bold; }
</style>
</head>
<body>
<header><strong>Fernhill Garden Supply</strong> &nbsp; <a href="/">Home</a><a href="/about">About us</a><a href="/volunteer">Volunteer</a></header>
<main>
${body}
</main>
</body>
</html>`;
}

const HOME = page(
  "Fernhill Garden Supply",
  `<h1>Fernhill Garden Supply</h1>
<p>Seeds, soil and seedlings for city gardens since 1987.</p>
<h2>Opening hours</h2>
<ul>
  <li>Weekdays: 8:00 am to 6:00 pm</li>
  <li>Saturdays: the greenhouse opens at 7:40 am, and the shop at 9:00 am</li>
  <li>Sundays: closed</li>
</ul>
<p>Ask for Marguerite at the potting bench for advice on herbs.</p>`,
);

const ABOUT = page(
  "About Fernhill Garden Supply",
  `<h1>About us</h1>
<p>Fernhill Garden Supply was founded in 1987 by Ines Calloway, in a former tram depot on Wren Street.</p>`,
);

const VOLUNTEER = page(
  "Volunteer at Fernhill",
  `<h1>Volunteer at Fernhill</h1>
<p>Help in the greenhouse on a weekend morning.</p>
<form method="post" action="/volunteer">
  <label for="fullName">Full name</label>
  <input id="fullName" name="fullName" type="text">
  <label for="email">Email</label>
  <input id="email" name="email" type="email">
  <label for="shift">Preferred shift</label>
  <input id="shift" name="shift" type="text" placeholder="For example, Saturday morning">
  <label><input id="agree" name="agree" type="checkbox" value="yes"> I agree to the volunteer code of conduct</label>
  <button type="submit">Submit application</button>
</form>`,
);

function applicationReceived(application: Application): string {
  return page(
    "Application received",
    `<h1>Application received</h1>
<p>Thank you, ${escapeHtml(application.fullName)}. Your reference is VOL-3172.</p>
<p>We will email ${escapeHtml(application.email)} about your ${escapeHtml(application.shift)} shift.</p>`,
  );
}

/**
 * The members' sign-in. The Bot can fill in the username; the password is the person's, typed by
 * them in the Bot's browser. The username field has the focus when the page opens, so a person who
 * takes control reaches the password with Tab.
 */
const MEMBERS = page(
  "Members sign in",
  `<h1>Members sign in</h1>
<p>Sign in to see your seed allowance.</p>
<form method="post" action="/members">
  <label for="username">Username</label>
  <input id="username" name="username" type="text" autocomplete="off" autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="off">
  <button type="submit">Sign in</button>
</form>`,
);

function membersArea(username: string): string {
  return page(
    "Members area",
    `<h1>Welcome back</h1>
<p>Signed in as ${escapeHtml(username)}. Your seed allowance is 12 packets this season.</p>`,
  );
}

const WRONG_PASSWORD = page(
  "Members sign in",
  "<h1>Members sign in</h1><p>That password is not right.</p>",
);

function checkout(item: Item): string {
  const { name, price } = ITEMS[item];
  return page(
    `Checkout: ${name}`,
    `<h1>Checkout</h1>
<p>Order summary: ${name}, 1 packet.</p>
<p class="total">Total: ${price}</p>
<p>Paid with the card on file ending 4242.</p>
<form method="post" action="/shop/${item}">
  <button type="submit">Place order</button>
</form>`,
  );
}

function orderConfirmed(item: Item): string {
  const { name, order } = ITEMS[item];
  return page(
    "Order confirmed",
    `<h1>Order confirmed</h1>
<p>Your order ${order} for ${name} is placed. It will be ready to collect tomorrow.</p>`,
  );
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

function isItem(value: string): value is Item {
  return Object.hasOwn(ITEMS, value);
}

/** Start the site on port 46600. Fails if the port is taken, rather than serve someone else's pages. */
export async function startSite(): Promise<Site> {
  const orders: Item[] = [];
  const applications: Application[] = [];
  const signIns: SignIn[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://site.invalid");
    const send = (status: number, html: string) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(html);
    };
    const shop = /^\/shop\/([a-z]+)$/.exec(url.pathname)?.[1];
    if (request.method === "GET" && url.pathname === "/")
      return send(200, HOME);
    if (request.method === "GET" && url.pathname === "/about")
      return send(200, ABOUT);
    if (url.pathname === "/members" && request.method === "GET")
      return send(200, MEMBERS);
    if (url.pathname === "/volunteer" && request.method === "GET")
      return send(200, VOLUNTEER);
    if (shop && isItem(shop) && request.method === "GET")
      return send(200, checkout(shop));
    if (
      request.method === "POST" &&
      (url.pathname === "/volunteer" ||
        url.pathname === "/members" ||
        (shop && isItem(shop)))
    ) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        if (shop && isItem(shop)) {
          orders.push(shop);
          return send(200, orderConfirmed(shop));
        }
        const form = new URLSearchParams(body);
        if (url.pathname === "/members") {
          const username = form.get("username") ?? "";
          const ok =
            username === MEMBER.username &&
            form.get("password") === MEMBER.password;
          signIns.push({ username, ok });
          return send(200, ok ? membersArea(username) : WRONG_PASSWORD);
        }
        const application: Application = {
          fullName: form.get("fullName") ?? "",
          email: form.get("email") ?? "",
          shift: form.get("shift") ?? "",
          agreed: form.get("agree") === "yes",
        };
        applications.push(application);
        send(200, applicationReceived(application));
      });
      return;
    }
    send(404, page("Not found", "<h1>Not found</h1>"));
  });
  await new Promise<void>((settle, fail) => {
    server.once("error", fail);
    server.listen(SITE_PORT, BIND_HOST, () => settle());
  });
  return {
    orders,
    applications,
    signIns,
    stop: () =>
      new Promise<void>((settle) => {
        server.closeAllConnections();
        server.close(() => settle());
      }),
  };
}
