import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { QuoteCard } from "@/components/gallery/quote";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/*
 * The source line read ", Knowledge Bot": a quotation card a Bot drew, seen on screen with a stray
 * comma where a dash once introduced the source. The source stands on its own line, so it needs no
 * punctuation in front of it.
 */
test("a quotation's source is shown as the name alone, with no leading punctuation", () => {
  const { container } = render(
    <QuoteCard
      quote="A Kubernetes operator is a custom controller."
      attribution="Knowledge Bot"
    />,
  );
  const source = container.querySelector("blockquote footer");
  expect(source?.textContent?.trim()).toBe("Knowledge Bot");
});

test("a quotation without a source draws no source line", () => {
  const { container } = render(
    <QuoteCard quote="A Kubernetes operator is a custom controller." />,
  );
  expect(container.querySelector("blockquote footer")).toBeNull();
});
