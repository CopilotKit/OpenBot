import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { BotKite, OpenBotKite } from "@/components/agents/kite/kite";
import { OPENBOT_SLOT } from "@/components/agents/kite/kite-draw";
import { settleReactWork } from "./settle-react-work";

/*
 * The kite as a component: who it is to a screen reader, and what it costs. A sidebar of resting
 * Bots draws each once and then asks the browser for nothing; Bots that move share one loop; a
 * held kite never animates; dark mode redraws in each colour's dark twin.
 */

/** Every body colour the kites filled, in order. */
let bodies: string[] = [];
/** Animation frames asked for and not yet run. */
let frames: FrameRequestCallback[] = [];
let clock = 0;

function context() {
  return {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    fill(this: { fillStyle: string }, path?: unknown) {
      if (path) bodies.push(this.fillStyle);
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    setTransform() {},
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    clip() {},
    stroke() {},
    strokeRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    quadraticCurveTo() {},
  };
}

const SEEDS = (n: number) => Array.from({ length: n }, (_, i) => `bot-${i}`);

/** Runs the frames asked for so far, `ms` later, and says how many the page asked for next. */
function runFrames(ms: number): number {
  clock += ms;
  const now = frames;
  frames = [];
  for (const frame of now) frame(clock);
  return frames.length;
}

const realPath2D = globalThis.Path2D;

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.Path2D = class {
    moveTo() {}
    lineTo() {}
    closePath() {}
  } as unknown as typeof Path2D;
});
beforeEach(() => {
  bodies = [];
  frames = [];
  clock = 0;
  spyOn(performance, "now").mockImplementation(() => clock);
  spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
    frames.push(frame);
    return frames.length;
  });
  spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    frames = [];
  });
  spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context() as never,
  );
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  mock.restore();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
  globalThis.Path2D = realPath2D;
});

test("a Bot is announced once, by its name", () => {
  const view = render(<BotKite name="Expense Review" seed="expense-review" />);
  const kite = view.getByRole("img");
  expect(kite.getAttribute("aria-label")).toBe("Expense Review");
  expect(kite.querySelector("canvas")).not.toBeNull();
  expect(view.getAllByRole("img")).toHaveLength(1);
});

test("OpenBot's own kite is violet quarters, and decorative", () => {
  const view = render(<OpenBotKite size={56} />);
  expect(view.queryByRole("img")).toBeNull();
  const kite = view.container.querySelector<HTMLElement>("[data-kite]");
  expect(kite?.getAttribute("aria-hidden")).toBe("true");
  expect(kite?.dataset.slot).toBe(String(OPENBOT_SLOT));
  expect(kite?.dataset.pattern).toBe("quarters");
  expect(bodies).toEqual(["#6430ab"]);
});

test("a sidebar of resting Bots draws each once and asks for no frames", () => {
  render(
    <div>
      {SEEDS(20).map((seed) => (
        <BotKite key={seed} name={seed} seed={seed} size={24} />
      ))}
    </div>,
  );
  expect(bodies).toHaveLength(20);
  expect(frames).toHaveLength(0);
});

test("Bots that are working share one loop", () => {
  render(
    <div>
      {SEEDS(5).map((seed) => (
        <BotKite
          key={seed}
          name={seed}
          seed={seed}
          size={24}
          state="thinking"
        />
      ))}
    </div>,
  );
  expect(frames).toHaveLength(1);
  bodies = [];
  expect(runFrames(16)).toBe(1);
  expect(bodies).toHaveLength(5);
});

test("a change of state plays out, then the Bot stops asking for frames", () => {
  const view = render(<BotKite name="Inbox" seed="inbox" size={24} />);
  expect(frames).toHaveLength(0);
  view.rerender(
    <BotKite name="Inbox" seed="inbox" size={24} state="listening" />,
  );
  expect(frames).toHaveLength(1);
  let asked = 1;
  for (let i = 0; i < 60 && asked > 0; i++) asked = runFrames(16);
  expect(asked).toBe(0);
  // About 0.75 s of frames, not a loop that never ends.
  expect(clock).toBeGreaterThan(700);
  expect(clock).toBeLessThan(900);
});

test("a held kite never animates, even while it works", () => {
  render(<BotKite name="Ops" seed="ops" size={96} state="thinking" still />);
  expect(bodies).toHaveLength(1);
  expect(frames).toHaveLength(0);
});

test("dark mode redraws each Bot in its colour's dark twin", async () => {
  render(<OpenBotKite size={48} />);
  expect(bodies).toEqual(["#6430ab"]);
  await act(async () => {
    document.documentElement.classList.add("dark");
    await Promise.resolve();
  });
  expect(bodies.at(-1)).toBe("#9265dd");
});

test("a kite that mounts done after working plays its landing", () => {
  render(<OpenBotKite enterFrom="thinking" size={88} state="done" />);
  expect(frames).toHaveLength(1);
});

test("a zoom or a move to another screen redraws a resting kite at the new resolution", async () => {
  let changed: (() => void) | null = null;
  spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        addEventListener: (_: string, listener: () => void) => {
          changed = listener;
        },
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  let ratio = 1;
  const original = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    get: () => ratio,
  });
  try {
    const view = render(<OpenBotKite size={24} />);
    const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
    const before = canvas.width;
    ratio = 2;
    await act(async () => {
      changed?.();
      await Promise.resolve();
    });
    expect(canvas.width).toBe(before * 2);
    expect(frames).toHaveLength(0);
  } finally {
    if (original) Object.defineProperty(window, "devicePixelRatio", original);
    else Reflect.deleteProperty(window, "devicePixelRatio");
  }
});
