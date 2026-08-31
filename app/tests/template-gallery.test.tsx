import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * The gallery, and the two things it must not do with a stranger's strings.
 *
 * A template's `author` and `source` are typed by whoever wrote the file and verified by nobody.
 * They sit a centimetre from a Bot's name while somebody decides whether to trust it, which makes
 * two properties worth pinning rather than reasoning about: the address is rendered as TEXT and
 * never as an anchor, so there is nothing to click before the reader has finished reading; and the
 * word "claim" appears beside the author, so the deployment's own screen is not the one place the
 * claim reads as a fact.
 *
 * The third thing pinned here is an absence. There is no install count, no download count and no
 * rating anywhere in this feature, because nothing counts anything — a number beside a template
 * would be invented or supplied by its own author. Popularity is the strongest signal a marketplace
 * gives and this one refuses to fake it, so a test asserts the words are not on the screen: a
 * later well-meaning addition of "1.2k installs" should fail here rather than ship.
 *
 * NO MODULE MOCKS. `mock.module` in bun is process-wide and does not come back, so mocking
 * `@/lib/client` or the router here would change what every other file in the suite imports. The
 * transport is stubbed at `fetch` and restored afterwards, and the router is a real one over a
 * memory history.
 */
/*
 * Registered with an address, and only if nothing else has registered already.
 *
 * `register()` throws outright when a DOM is installed and bun walks every test file into one
 * process. The address matters separately: Happy DOM defaults to `about:blank`, whose origin is the
 * STRING "null", and Better Auth throws `Invalid base URL: null` while it is being imported.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}
/*
 * A DOM before Testing Library. `screen` binds its queries to `document.body` at import time, so a
 * static import would be hoisted above the registration and bind to nothing.
 */
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const userEvent = (await import("@testing-library/user-event")).default;

/**
 * A card whose author claim is an address, which is the hostile shape.
 *
 * `source` looking like a URL is the ordinary case rather than an attack — every honest template
 * has one — and that is exactly why it must not be a link: the reader cannot tell an honest one
 * from a hostile one by looking, so neither is clickable.
 */
const CARD = {
  slug: "renewal-desk",
  digest: "a".repeat(64),
  name: "Renewal Desk",
  title: "Accounts Receivable",
  summary: "Chases overdue invoices and drafts the follow-up.",
  author: "acme-revops",
  version: "1.3",
  license: "Apache-2.0",
  source: "https://github.com/acme/openbot-templates",
  category: "sales",
  runtime: "managed",
  connectors: ["google-drive"],
  components: [],
  skills: ["check-renewal-risk"],
  origin: { kind: "directory", filename: "renewal-desk.openbot.yaml" },
};

const SKIP = {
  where: "broken.openbot.yaml",
  reason: "unparseable",
  message: "openbot_template must be 1.",
};

let servedTemplates: unknown[] = [CARD];
let servedSkips: unknown[] = [];
let listStatus = 200;

