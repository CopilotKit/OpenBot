/** One part of setup, named for what it is about rather than counted. */
export type Section = "Account" | "Install" | "AI" | "Start";

/*
 * Setup signs in to CopilotKit, installs, connects an AI, and starts. A section can hold several
 * screens (Account is the sign-in and then the agreement), which is why these are names and not
 * "Step 1 of 4": a step that holds two steps reads as a miscount.
 */
const SECTIONS: Section[] = ["Account", "Install", "AI", "Start"];

/**
 * Where you are in setup, and what is left: every section by name, the current one marked.
 *
 * Beside OpenBot's mark and name, so every step says which product is being set up, including the
 * step that signs in to a CopilotKit account. The name is decoration here: the window's title
 * already says it, so it is hidden from assistive technology rather than read on every screen.
 */
export function Sections({ at }: { at: Section }) {
  const names = SECTIONS;
  const current = names.indexOf(at);
  return (
    <div className="setup-header">
      <div className="lockup" aria-hidden="true">
        <div className="orb" />
        <span>OpenBot</span>
      </div>
      <ol className="steps-of sections" aria-label="Setup">
        {names.map((name, index) => (
          <li
            key={name}
            aria-current={index === current ? "step" : undefined}
            className={
              index === current
                ? "current"
                : index < current
                  ? "done"
                  : undefined
            }
          >
            {name}
          </li>
        ))}
      </ol>
    </div>
  );
}
