/**
 * What OpenBot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="sheet">
      <Mark />
      <h1>Your own AI coworkers, on this computer.</h1>
      <p className="lede big">
        They answer questions, use the tools you connect, and can work in a
        browser for you.
      </p>
      <div className="row">
        <button type="button" onClick={onStart}>
          Set up OpenBot
        </button>
      </div>
      <p className="footnote">
        Takes a few minutes. OpenBot installs what it needs and asks you to sign
        in to the AI plan you already have.
      </p>
    </div>
  );
}

/**
 * The product's own mark.
 *
 * Drawn rather than fetched, because this is the first paint of a window that has no network
 * guarantee yet, and it is two shapes: a filled square for the person and an outlined one beside it
 * for the coworker, overlapping. It is here so the first screen is recognisably a product rather
 * than a form.
 */
function Mark() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 34 34"
      fill="none"
      aria-hidden="true"
      style={{ marginBottom: "1.5rem" }}
    >
      <rect x="1" y="1" width="20" height="20" rx="6" fill="currentColor" />
      <rect
        x="13"
        y="13"
        width="20"
        height="20"
        rx="6"
        fill="var(--ground)"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
