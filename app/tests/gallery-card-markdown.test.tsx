import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  ChecklistCard,
  NoticeCard,
  RecordCard,
} from "@/components/gallery/cards";
import { ApprovalCard, ChoiceCard } from "@/components/gallery/decisions";
import { QuoteCard } from "@/components/gallery/quote";
import { DataTable } from "@/components/gallery/table";
import { settleReactWork } from "./settle-react-work";

/**
 * The text a Bot writes into a card is drawn the way its reply is: as markdown, with links as link
 * text.
 *
 * Asked for "my five most recent unread emails, with a link to each message", a Bot drew a notice
 * whose points were `[Sender](https://mail.google.com/...) — time. What it is about.` The card drew
 * that literally: brackets, parentheses and every long Gmail address, filling the card, with nothing
 * to click. A reply draws the same line as the sender's name, linked. The points below are that
 * card's, with the senders' names swapped for placeholders.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BODY =
  "All five are updated calendar invitations from Alex Rivera for Monday, November 9. Times are Pacific; your attendance is marked optional.";

const EMAILS = [
  {
    name: "Northwind Traders",
    href: "https://mail.google.com/mail/u/0/#inbox/1a1b9a5fcb357c40",
    rest: "5:00–5:25 pm. Discuss its proposed open-source proof of concept, architecture fit, capabilities and human handoff.",
  },
  {
    name: "Contoso",
    href: "https://mail.google.com/mail/u/0/#inbox/1a1b9a5ac4f756e7",
    rest: "4:00–5:00 pm. Proof-of-concept discussion.",
  },
  {
    name: "Fabrikam",
    href: "https://mail.google.com/mail/u/0/#inbox/1a1b9a594ffa763a",
    rest: "2:00–3:00 pm. Weekly engineering sync.",
  },
  {
    name: "Tailspin Toys",
    href: "https://mail.google.com/mail/u/0/#inbox/1a1b9a121f53fe9c",
    rest: "7:30–7:55 am. Stand-up to develop a plan and establish next steps; the invitation links to a mutual action plan.",
  },
  {
    name: "Litware",
    href: "https://mail.google.com/mail/u/0/#inbox/1a1b99f29f125e40",
    rest: "7:00–7:25 am. Demo covering on-premise agents and workflows, managed infrastructure, authentication and security.",
  },
];

const POINTS = EMAILS.map(
  (email) => `[${email.name}](${email.href}) — ${email.rest}`,
);

/** Bold as a reply draws it: Streamdown's own element for `**…**`, the same one the transcript uses. */
const BOLD = '[data-streamdown="strong"]';

/** Every link in `root`, as the text a person reads and the address it opens. */
function links(root: HTMLElement) {
  return [...root.querySelectorAll("a")].map((anchor) => ({
    text: anchor.textContent,
    href: anchor.getAttribute("href"),
  }));
}

test("a notice's points draw a markdown link as its text, linked, with no markdown left", () => {
  const { container } = render(
    <NoticeCard
      body={BODY}
      points={POINTS}
      title="Five most recent unread emails"
    />,
  );

  expect(links(container)).toEqual(
    EMAILS.map((email) => ({ text: email.name, href: email.href })),
  );
  expect(container.textContent).not.toContain("](http");
  expect(container.textContent).not.toContain("mail.google.com");
  // The rest of each line is still there, after the link.
  for (const email of EMAILS)
    expect(container.textContent).toContain(email.rest);
  expect(container.textContent).toContain(BODY);
});

test("a link in a card opens outside OpenBot, as a link in a reply does", () => {
  const { container } = render(
    <NoticeCard points={POINTS.slice(0, 1)} title="Unread" />,
  );
  const anchor = container.querySelector("a");
  // A new tab with no opener: OpenBot Desktop hands exactly these to the person's own browser.
  expect(anchor?.getAttribute("target")).toBe("_blank");
  expect(anchor?.getAttribute("rel")).toContain("noreferrer");
});

test("a notice's body draws bold, inline code and a list", () => {
  const { container } = render(
    <NoticeCard
      body={"**Two** need a reply before `Friday`:\n\n- Contoso\n- Fabrikam"}
      title="Replies"
    />,
  );
  expect(container.querySelector(BOLD)?.textContent).toBe("Two");
  expect(container.querySelector("code")?.textContent).toBe("Friday");
  expect(
    [...container.querySelectorAll("li")].map((item) => item.textContent),
  ).toEqual(["Contoso", "Fabrikam"]);
  expect(container.textContent).not.toContain("**");
  expect(container.textContent).not.toContain("`");
});

test("a script in a card's text is not run or drawn as markup", () => {
  const { container } = render(
    <NoticeCard
      body={'<img src="x" onerror="alert(1)"> [here](javascript:alert(1))'}
      title="Unsafe"
    />,
  );
  expect(container.querySelector("img[onerror]")).toBeNull();
  for (const anchor of container.querySelectorAll("a")) {
    expect(anchor.getAttribute("href") ?? "").not.toContain("javascript:");
  }
});

/*
 * Every other card whose text is the Bot's own prose draws it the same way. Titles, captions and
 * labels stay plain: they are one line, cut to fit, and a link there would be a second action in the
 * card's heading.
 */
