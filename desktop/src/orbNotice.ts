import {
  AGENT_ORB_AT_REST,
  AGENT_ORB_LISTENING,
  type AgentOrbMood,
  agentOrbDriftSeconds,
} from "../../shared/agent-orb";

/*
 * A click on the setup window's orb: a short "I noticed you". The orb goes from the app's `idle`
 * towards its `listening` (it swells, its colour comes up, its bloom brightens) and settles back by
 * itself, about half a second in all. Delight only: nothing else happens on the click.
 */

/** Up to the noticed look, quick, as AgentOrb's spring takes a state change (0.25 s, little bounce). */
export const NOTICE_RISE_MS = 150;
/** Back to rest, slower, so it settles rather than snaps. */
export const NOTICE_SETTLE_MS = 350;
export const NOTICE_MS = NOTICE_RISE_MS + NOTICE_SETTLE_MS;

/**
 * How many times its resting speed the mesh turns at the top of the reaction. Listening's own speed
 * (1 against idle's 0.6) moves the mesh by a degree or two in half a second, which nobody sees; this
 * surge turns it by a visible part of a turn, then hands back to the resting tempo.
 */
export const NOTICE_SWIRL_PEAK = 10;

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeInOutCubic = (x: number) =>
  x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;

/** How far into the reaction the orb is at `t` ms after it started: 0 at rest, 1 fully noticed. */
export function noticeLevel(t: number): number {
  if (t <= 0 || t >= NOTICE_MS) return 0;
  if (t < NOTICE_RISE_MS) return easeOutCubic(t / NOTICE_RISE_MS);
  return 1 - easeInOutCubic((t - NOTICE_RISE_MS) / NOTICE_SETTLE_MS);
}

/**
 * Where a click `t` ms into a reaction picks it up: still rising, it carries on; settling, it goes
 * back to the point on the rise at the level the orb is at now, so the orb swells again from where
 * it is. It never jumps, and two clicks never add up to a bigger reaction.
 */
export function noticeAgain(t: number): number {
  if (t < NOTICE_RISE_MS) return Math.max(t, 0);
  if (t >= NOTICE_MS) return 0;
  const level = noticeLevel(t);
  return NOTICE_RISE_MS * (1 - Math.cbrt(1 - level));
}

/** The orb's look at a level of the reaction, between idle and listening. */
export function noticeLook(
  level: number,
  rest: AgentOrbMood = AGENT_ORB_AT_REST,
  listening: AgentOrbMood = AGENT_ORB_LISTENING,
) {
  const mix = (from: number, to: number) => from + (to - from) * level;
  return {
    glow: mix(rest.glow, listening.glow),
    saturation: mix(rest.saturation, listening.saturation),
    // The disc fills its box at rest, so the swell is listening's scale over idle's.
    scale: mix(1, listening.scale / rest.scale),
    swirl: mix(1, NOTICE_SWIRL_PEAK),
    drift: mix(
      1,
      agentOrbDriftSeconds(rest.speed) / agentOrbDriftSeconds(listening.speed),
    ),
  };
}

/** The look of the orb at rest, as custom properties on its box. */
export function restingLook(): Record<string, string> {
  return lookProperties(noticeLook(0));
}

function lookProperties(look: ReturnType<typeof noticeLook>) {
  return {
    "--orb-glow": String(look.glow),
    "--orb-saturation": String(look.saturation),
    "--orb-scale": String(look.scale),
  };
}

/**
 * Makes a click on `box` give the reaction, and returns what stops listening. Under reduced motion a
 * click does nothing. The mesh's and the sheen's own CSS animations are sped up and handed back
 * (their `playbackRate`, which keeps their place), so the orb never jumps.
 */
export function noticeOnClick(box: HTMLElement): () => void {
  // The document's own timeline, which runs as the animations do: a page that holds its clock
  // still (the workbench's) must not leave the orb noticing for ever.
  const now = () =>
    Number(box.ownerDocument.timeline?.currentTime ?? performance.now());
  let start = 0;
  let frame = 0;
  type Loop = { animation: Animation; drift: boolean };
  let loops: Loop[] = [];

  const draw = (level: number) => {
    const look = noticeLook(level);
    for (const [name, value] of Object.entries(lookProperties(look)))
      box.style.setProperty(name, value);
    for (const { animation, drift } of loops)
      animation.playbackRate = drift ? look.drift : look.swirl;
  };

  const tick = () => {
    const t = now() - start;
    if (t >= NOTICE_MS) {
      draw(0);
      frame = 0;
      loops = [];
      return;
    }
    draw(noticeLevel(t));
    frame = requestAnimationFrame(tick);
  };

  const onClick = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const at = now();
    if (frame) {
      start = at - noticeAgain(at - start);
      return;
    }
    start = at;
    loops = (box.getAnimations?.({ subtree: true }) ?? []).flatMap(
      (animation): Loop[] => {
        const name = (animation as CSSAnimation).animationName;
        if (name === "rotate") return [{ animation, drift: false }];
        if (name === "agent-drift") return [{ animation, drift: true }];
        return [];
      },
    );
    frame = requestAnimationFrame(tick);
  };

  box.addEventListener("click", onClick);
  return () => {
    box.removeEventListener("click", onClick);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    draw(0);
    loops = [];
  };
}