afterEach(() => {
  cleanup();
  servedTemplates = [CARD];
  servedSkips = [];
  listStatus = 200;
});

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : String(input);
  if (path === "/api/templates/gallery") {
    if (listStatus !== 200) {
      return Response.json(
        { error: "The template gallery could not be read." },
        { status: listStatus },
      );
    }
    return Response.json({
      templates: servedTemplates,
      skipped: servedSkips,
      installers: "anyone",
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { TemplateGallery } = await import(
  "@/routes/_authed/_app/agents/gallery"
);

/** A real router over a memory history, so every `Link` on the page resolves without a mock. */
function routed(node: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => node,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/agents",
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/agents/gallery",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The app's router is registered globally for typing; this one only has to resolve the handful of
  // paths this screen links to.
  return <RouterProvider router={router as never} />;
}

async function renderGallery() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    routed(
      <QueryClientProvider client={client}>
        <TemplateGallery onClose={() => {}} reading={null} />
      </QueryClientProvider>,
    ),
  );
  await waitFor(() => expect(screen.getByText("In the box")).toBeDefined());
}

test("a card carries the name, the claim, the summary and what it asks for", async () => {
  await renderGallery();
  await screen.findByText("Renewal Desk");

  const body = document.body.textContent ?? "";
  expect(body).toContain("Chases overdue invoices and drafts the follow-up.");
  // The word that makes the author a claim rather than a fact.
  expect(body).toContain("Author claim");
  expect(body).toContain("acme-revops");
  // What it WANTS, said as a want.
  expect(body).toContain("google-drive");
  expect(body).toContain("Nothing is granted by reading it.");
});

/**
 * The rule this screen shares with the consent screen, asserted the same way it is there: by
 * reading the DOM rather than by trusting that nobody wrote an anchor.
 */
test("the author's address is text, and there is no link to it anywhere", async () => {
  await renderGallery();
  await screen.findByText("Renewal Desk");

  expect(document.body.textContent ?? "").toContain(
    "https://github.com/acme/openbot-templates",
  );
  for (const anchor of document.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    expect(href.startsWith("http")).toBe(false);
    expect(anchor.textContent ?? "").not.toContain("acme");
  }
});

/*
 * A card leads to READING, not to installing.
 *
 * It used to open the consent screen directly, which put "let me see what this is" and "I am
 * importing this" behind one gesture. The card now goes to the template's own page, where the whole
 * of a stranger's instructions can be read and closed without writing anything; the button that
 * installs lives there.
 */
test("the only link off a card is the one that opens the template's own page", async () => {
  await renderGallery();
  const read = await screen.findByText("Read this template");
  expect(read.closest("a")?.getAttribute("href")).toBe(
    "/agents/gallery/renewal-desk",
  );
});

/**
 * The absence, asserted. A count here would be a number nothing in this feature can produce
 * honestly, and the failure mode is somebody adding one because a gallery is expected to have them.
 */
test("nothing on the page counts, rates or ranks anything", async () => {
  await renderGallery();
  await screen.findByText("Renewal Desk");

  const body = (document.body.textContent ?? "").toLowerCase();
  for (const forbidden of [
    "install",
    "download",
    "rating",
    "stars",
    "popular",
    "trending",
  ]) {
    expect(`${forbidden}: ${body.includes(forbidden)}`).toBe(
      `${forbidden}: false`,
    );
  }
});

test("a file the gallery could not read is named rather than left as an absence", async () => {
  servedSkips = [SKIP];
  await renderGallery();
  await screen.findByText("Not listed");

  const body = document.body.textContent ?? "";
  expect(body).toContain("broken.openbot.yaml");
  expect(body).toContain("openbot_template must be 1.");
  // And the template that did parse is still on the page beside it.
  expect(body).toContain("Renewal Desk");
});

test("an empty gallery says so; a failed read says something else", async () => {
  servedTemplates = [];
  await renderGallery();
  expect(
    (document.body.textContent ?? "").includes(
      "This deployment ships no templates.",
    ),
  ).toBe(true);

  cleanup();
  listStatus = 500;
  await renderGallery();
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "The template gallery could not be read.",
    ),
  );
});

/**
 * A CATALOGUE RATHER THAN A HANDFUL, which is the case the browse controls exist for.
 *
 * Five templates in four groups, two of them sharing a category and one carrying none, and one
 * arriving from a pinned source rather than from the disk. That is the smallest list where every
 * rule on this screen is observable at once: a count that must match what a chip draws, a search
 * that must narrow, a category that must not exist because nobody used it, and an origin section
 * that must disappear when a filter empties it.
 */
