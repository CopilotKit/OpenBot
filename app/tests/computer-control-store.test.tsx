import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useComputerControl } from "@/lib/computers/use-control";

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const HUMAN = {
  holder: "human",
  since: new Date(0).toISOString(),
  requested: false,
};

/** Who holds the wheel, as the screen reads it, and how many times it was drawn. */
function Probe({
  computerId,
  seen,
}: {
  computerId: string;
  seen: Array<string | null>;
}) {
  const { control, problem } = useComputerControl(computerId);
  seen.push(problem ?? control?.holder ?? null);
  return null;
}

/** A computer that answers the control read with each of `answers` in turn, the last one forever after. */
function answering(answers: Array<"human" | "fails">) {
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).endsWith("/control"))
      return new Response(null, { status: 401 });
    const answer = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    return answer === "human"
      ? Response.json(HUMAN)
      : new Response(null, { status: 502 });
  }) as typeof fetch;
  return () => reads;
}

test("one read that does not come back leaves the wheel where it was", async () => {
  // Blanking it at once took the wheel off a person mid-sentence, for a hiccup the next read fixed.
  const reads = answering(["human", "fails", "human"]);
  const seen: Array<string | null> = [];
  render(<Probe computerId="control-hiccup" seen={seen} />);
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(3), {
    timeout: 4_000,
  });
  expect(
    seen.filter((holder) => holder !== "human" && holder !== null),
  ).toEqual([]);
});

test("reads that keep failing pause input", async () => {
  const reads = answering(["human", "fails"]);
  const seen: Array<string | null> = [];
  render(<Probe computerId="control-gone" seen={seen} />);
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(3), {
    timeout: 4_000,
  });
  await waitFor(() =>
    expect(seen.at(-1)).toStartWith("Reconnecting: browser ownership"),
  );
});

test("the same answer every second draws the screen once", async () => {
  const reads = answering(["human"]);
  const seen: Array<string | null> = [];
  render(<Probe computerId="control-steady" seen={seen} />);
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(3), {
    timeout: 4_000,
  });
  expect(seen.filter((holder) => holder === "human")).toHaveLength(1);
});
