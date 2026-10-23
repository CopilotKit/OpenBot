/** One part of setup, named for what it is about rather than counted. */
export type Section = "Account" | "Bot" | "Install" | "AI" | "Start";

/*
 * A local first run signs in to CopilotKit first; a hosted one picks its Bot first. Both then
 * install, connect an AI, and start. A section can hold several screens (Account is the sign-in and
 * then the agreement), which is why these are names and not "Step 1 of 4": a step that holds two
 * steps reads as a miscount.
 */
const LOCAL: Section[] = ["Account", "Install", "AI", "Start"];
const HOSTED: Section[] = ["Bot", "Install", "AI", "Start"];

/**
 * Where you are in setup, and what is left: every section by name, the current one marked.
 */
export function Sections({ local, at }: { local: boolean; at: Section }) {
  const names = local ? LOCAL : HOSTED;
  const current = names.indexOf(at);
  return (
    <ol className="steps-of sections" aria-label="Setup">
      {names.map((name, index) => (
        <li
          key={name}
          aria-current={index === current ? "step" : undefined}
          className={
            index === current ? "current" : index < current ? "done" : undefined
          }
        >
          {name}
        </li>
      ))}
    </ol>
  );
}
