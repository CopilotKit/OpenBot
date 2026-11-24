import type { CSSProperties, ReactNode } from "react";
import {
  AGENT_ORB_AT_REST,
  AGENT_ORB_COLORS,
  AGENT_ORB_CSS,
  AGENT_ORB_LOOP_SECONDS,
  agentOrbDriftSeconds,
  agentOrbSizing,
} from "../../shared/agent-orb";

/** One part of setup, named for what it is about rather than counted. */
export type Section = "Account" | "Install" | "AI" | "Start";

/*
 * Setup signs in, installs, connects an AI, and starts. A section can hold several
 * screens (Account is the sign-in and then the agreement), which is why these are names and not
 * "Step 1 of 4": a step that holds two steps reads as a miscount.
 */
const SECTIONS: Section[] = ["Account", "Install", "AI", "Start"];

/**
 * OpenBot's mark: the app's own orb (`AgentOrb`), drawn from the same stylesheet, palette and
 * size values in `shared/agent-orb`, at rest as the app draws it beside its name. Its mesh turns
 * and its sheen drifts with CSS alone, so this window needs no motion library; both hold still
 * under reduced motion. The stylesheet goes to the document's head once (React's `<style href>`),
 * so it is not text inside the lockup.
 */
function Orb({ size }: { size: number }) {
  const sizing = agentOrbSizing(size);
  const style = {
    "--animation-duration": `${AGENT_ORB_LOOP_SECONDS / AGENT_ORB_AT_REST.speed}s`,
    "--bg": AGENT_ORB_COLORS.bg,
    "--blur-amount": `${sizing.blur}px`,
    "--c1": AGENT_ORB_COLORS.c1,
    "--c2": AGENT_ORB_COLORS.c2,
    "--c3": AGENT_ORB_COLORS.c3,
    "--c4": AGENT_ORB_COLORS.c4,
    "--contrast-amount": sizing.contrast,
    "--dot-size": `${sizing.dotSize}px`,
    "--drift-duration": `${agentOrbDriftSeconds(AGENT_ORB_AT_REST.speed)}s`,
    "--mask-radius": sizing.maskRadius,
    "--rim": `${sizing.rim}px`,
    "--shadow-spread": `${sizing.shadowSpread}px`,
    filter: `saturate(${AGENT_ORB_AT_REST.saturation})`,
    width: "100%",
    height: "100%",
  } as CSSProperties;
  return (
    <div className="orb" style={{ width: size, height: size }}>
      <div className="agent-orb" style={style}>
        <span className="agent-orb-layer agent-orb-sheen" />
        <span className="agent-orb-layer agent-orb-rim" />
      </div>
      <style href="openbot-agent-orb" precedence="default">
        {AGENT_ORB_CSS}
      </style>
    </div>
  );
}

/**
 * OpenBot's mark and name, with "by CopilotKit" beside it where the company is named: it reads
 * OpenBot by CopilotKit, never CopilotKit alone. Decoration: the window's title already says the
 * name, so it is hidden from assistive technology rather than read on every screen.
 *
 * The mark is 32px at the top of the setup sidebar, and 22px in the smaller lockup a stopped setup
 * shows over its sign-in, as the app's sidebar header sets it.
 */
export function Lockup({
  byCopilotKit = false,
  size = 32,
}: {
  byCopilotKit?: boolean;
  /** The mark's size in px: 32, or the smaller lockup's 22. */
  size?: 32 | 22;
}) {
  return (
    <div className="lockup" aria-hidden="true">
      <Orb size={size} />
      <span>
        OpenBot
        <sup className="trademark" aria-hidden="true">
          ™
        </sup>
      </span>
      {byCopilotKit && <span className="lockup-by">by CopilotKit</span>}
    </div>
  );
}

/**
 * Where you are in setup, and what is left: every section by name, down the setup window's
 * sidebar, the current one marked as the app marks a selected row and the ones done ticked.
 */
export function Sections({ at }: { at: Section }) {
  const names = SECTIONS;
  const current = names.indexOf(at);
  return (
    <ol className="sections" aria-label="Setup">
      {names.map((name, index) => (
        <li
          key={name}
          aria-current={index === current ? "step" : undefined}
          className={
            index === current ? "current" : index < current ? "done" : undefined
          }
        >
          <span className="section-mark" aria-hidden="true" />
          {name}
        </li>
      ))}
    </ol>
  );
}

/**
 * The setup window's sidebar, beside every setup step, as OpenBot draws its own sidebar after
 * setup: OpenBot's mark and name, "Set up OpenBot", what the step lists (the sections, or on the
 * first screen the ways to run OpenBot), and at its foot whatever runs behind the step.
 *
 * The step itself is the inset page beside it (`main > .rail + .sheet`). What runs behind a step,
 * the background install, is said here and only here: in the step it was a second spinner beside
 * the step's own, and it moved what the person was about to click as it came and went.
 *
 * "Set up OpenBot" is the window's heading on the first screen, which has no other; a step that
 * has its own heading says it as a line, so each screen has one `h1`.
 */
export function SetupRail({
  heading = false,
  byCopilotKit = false,
  label = "Setup",
  children,
  foot,
}: {
  /** "Set up OpenBot" is this screen's heading. */
  heading?: boolean;
  /** "by CopilotKit" beside OpenBot's name, on the step that asks for a sign-in. */
  byCopilotKit?: boolean;
  label?: string;
  children?: ReactNode;
  /** At the sidebar's foot: what runs behind the step, or the way to another choice. */
  foot?: ReactNode;
}) {
  return (
    <aside className="rail" aria-label={label}>
      <Lockup byCopilotKit={byCopilotKit} />
      {heading ? (
        <h1 className="rail-title">Set up OpenBot</h1>
      ) : (
        <p className="rail-title">Set up OpenBot</p>
      )}
      {children}
      {foot && <div className="rail-foot">{foot}</div>}
    </aside>
  );
}