const CATALOGUE = [
  { ...CARD },
  {
    ...CARD,
    slug: "pipeline-coach",
    name: "Pipeline Coach",
    title: "Deal Desk",
    summary: "Reads the week's deals and writes the standup note.",
    category: "sales",
    origin: { kind: "directory", filename: "pipeline-coach.openbot.yaml" },
  },
  {
    ...CARD,
    slug: "build-warden",
    name: "Build Warden",
    title: "Release Engineering",
    summary: "Watches the build and explains what broke.",
    category: "engineering",
    origin: { kind: "directory", filename: "build-warden.openbot.yaml" },
  },
  {
    ...CARD,
    slug: "night-porter",
    name: "Night Porter",
    title: "On Call",
    summary: "Takes the pager overnight and writes up the morning.",
    category: undefined,
    origin: { kind: "directory", filename: "night-porter.openbot.yaml" },
  },
  {
    ...CARD,
    slug: "hedge-trimmer",
    name: "Hedge Trimmer",
    title: "Platform",
    summary: "Prunes branches nobody has touched since the spring.",
    category: "engineering",
    origin: {
      kind: "source",
      sourceId: "acme",
      sha: "b".repeat(40),
      path: "hedge-trimmer.openbot.yaml",
    },
  },
];

/** One rendered card is one `<article>`, which is what makes counting them a fair reading. */
function cardsOnScreen(): string[] {
  return [...document.querySelectorAll("article")].map(
    (card) => card.querySelector("h3")?.textContent ?? "",
  );
}

/**
 * The property that makes a count worth drawing at all.
 *
 * A chip says a number and then draws a grid, and those two are produced by different code — the
 * number by a tally, the grid by a filter. If they ever disagree the chip is lying about the only
 * thing it claims, so this presses every chip in the row and checks the grid against the number the
 * chip announced rather than against a number written into this test.
 */
test("every chip draws exactly as many cards as its count says", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  await screen.findByText("Renewal Desk");

  const names = screen
    .getAllByRole("button", { pressed: false })
    .concat(screen.getAllByRole("button", { pressed: true }))
    .map((chip) => chip.textContent ?? "");
  // The vocabulary's own order, and only the categories somebody actually used.
  expect(names).toContain("All5");
  expect(names).toContain("Sales2");
  expect(names).toContain("Engineering2");
  expect(names).toContain("Uncategorised1");
  // Nothing draws a chip for a category no template is in.
  expect(names.some((name) => name.startsWith("Marketing"))).toBe(false);

  for (const [label, count] of [
    ["All", 5],
    ["Sales", 2],
    ["Engineering", 2],
    ["Uncategorised", 1],
  ] as const) {
    await userEvent.click(
      screen.getByRole("button", { name: `${label} ${count}` }),
    );
    expect(cardsOnScreen()).toHaveLength(count);
  }
});

