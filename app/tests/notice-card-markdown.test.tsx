import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { NoticeCard } from "@/components/gallery/cards";
import { GalleryStreamingContext } from "@/components/gallery/streaming";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("notice body and supporting points render Markdown with the reply's links", () => {
  const view = render(
    <NoticeCard
      title="Two emails to check"
      tone="caution"
      body="These are my **highest-priority** picks. See the [review](https://docs.google.com/document/d/review/edit)."
      points={[
        "1. ElevenLabs — new login. [Read the email](https://mail.google.com/mail/u/0/#all/example-one).",
        "2. AWS — update `redis`. [Read the email](https://mail.google.com/mail/u/0/#all/example-two).",
      ]}
    />,
  );

  expect(view.getByText("Heads up")).toBeTruthy();
  expect(
    view.getByText("highest-priority").getAttribute("data-streamdown"),
  ).toBe("strong");
  expect(view.getByText("redis").tagName).toBe("CODE");
  const emails = view.getAllByRole("link", { name: "Read the email" });
  expect(emails.map((link) => link.getAttribute("href"))).toEqual([
    "https://mail.google.com/mail/u/0/#all/example-one",
    "https://mail.google.com/mail/u/0/#all/example-two",
  ]);
  for (const link of emails) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  }
  expect(view.getByRole("link", { name: "review Doc" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("[Read the email]");
});

test("notice Markdown supports blocks and keeps the existing renderer's sanitization", async () => {
  const view = render(
    <NoticeCard
      body={
        "## Review\n\n- **First**\n- Second\n\n```js\nconst ready = true;\n```"
      }
      points={["[Unsafe](javascript:alert(1))", '<script>alert("no")</script>']}
    />,
  );

  expect(view.getByRole("heading", { name: "Review" })).toBeTruthy();
  expect(view.getByText("First").getAttribute("data-streamdown")).toBe(
    "strong",
  );
  expect(view.container.querySelector("p pre, p div, p ul")).toBeNull();
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
  await waitFor(() => {
    expect(
      view.container.querySelector('pre span[style*="--shiki-dark"]'),
    ).toBeTruthy();
  });
  expect(view.getByRole("button", { name: /copy/i })).toBeTruthy();
});

test("notice Markdown handles partial arguments while streaming and completed text on replay", () => {
  const view = render(
    <GalleryStreamingContext.Provider value>
      <NoticeCard body="Check **priority" points={["Read **first"]} />
    </GalleryStreamingContext.Provider>,
  );
  expect(view.getByText("priority").getAttribute("data-streamdown")).toBe(
    "strong",
  );
  expect(view.getByText("first").getAttribute("data-streamdown")).toBe(
    "strong",
  );

  view.rerender(
    <GalleryStreamingContext.Provider value={false}>
      <NoticeCard body="Check **priority**." points={["Read **first**."]} />
    </GalleryStreamingContext.Provider>,
  );
  expect(view.getByText("priority").getAttribute("data-streamdown")).toBe(
    "strong",
  );
  expect(view.getByText("first").getAttribute("data-streamdown")).toBe(
    "strong",
  );

  view.rerender(<NoticeCard />);
  expect(view.container.textContent).toBe("");
});
