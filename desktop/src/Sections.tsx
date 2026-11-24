import type { ReactNode } from "react";

/** One part of setup, named for what it is about rather than counted. */
export type Section = "Account" | "Install" | "AI" | "Start";

/*
 * Setup signs in, installs, connects an AI, and starts. A section can hold several
 * screens (Account is the sign-in and then the agreement), which is why these are names and not
 * "Step 1 of 4": a step that holds two steps reads as a miscount.
 */
const SECTIONS: Section[] = ["Account", "Install", "AI", "Start"];

/**
 * OpenBot's mark and name, with "by CopilotKit" beside it where the company is named: it reads
 * OpenBot by CopilotKit, never CopilotKit alone. Decoration: the window's title already says the
 * name, so it is hidden from assistive technology rather than read on every screen.
 */
export function Lockup({ byCopilotKit = false }: { byCopilotKit?: boolean }) {
  return (
    <div className="lockup" aria-hidden="true">
      <div className="orb" />
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
 * Without `at`, none is marked: setup is still finding out where it is (Getting OpenBot ready).
 */
export function Sections({ at }: { at?: Section }) {
  const names = SECTIONS;
  const current = at === undefined ? -1 : names.indexOf(at);
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
 * Whether the window's buttons sit over the page, as macOS draws them (`TRAFFIC_LIGHTS`). Windows
 * and Linux draw a title bar above the page instead, so the sidebar needs no room for them.
 */
function underLights(
  userAgent = globalThis.navigator?.userAgent ?? "",
): boolean {
  return /Macintosh|Mac OS X/.test(userAgent);
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
    <aside
      className={underLights() ? "rail" : "rail under-title-bar"}
      aria-label={label}
    >
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
