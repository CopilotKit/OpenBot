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
import { BotLookProvider } from "@/components/agents/bot-look";
import { BotOrb } from "@/components/agents/bot-orb";
import { BotKite, type KiteState } from "@/components/agents/kite/bot-kite";
import {
  KITE_COLORS,
  KITE_PATTERNS,
  KITE_STATUS,
  kiteColor,
  kiteTones,
  sailPattern,
} from "@/components/agents/kite/kite";
import { ORB_PALETTES, orbPalette } from "@/lib/orb-palette";
import { settleReactWork } from "./settle-react-work";

/*
 * The Kite Bot skin draws each Bot as a kite: one silhouette for every Bot, in colours of its own (a
 * colour and a sail pattern from its seed), with pixel eyes only at moments of contact and its state
 * in a status pixel beside it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const SEEDS = Array.from({ length: 200 }, (_, n) => `bot-${n}`);

function kite(size: number, state: KiteState = "idle", seed = "knowledge") {
  const view = render(
    <BotKite name="Knowledge" seed={seed} size={size} state={state} />,
  );
  const root = view.container.querySelector<HTMLElement>("[data-kite]");
  if (!root) throw new Error("no kite drawn");
  return {
    root,
    eyes: root.querySelectorAll(".bot-kite-eye"),
    status: root.querySelector(`[fill="${KITE_STATUS.working}"]`)
      ? "working"
      : root.querySelector(`[fill="${KITE_STATUS.waiting}"]`)
        ? "waiting"
        : null,
  };
}

describe("a Bot's colours", () => {
  test("is the same colour slot as its orb, so a skin switch keeps each Bot's colour", () => {
    for (const seed of ["", ...SEEDS]) {
      expect(KITE_COLORS.indexOf(kiteColor(seed))).toBe(
        ORB_PALETTES.indexOf(orbPalette(seed)),
      );
    }
  });

  test("comes from the seed alone, and every pattern is used", () => {
    for (const seed of SEEDS) {
      expect(sailPattern(seed)).toBe(sailPattern(seed));
    }
    const used = new Set(SEEDS.map(sailPattern));
    expect([...used].sort()).toEqual([...KITE_PATTERNS].sort());
  });

  test("varies the pattern within one colour", () => {
    const violet = SEEDS.filter((seed) => kiteColor(seed).name === "violet");
    expect(new Set(violet.map(sailPattern)).size).toBeGreaterThan(3);
  });

  test("never paints a body in a status colour", () => {
    const status = Object.values(KITE_STATUS);
    for (const color of KITE_COLORS) {
      for (const dark of [false, true]) {
        const tones = kiteTones(color, dark);
        expect(status).not.toContain(tones.body);
        expect(status).not.toContain(tones.panel);
      }
    }
  });

  test("reads at 3:1 or better on its page, light and dark", () => {
    const luminance = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const color of KITE_COLORS) {
      expect(contrast(color.hex, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrast(color.darkHex, "#0a0a0a")).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("a kite's face", () => {
  test("is absent in a list: an idle kite at avatar size is a still shape", () => {
    for (const size of [16, 20, 24, 32, 40]) {
      const drawn = kite(size);
      expect(drawn.eyes).toHaveLength(0);
      expect(drawn.status).toBeNull();
      cleanup();
    }
  });

  test("wakes where the page is about the Bot, and holds its look at the words beside it", () => {
    const drawn = kite(96);
    // Two eyes, each two pixels wide and three tall.
    expect(drawn.eyes).toHaveLength(12);
    expect(drawn.root.querySelector(".bot-kite-lids")).not.toBeNull();
    expect(drawn.root.querySelector(".bot-kite-glance")).toBeNull();
  });

  test("woken small by contact, stands by: it blinks and glances one whole pixel aside", () => {
    const view = render(
      <BotKite awake name="Knowledge" seed="knowledge" size={22} />,
    );
    const root = view.container.querySelector<HTMLElement>("[data-kite]");
    expect(root?.querySelectorAll(".bot-kite-eye")).toHaveLength(12);
    expect(root?.querySelector(".bot-kite-lids")).not.toBeNull();
    expect(root?.querySelector(".bot-kite-glance")).not.toBeNull();
    const by = Number.parseFloat(
      root?.style.getPropertyValue("--kite-glance-by") ?? "",
    );
    expect(Math.abs(by * 22)).toBeCloseTo(1, 9);
  });

  test("looks out with taller eyes while the Bot waits on the person, from 22px", () => {
    expect(kite(20, "waiting").eyes).toHaveLength(0);
    cleanup();
    const drawn = kite(24, "waiting");
    expect(drawn.eyes).toHaveLength(16);
    expect(drawn.status).toBe("waiting");
  });

  test("steps back while the Bot works, and a blue pixel keeps time", () => {
    const drawn = kite(96, "working");
    expect(drawn.eyes).toHaveLength(0);
    expect(drawn.status).toBe("working");
    expect(drawn.root.querySelector(".bot-kite-pulse")).not.toBeNull();
  });

  test("sits on whole screen pixels at every size", () => {
    for (const size of [24, 48, 64, 96, 120, 160]) {
      const drawn = kite(size, "waiting");
      for (const eye of drawn.eyes) {
        for (const attribute of ["x", "y", "width", "height"]) {
          const units = Number(eye.getAttribute(attribute));
          const pixels =
            (attribute === "x" || attribute === "y" ? units + 0.5 : units) *
            size;
          expect(Math.abs(pixels - Math.round(pixels))).toBeLessThan(1e-6);
        }
      }
      cleanup();
    }
  });

  test("never moves a kite of 32px or under", () => {
    expect(
      kite(32, "waiting").root.querySelector(".bot-kite-nudge"),
    ).toBeNull();
    cleanup();
    expect(
      kite(48, "waiting").root.querySelector(".bot-kite-nudge"),
    ).not.toBeNull();
  });
});

test("every spot that draws a Bot's orb draws its kite where Bots are kites", () => {
  const view = render(
    <BotLookProvider value="kite">
      <BotOrb name="Knowledge" seed="knowledge" size={20} />
    </BotLookProvider>,
  );
  const drawn = view.getByRole("img", { name: "Knowledge" });
  expect(drawn.dataset.kite).toBe("idle");
  expect(drawn.dataset.sail).toBe(
    `${kiteColor("knowledge").name} ${sailPattern("knowledge")}`,
  );
});

test("is announced once, by the Bot's name", () => {
  const view = render(<BotKite name="Knowledge" seed="knowledge" size={96} />);
  expect(view.getAllByRole("img")).toHaveLength(1);
  expect(view.container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
});