const ONE = EMAILS[0];
const LINE = POINTS[0];
const expectOneLink = (root: HTMLElement) => {
  expect(links(root)).toEqual([{ text: ONE.name, href: ONE.href }]);
  expect(root.textContent).not.toContain("](http");
};

test("a record's field values draw markdown", () => {
  const { container } = render(
    <RecordCard fields={[{ label: "Message", value: LINE }]} title="Email" />,
  );
  expectOneLink(container);
});

test("a checklist's items and notes draw markdown", () => {
  const { container } = render(
    <ChecklistCard
      items={[{ text: LINE, done: false, note: "Waiting on **Contoso**" }]}
      title="Replies"
    />,
  );
  expectOneLink(container);
  expect(container.querySelector(BOLD)?.textContent).toBe("Contoso");
});

test("a quotation draws markdown", () => {
  const { container } = render(<QuoteCard attribution="Inbox" quote={LINE} />);
  expectOneLink(container);
});

test("an approval's summary and detail values draw markdown", () => {
  const { container } = render(
    <ApprovalCard
      args={{
        title: "Archive this email",
        summary: LINE,
        details: [{ label: "From", value: "**Contoso**" }],
      }}
      respond={async () => {}}
      result={undefined}
      status="executing"
    />,
  );
  expectOneLink(container);
  expect(container.querySelector(BOLD)?.textContent).toBe("Contoso");
});

test("a choice's summary draws markdown", () => {
  const { container } = render(
    <ChoiceCard
      args={{
        title: "Which one should I archive?",
        summary: LINE,
        options: [{ id: "contoso", label: "Contoso" }],
      }}
      respond={async () => {}}
      result={undefined}
      status="executing"
    />,
  );
  expectOneLink(container);
});

test("a table's text cells draw markdown and its number cells stay numbers", () => {
  const { container } = render(
    <DataTable
      columns={["Email", "Minutes"]}
      rows={[{ cells: [LINE, 25] }]}
      title="Unread"
    />,
  );
  expectOneLink(container);
  expect(container.querySelector("td.tabular-nums")?.textContent).toBe("25");
});

/*
 * A notice's supporting point that is itself a Markdown list drew the notice's `·` and then an
 * indented list beside it. The point hides its `·` and the list's indent through selectors on the
 * `<li>` that read the shape Streamdown draws (the point's text, then a list as its first child), so
 * the shape is pinned here as well as the classes.
 */
test("a notice point that is a list draws without the notice's dot or a second indent", () => {
  const { container } = render(
    <NoticeCard
      points={["- Contoso\n- Fabrikam", "One plain point"]}
      title="Replies"
    />,
  );
  const points = [...container.querySelectorAll("ul.mt-2 > li")];
  expect(points).toHaveLength(2);
  const [list, plain] = points as HTMLElement[];
  for (const point of points)
    expect(point.className).toContain(
      "[&:has(>div>:is(ol,ul):first-child)>span]:hidden",
    );
  expect(list?.querySelector(":scope > div > ul:first-child")).not.toBeNull();
  expect(
    [...(list?.querySelectorAll(":scope > div > ul > li") ?? [])].map(
      (item) => item.textContent,
    ),
  ).toEqual(["Contoso", "Fabrikam"]);
  // A plain point keeps its dot: nothing in it matches the selector.
  expect(
    plain?.querySelector(":scope > div > :is(ol,ul):first-child"),
  ).toBeNull();
  expect(plain?.querySelector(":scope > span")?.textContent).toBe("·");
});

/*
 * A card is narrower than a reply and clips what runs past its edge, so a bare long URL in a card's
 * text lost its end. Every card draws its prose through `GalleryMarkdown`, which always wraps.
 */
const LONG_URL =
  "https://mail.google.com/mail/u/0/#inbox/1a1b9a5fcb357c40a1b9a5fcb357c40a1b9a5fcb357c40a1b9a5fcb357c40";

test("a long link in a card's text wraps instead of running past the card's edge", () => {
  const cards = [
    <NoticeCard body={LONG_URL} key="n" points={[LONG_URL]} title="Link" />,
    <ChecklistCard
      items={[{ text: LONG_URL, done: false }]}
      key="c"
      title="Link"
    />,
    <QuoteCard attribution="Inbox" key="q" quote={LONG_URL} />,
  ];
  for (const card of cards) {
    const { container, unmount } = render(card);
    const holders = [...container.querySelectorAll("*")].filter(
      (element) =>
        element.textContent?.includes(LONG_URL) &&
        element.className.toString().split(/\s+/).includes("break-words"),
    );
    expect(holders.length).toBeGreaterThan(0);
    unmount();
  }
});

test("a choice's options can shrink to the card, so a long link in one wraps", () => {
  const { container } = render(
    <ChoiceCard
      args={{
        title: "Which one?",
        options: [{ id: "a", label: "Contoso", description: LONG_URL }],
      }}
      respond={async () => {}}
      result={undefined}
      status="executing"
    />,
  );
  expect(container.querySelector("fieldset")?.className.split(/\s+/)).toContain(
    "min-w-0",
  );
});
