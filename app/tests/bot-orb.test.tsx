import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import AgentOrb, { type AIState } from "@/components/agents/orb/agent-orb";
import {
  BotOrb,
  type BotOrbState,
  followPointer,
  restingGaze,
} from "@/components/agents/orb/bot-orb";
import {
  drawBotOrb,
  FINISH_HELD,
  FINISH_S,
  finishPhase,
  ORB_PALETTES,
  type OrbPose,
  oklch,
  orbPaletteFor,
  palette,
  RAYS,
  track,
} from "@/components/agents/orb/bot-orb-draw";
import { subscribePointer } from "@/components/agents/orb/orb-clock";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const REST: OrbPose = {
  ta: 1.6,
  listen: 0,
  think: 0,
  done: 0,
  smile: 0,
  tilt: 0,
  ax: 0,
  ay: 0.04,
  blink: 0,
  nod: 0,
  doneAge: -1,
  noticeAge: -1,
  finishAge: -1,
  breath: 0,
};

/**
 * Just enough of a 2D context to run the drawing: it counts every stroke, and counts the frames
 * drawn, each of which starts by clearing the canvas.
 */
function fakeContext() {
  const gradient = { addColorStop: () => {} };
  const ctx = {
    strokes: 0,
    draws: 0,
    stroke() {
      this.strokes++;
    },
    clearRect() {
      this.draws++;
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  return new Proxy(ctx, {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : () => {},
    set: (target, key, value) => {
      (target as Record<string | symbol, unknown>)[key] = value;
      return true;
    },
  });
}

/** Every stroke one frame draws: the rim, the landing's ping, and a finish's rays and check. */
const strokesOf = (pose: OrbPose) => {
  const ctx = fakeContext();
  drawBotOrb(ctx as unknown as CanvasRenderingContext2D, 60, pose, {
    dark: false,
    palette: "violet",
  });
  return ctx.strokes;
};

/** The Bots a fresh OpenBot ships with, whose ids are their seeds. */
const TEAM = [
  "expense-review",
  "feedback-digest",
  "interview-notes",
  "meeting-follow-ups",
  "onboarding-buddy",
  "oncall-handover",
  "release-notes",
  "research-desk",
  "ticket-triage",
];

describe("the orb's motion", () => {
  test("an eased key arrives and a spring overshoots, then both settle on the target", () => {
    const eased = { from: 0, keys: [{ at: 1, to: 1, ease: 0.4 }] };
    expect(track(eased, 0.5)).toBe(0);
    expect(track(eased, 1.2)).toBeGreaterThan(0);
    expect(track(eased, 2)).toBe(1);

    const sprung = {
      from: 0,
      keys: [{ at: 0, to: 1, spring: [14, 0.5] as const }],
    };
    const peak = Math.max(
      ...Array.from({ length: 60 }, (_, i) => track(sprung, i / 60)),
    );
    expect(peak).toBeGreaterThan(1);
    expect(track(sprung, 5)).toBeCloseTo(1, 4);
  });

  test("a later key moves on from where the earlier one left it", () => {
    const tr = {
      from: 0,
      keys: [
        { at: 0, to: 1, ease: 0.4 },
        { at: 1, to: 0.25, ease: 0.4 },
      ],
    };
    expect(track(tr, 0.9)).toBe(1);
    expect(track(tr, 3)).toBe(0.25);
  });
});

describe("the colours", () => {
  test("every palette's base is pale and its shade deep", () => {
    for (const name of ORB_PALETTES) {
      const pal = palette(name, 1, 0);
      expect(Math.min(...pal.base)).toBeGreaterThan(200);
      expect(Math.max(...pal.deep)).toBeLessThan(230);
      expect(Math.max(...pal.shade)).toBeLessThan(100);
    }
  });

  test("a colour outside sRGB loses chroma rather than turning into another hue", () => {
    const [r, g, b] = oklch(0.6, 0.5, 262);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  test("a seed always gets the same palette", () => {
    for (const seed of TEAM) {
      expect(orbPaletteFor(seed)).toBe(orbPaletteFor(seed));
      expect(ORB_PALETTES).toContain(orbPaletteFor(seed));
    }
    // Pinned, so a change to the hash, which would recolour every Bot, can't land unnoticed.
    expect(orbPaletteFor("research-desk")).toBe("sky");
    expect(orbPaletteFor("release-notes")).toBe("violet");
    expect(ORB_PALETTES).toContain(orbPaletteFor(""));
  });

  test("nine palettes, and a team of nine seeds uses more than four of them", () => {
    expect(ORB_PALETTES).toHaveLength(9);
    expect(new Set(ORB_PALETTES).size).toBe(9);
    expect(new Set(TEAM.map(orbPaletteFor)).size).toBeGreaterThan(4);
  });

  test("each palette is a colour of its own", () => {
    const bases = ORB_PALETTES.map((name) => palette(name, 1, 0).main.join());
    expect(new Set(bases).size).toBe(ORB_PALETTES.length);
  });
});

describe("the drawing", () => {
  test("has no grilles: at rest its only stroke is the sphere's rim", () => {
    expect(strokesOf(REST)).toBe(1);
  });
});

describe("a finish", () => {
  test("the eyes give way to a check while the rays fly, then the eyes come back", () => {
    expect(finishPhase(-1)).toMatchObject({ check: 0, rays: -1, eyes: 1 });

    const burst = finishPhase(0.4);
    expect(burst.eyes).toBe(0);
    expect(burst.check).toBe(1);
    expect(burst.rays).toBeGreaterThan(0);
    expect(burst.rays).toBeLessThan(1);

    // Held: the check whole, the burst over.
    expect(finishPhase(FINISH_HELD)).toMatchObject({
      check: 1,
      checkAlpha: 1,
      rays: -1,
      eyes: 0,
    });

    expect(finishPhase(FINISH_S)).toEqual(finishPhase(-1));
  });

  test("the check strokes on along its length", () => {
    const early = finishPhase(0.12).check;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(finishPhase(0.24).check);
  });

  test("draws its rays and its check over the orb, and nothing once it is over", () => {
    const rest = strokesOf(REST);
    expect(strokesOf({ ...REST, finishAge: 0.4 })).toBe(rest + RAYS + 1);
    expect(strokesOf({ ...REST, finishAge: FINISH_HELD })).toBe(rest + 1);
    expect(strokesOf({ ...REST, finishAge: FINISH_S })).toBe(rest);
  });
});

/** Every canvas draws on `ctx` until `restore`, as if each had its own 2D context. */
function withContext(ctx: ReturnType<typeof fakeContext>) {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() =>
    ctx) as unknown as typeof getContext;
  return () => {
    HTMLCanvasElement.prototype.getContext = getContext;
  };
}

/**
 * Animation frames that run only when the test says, as the browser would at its next paint:
 * `requested` counts every frame asked for, `pending` the ones not yet run or cancelled.
 */
function manualFrames() {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  let requested = 0;
  const request = window.requestAnimationFrame;
  const cancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    requested++;
    queue.set(next, callback);
    return next++;
  };
  window.cancelAnimationFrame = (id) => {
    queue.delete(id);
  };
  return {
    get requested() {
      return requested;
    },
    get pending() {
      return queue.size;
    },
    run() {
      const due = [...queue.values()];
      queue.clear();
      const now = performance.now();
      for (const callback of due) callback(now);
    },
    restore() {
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
    },
  };
}

/** An `IntersectionObserver` that reports only what the test tells it to. */
class Sight {
  static all: Sight[] = [];
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  targets: Element[] = [];

  constructor(private readonly callback: IntersectionObserverCallback) {
    Sight.all.push(this);
  }

  observe(target: Element) {
    this.targets.push(target);
  }

  unobserve(target: Element) {
    this.targets = this.targets.filter((t) => t !== target);
  }

  disconnect() {
    this.targets = [];
  }

  takeRecords() {
    return [];
  }

  static show(target: Element, isIntersecting: boolean) {
    for (const sight of Sight.all) {
      if (!sight.targets.includes(target)) continue;
      sight.callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        sight as unknown as IntersectionObserver,
      );
    }
  }
}

/** Runs `body` with `IntersectionObserver` set to `observer`, or missing when it is undefined. */
function withObserver(observer: typeof Sight | undefined, body: () => void) {
  const original = globalThis.IntersectionObserver;
  if (observer) {
    globalThis.IntersectionObserver =
      observer as unknown as typeof IntersectionObserver;
  } else {
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
  }
  try {
    body();
  } finally {
    globalThis.IntersectionObserver = original;
    Sight.all = [];
  }
}

const orbOf = (container: HTMLElement) =>
  container.querySelector("[data-state]") as HTMLElement;

describe("<BotOrb>", () => {
  test("holds its footprint, hides from assistive tech, and draws on a canvas twice its size", () => {
    const view = render(
      <BotOrb palette="violet" size={40} state="listening" />,
    );
    const orb = view.container.firstElementChild as HTMLElement;
    expect(orb.getAttribute("aria-hidden")).toBe("true");
    expect(orb.dataset.state).toBe("listening");
    expect(orb.dataset.palette).toBe("violet");
    expect(orb.style.width).toBe("40px");
    const canvas = orb.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.style.width).toBe("80px");
    expect(canvas.style.left).toBe("-20px");
  });

  test("is a block, so a small face never sits on a line's baseline and drops out of its circle", () => {
    const view = render(<BotOrb palette="violet" size={12} />);
    const orb = view.container.firstElementChild as HTMLElement;
    expect(orb.classList.contains("block")).toBe(true);
    expect(orb.classList.contains("inline-block")).toBe(false);
  });

  test("still, it draws once and again only when the theme changes, never on a frame loop", async () => {
    const ctx = fakeContext();
    const frames = manualFrames();
    const restore = withContext(ctx);
    try {
      render(<BotOrb palette="ember" size={40} still />);
      expect(ctx.draws).toBe(1);
      document.documentElement.classList.add("dark");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ctx.draws).toBe(2);
      expect(frames.requested).toBe(0);

      cleanup();
      render(<BotOrb palette="ember" size={40} />);
      expect(frames.requested).toBe(1);
    } finally {
      cleanup();
      document.documentElement.classList.remove("dark");
      frames.restore();
      restore();
    }
  });

  test("still, finished is the check without the burst", () => {
    const strokes = (state?: "finished") => {
      const ctx = fakeContext();
      const restore = withContext(ctx);
      try {
        render(<BotOrb palette="moss" size={40} state={state} still />);
        cleanup();
        return ctx.strokes;
      } finally {
        restore();
      }
    };
    expect(strokes("finished")).toBe(strokes() + 1);
  });

  test("follows a change of state", () => {
    const view = render(<BotOrb palette="sun" size={40} />);
    expect(orbOf(view.container).dataset.state).toBe("idle");
    view.rerender(<BotOrb palette="sun" size={40} state="thinking" />);
    expect(orbOf(view.container).dataset.state).toBe("thinking");
    view.rerender(<BotOrb palette="sun" size={40} state="finished" />);
    expect(orbOf(view.container).dataset.state).toBe("finished");
  });

  test("fifty orbs share one animation frame", () => {
    withObserver(undefined, () => {
      const ctx = fakeContext();
      const frames = manualFrames();
      const restore = withContext(ctx);
      try {
        render(
          <div>
            {Array.from({ length: 50 }, (_, i) => `bot-${i}`).map((id) => (
              <BotOrb key={id} palette={orbPaletteFor(id)} size={28} />
            ))}
          </div>,
        );
        expect(frames.requested).toBe(1);
        frames.run();
        expect(ctx.draws).toBe(50);
        expect(frames.requested).toBe(2);

        // The last one gone, the clock stops asking for frames.
        cleanup();
        expect(frames.pending).toBe(0);
      } finally {
        cleanup();
        frames.restore();
        restore();
      }
    });
  });

  test("an orb off screen is not drawn", () => {
    withObserver(Sight, () => {
      const ctx = fakeContext();
      const frames = manualFrames();
      const restore = withContext(ctx);
      try {
        const view = render(<BotOrb palette="berry" size={40} />);
        const orb = orbOf(view.container);
        Sight.show(orb, false);
        expect(frames.pending).toBe(0);
        frames.run();
        expect(ctx.draws).toBe(0);

        Sight.show(orb, true);
        expect(frames.pending).toBe(1);
        frames.run();
        expect(ctx.draws).toBe(1);
      } finally {
        cleanup();
        frames.restore();
        restore();
      }
    });
  });

  test("nothing draws while the tab is hidden", () => {
    withObserver(undefined, () => {
      const ctx = fakeContext();
      const frames = manualFrames();
      const restore = withContext(ctx);
      const hide = (hidden: boolean) => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => hidden,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      };
      try {
        render(<BotOrb palette="ocean" size={40} />);
        expect(frames.pending).toBe(1);
        hide(true);
        expect(frames.pending).toBe(0);
        frames.run();
        expect(ctx.draws).toBe(0);

        hide(false);
        expect(frames.pending).toBe(1);
        frames.run();
        expect(ctx.draws).toBe(1);
      } finally {
        Reflect.deleteProperty(document, "hidden");
        cleanup();
        frames.restore();
        restore();
      }
    });
  });

  test("renders with no canvas context", () => {
    const frames = manualFrames();
    try {
      const view = render(
        <BotOrb palette="slate" size={40} state="thinking" />,
      );
      expect(view.container.querySelector("canvas")).not.toBeNull();
      // Nothing to draw on, so it asks for no frames.
      expect(frames.requested).toBe(0);
    } finally {
      cleanup();
      frames.restore();
    }
  });
});

