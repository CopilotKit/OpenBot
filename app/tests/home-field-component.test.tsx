import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { HomeField, useHomeIntro } from "@/components/home/home-field";
import { createHomeIntro } from "@/lib/home-field";
import { clearSkin, setSkin } from "@/skins/store";

/*
 * The field behind Home's message box, and Home's first-view intro. The browser here has no WebGL,
 * which is also what an old browser or a blocked GPU gives: the field draws nothing and the page
 * stands as it was.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  act(() => clearSkin());
});
afterAll(() => GlobalRegistrator.unregister());

function Page() {
  const area = useRef<HTMLDivElement>(null);
  return (
    <div className="relative isolate">
      <HomeField area={area} intro={false} />
      <div ref={area}>
        <div data-slot="composer">Ask anything</div>
      </div>
    </div>
  );
}

test("on OpenBot's own look the field is a canvas that screen readers skip", () => {
  const view = render(<Page />);
  const canvas = view.container.querySelector("canvas");
  expect(canvas).not.toBeNull();
  expect(canvas?.closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  expect(view.getByText("Ask anything")).toBeTruthy();
});

test("with no WebGL the field draws nothing and hides, and the box is still there", () => {
  const view = render(<Page />);
  expect(view.container.querySelector("canvas")?.hidden).toBe(true);
  expect(view.getByText("Ask anything")).toBeTruthy();
});

test("under a skin there is no field: a skin draws its own palette", () => {
  act(() => setSkin("openduet"));
  const view = render(<Page />);
  expect(view.container.querySelector("canvas")).toBeNull();
  expect(view.getByText("Ask anything")).toBeTruthy();
});

/**
 * A stand-in for a browser's WebGL that behaves as a real one does in the one way that matters
 * here: a canvas hands back the same context every time, and once that context is lost it makes
 * nothing more.
 */
function fakeWebGl() {
  let lost = false;
  const gl = new Proxy(
    {},
    {
      get(_, name: string) {
        if (name === "getExtension")
          return (ext: string) =>
            ext === "WEBGL_lose_context"
              ? {
                  loseContext: () => {
                    lost = true;
                  },
                }
              : null;
        if (name === "isContextLost") return () => lost;
        if (/^create/.test(name)) return () => (lost ? null : {});
        if (/^get(Shader|Program)Parameter$/.test(name)) return () => !lost;
        if (name === "getAttribLocation") return () => 0;
        if (/^[A-Z_]+$/.test(name)) return 1;
        return () => ({});
      },
    },
  );
  return gl;
}

test("React mounting the field twice, as it does in development, still draws it", () => {
  const original = HTMLCanvasElement.prototype.getContext;
  const contexts = new WeakMap<HTMLCanvasElement, unknown>();
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, fakeWebGl());
    return contexts.get(this);
  } as typeof original;
  try {
    const view = render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    expect(view.container.querySelector("canvas")?.hidden).toBe(false);
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});

/* A visit of its own: the other Home tests in this run have had theirs. */
const visit = createHomeIntro(
  (() => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  })(),
);

function IntroProbe() {
  return <p>{useHomeIntro(visit) ? "intro" : "in place"}</p>;
}

test("the intro plays on the first Home of a visit, and coming back shows Home in place", () => {
  const first = render(<IntroProbe />);
  expect(first.getByText("intro")).toBeTruthy();
  first.unmount();
  const again = render(<IntroProbe />);
  expect(again.getByText("in place")).toBeTruthy();
});