/** The selected chip says so in the DOM, not only in its colour. */
test("one chip is selected at a time, and it is marked as pressed", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  await screen.findByText("Renewal Desk");

  await userEvent.click(screen.getByRole("button", { name: "Sales 2" }));
  expect(
    screen
      .getByRole("button", { name: "Sales 2" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen.getByRole("button", { name: "All 5" }).getAttribute("aria-pressed"),
  ).toBe("false");

  await userEvent.click(screen.getByRole("button", { name: "Engineering 2" }));
  expect(
    screen
      .getByRole("button", { name: "Sales 2" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  expect(
    screen
      .getByRole("button", { name: "Engineering 2" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("typing narrows the grid to the templates that answer it", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  await screen.findByText("Renewal Desk");

  await userEvent.type(screen.getByLabelText("Search templates"), "pipeline");
  await waitFor(() => expect(cardsOnScreen()).toEqual(["Pipeline Coach"]));

  // The summary is searched too, not only the name.
  await userEvent.clear(screen.getByLabelText("Search templates"));
  await userEvent.type(screen.getByLabelText("Search templates"), "pager");
  await waitFor(() => expect(cardsOnScreen()).toEqual(["Night Porter"]));
});

/**
 * The counts follow the search, which is the same promise as before under a narrower list: a chip
 * that still said 2 while the search had left one would be a number disagreeing with the screen
 * beside it.
 */
test("a search restates the chip counts rather than leaving them stale", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  await screen.findByText("Renewal Desk");

  await userEvent.type(screen.getByLabelText("Search templates"), "standup");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Sales 1" })).not.toBeNull(),
  );
  /*
   * The categories the search emptied keep their place and say so. They are not removed, because a
   * chip row that reshuffles under the cursor on every keystroke is a row somebody misclicks.
   */
  const emptied = screen.getByRole("button", { name: "Engineering 0" });
  expect(emptied.hasAttribute("disabled")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Sales 1" }));
  expect(cardsOnScreen()).toEqual(["Pipeline Coach"]);
});

test("a search that matches nothing says what was searched for, and the control clears it", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  await screen.findByText("Renewal Desk");

  await userEvent.type(screen.getByLabelText("Search templates"), "sourdough");
  await waitFor(() => expect(cardsOnScreen()).toHaveLength(0));

  const body = document.body.textContent ?? "";
  expect(body).toContain("No template matches");
  // The words that produced the emptiness, said back rather than left for the reader to recall.
  expect(body).toContain("sourdough");

  await userEvent.click(
    screen.getByRole("button", { name: "Clear the search" }),
  );
  await waitFor(() => expect(cardsOnScreen()).toHaveLength(5));
  expect(document.body.textContent ?? "").not.toContain("No template matches");
});

test("a chip that matches nothing says so too, and the control shows everything again", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  await screen.findByText("Renewal Desk");

  await userEvent.click(screen.getByRole("button", { name: "Sales 2" }));
  await userEvent.type(screen.getByLabelText("Search templates"), "pager");
  await waitFor(() => expect(cardsOnScreen()).toHaveLength(0));

  const body = document.body.textContent ?? "";
  expect(body).toContain("pager");
  expect(body).toContain("Sales");
  await userEvent.click(
    screen.getByRole("button", { name: "Clear the search and the filter" }),
  );
  await waitFor(() => expect(cardsOnScreen()).toHaveLength(5));
});

/**
 * WHERE A TEMPLATE CAME FROM SURVIVES THE FILTER.
 *
 * "In the box" and "From a pinned source" are provenance — code on this disk against a repository
 * somebody registered — and no amount of narrowing by job may blur the two. Filtering happens
 * INSIDE the sections, and a section a filter has emptied disappears rather than standing as a
 * heading over nothing.
 */
test("filtering narrows inside the origin sections, and empties one out of existence", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  await screen.findByText("Hedge Trimmer");
  expect(screen.queryByText("From a pinned source")).not.toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Sales 2" }));
  await waitFor(() =>
    expect(screen.queryByText("From a pinned source")).toBeNull(),
  );
  expect(screen.queryByText("In the box")).not.toBeNull();

  // And the other way: an engineering cut keeps both, one card in each.
  await userEvent.click(screen.getByRole("button", { name: "Engineering 2" }));
  await waitFor(() =>
    expect(screen.queryByText("From a pinned source")).not.toBeNull(),
  );
  expect(cardsOnScreen()).toEqual(["Build Warden", "Hedge Trimmer"]);
});

/**
 * The closed vocabulary, asserted where it matters: at the point a slug becomes something drawn.
 *
 * The server refuses a category outside the list, so a strange one here means the two halves are
 * different versions. The browser must not paper over that by printing the file's own string as a
 * label — that would be an author writing the words in a chip, which is the whole thing the closed
 * list prevents.
 */
test("a category this build does not know is uncategorised, never a chip of its own", async () => {
  servedTemplates = [
    { ...CARD },
    {
      ...CARD,
      slug: "wildcat",
      name: "Wildcat",
      title: "Unknown",
      summary: "Carries a category this build has never heard of.",
      category: "cryptomining",
      origin: { kind: "directory", filename: "wildcat.openbot.yaml" },
    },
  ];
  await renderGallery();
  await screen.findByText("Wildcat");

  expect(document.body.textContent ?? "").not.toContain("cryptomining");
  await userEvent.click(
    screen.getByRole("button", { name: "Uncategorised 1" }),
  );
  expect(cardsOnScreen()).toEqual(["Wildcat"]);
});

/** The card carries the words for its category, so a chip and a card agree about what a template is. */
test("the card states its category in this app's words, not the file's slug", async () => {
  servedTemplates = CATALOGUE;
  await renderGallery();
  const card = (await screen.findByText("Renewal Desk")).closest("article");
  expect(card?.textContent ?? "").toContain("Sales");
  expect(card?.textContent ?? "").not.toContain("sales");
});