describe("its eyes", () => {
  /** An orb 40 px across, centred at (120, 120). */
  const rect = { left: 100, top: 100, width: 40, height: 40 };
  const measure = () => rect;
  const moveTo = (x: number, y: number) =>
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: x, clientY: y }),
    );
  /** A second of frames at 30 a second, from `from` seconds on, and whether any of them perked up. */
  const watchFor = (
    gaze: ReturnType<typeof restingGaze>,
    state: BotOrbState,
    from = 0,
  ) => {
    let perked = false;
    for (let i = 1; i <= 30; i++) {
      perked = followPointer(gaze, from + i / 30, state, measure) || perked;
    }
    return perked;
  };

  test("turn to the pointer, fully at rest and partly while it works", () => {
    const stop = subscribePointer();
    try {
      moveTo(600, 120);
      const idle = restingGaze();
      const thinking = restingGaze();
      watchFor(idle, "idle");
      watchFor(idle, "idle", 1);
      watchFor(thinking, "thinking");
      watchFor(thinking, "thinking", 1);
      // Far to its right: it looks right, level.
      expect(idle.x).toBeGreaterThan(0.6);
      expect(Math.abs(idle.y)).toBeLessThan(0.05);
      expect(idle.w).toBeCloseTo(1, 2);
      expect(thinking.w).toBeCloseTo(0.35, 2);
    } finally {
      stop();
    }
  });

  test("perk up once when the pointer comes close, and let go only well past it", () => {
    const stop = subscribePointer();
    try {
      moveTo(600, 120);
      const gaze = restingGaze();
      expect(watchFor(gaze, "idle")).toBe(false);

      // Within 0.9 of its size of its centre.
      moveTo(150, 120);
      expect(watchFor(gaze, "idle", 1)).toBe(true);
      expect(watchFor(gaze, "idle", 2)).toBe(false);

      // Out to 1.2 of its size: still close, no second perk.
      moveTo(168, 120);
      expect(watchFor(gaze, "idle", 3)).toBe(false);
      moveTo(150, 120);
      expect(watchFor(gaze, "idle", 4)).toBe(false);

      // Past 1.3 it lets go, and the next approach perks again.
      moveTo(180, 120);
      watchFor(gaze, "idle", 5);
      moveTo(150, 120);
      expect(watchFor(gaze, "idle", 6)).toBe(true);
    } finally {
      stop();
    }
  });

  test("a listening orb has already noticed you, and stops watching once the pointer leaves", () => {
    const stop = subscribePointer();
    try {
      moveTo(150, 120);
      const gaze = restingGaze();
      expect(watchFor(gaze, "listening")).toBe(false);
      expect(gaze.w).toBeGreaterThan(0.4);

      document.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }),
      );
      watchFor(gaze, "listening", 1);
      watchFor(gaze, "listening", 2);
      expect(gaze.w).toBeLessThan(0.01);
    } finally {
      stop();
    }
  });
});

