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
 * Where you are in setup, and what is left: every section by name, the current one marked.
 *
 * Beside OpenBot's mark and name, so every step says which product is being set up, including the
 * step that signs in.
 */
export function Sections({
  at,
  byCopilotKit = false,
}: {
  at: Section;
  /** "by CopilotKit" beside OpenBot's name, on the step that asks for a sign-in. */
  byCopilotKit?: boolean;
}) {
  const names = SECTIONS;
  const current = names.indexOf(at);
  return (
    <div className="setup-header">
      <Lockup byCopilotKit={byCopilotKit} />
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