describe("a Bot's face and OpenBot's mark", () => {
  test("a Bot's avatar is named once and drawn as its orb", () => {
    const view = render(
      <AbstractAvatar name="Research desk" seed="research-desk" size={36} />,
    );
    const avatar = view.getByRole("img", { name: "Research desk" });
    expect(view.queryAllByRole("img")).toHaveLength(1);
    expect(avatar.style.width).toBe("36px");
    const orb = orbOf(avatar);
    expect(orb.getAttribute("aria-hidden")).toBe("true");
    expect(orb.dataset.palette).toBe(orbPaletteFor("research-desk"));
    expect(orb.style.width).toBe("36px");
    expect(avatar.querySelector("canvas")).not.toBeNull();
    expect(avatar.querySelector("svg")).toBeNull();
  });

  test("two Bots with different seeds can differ in colour, the same seed never does", () => {
    const paletteOf = (seed: string) => {
      const view = render(<AbstractAvatar name="Bot" seed={seed} />);
      const palette = orbOf(view.container).dataset.palette;
      cleanup();
      return palette;
    };
    expect(paletteOf("research-desk")).not.toBe(paletteOf("release-notes"));
    expect(paletteOf("research-desk")).toBe(paletteOf("research-desk"));
  });

  test("OpenBot's mark is violet and maps every state", () => {
    const states: Record<AIState, BotOrbState> = {
      idle: "idle",
      listening: "listening",
      thinking: "thinking",
      streaming: "thinking",
      done: "done",
      error: "idle",
    };
    for (const [state, shown] of Object.entries(states)) {
      const view = render(<AgentOrb size="64px" state={state as AIState} />);
      const orb = orbOf(view.container);
      expect(orb.dataset.palette).toBe("violet");
      expect(orb.dataset.state).toBe(shown);
      expect(orb.style.width).toBe("64px");
      cleanup();
    }
    const view = render(<AgentOrb />);
    expect(orbOf(view.container).style.width).toBe("192px");
  });

  test("OpenBot's mark is drawn at a size in px, and refuses a share of its container", () => {
    const view = render(<AgentOrb size="27.5px" />);
    expect(orbOf(view.container).style.width).toBe("27.5px");
    // Read as a number, "100%" would draw a 100px orb whatever its container is.
    // @ts-expect-error Only a size in px type-checks.
    expect(() => AgentOrb({ size: "100%" })).toThrow(
      `AgentOrb's size is in px, as "64px", not "100%".`,
    );
  });
});
