import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Mark } from "./Mark";

export type Harness = {
  id: string;
  name: string;
  summary: string;
  image: string | null;
  health_path: string | null;
  credential: "any-provider" | "anthropic" | "their-endpoint";
  maintainer: "first-party" | "partnership" | "community";
  mark: string | null;
  port: number | null;
};

/** What OpenBot sets up unless somebody says otherwise. David's call. */
export const DEFAULT_HARNESS = "langgraph";

/**
 * Which Bot, answered for them.
 *
 * ONE CHOICE IS MADE FOR THE PERSON, and that is the point of this screen rather than a limitation
 * of it. The twelve rows are agent frameworks, and to anybody who is not a developer the difference
 * between them is nil: they all take any model and they all answer the same questions. Asking a
 * non-technical person to pick one is asking them to make a decision they cannot inform, at the
 * start, which is where people leave.
 *
 * So the default is stated in one line and the list moves behind a disclosure. A developer who
 * wants CrewAI opens it and picks CrewAI; everybody else presses Continue and never learns the word
 * "harness". The address-your-own row lives in there too, because pasting a URL is the most
 * developer thing on this screen.
 */
export function HarnessPicker({
  chosen,
  onChoose,
  onContinue,
  onBack,
}: {
  chosen: string | null;
  onChoose: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<Harness[]>([]);
  const [failure, setFailure] = useState("");
  // Open when the person has already chosen something other than the default, so coming back does
  // not hide the choice they made.
  const [open, setOpen] = useState(
    chosen !== null && chosen !== DEFAULT_HARNESS,
  );

  useEffect(() => {
    invoke<Harness[]>("harnesses")
      .then(setRows)
      .catch((error) => setFailure(String(error)));
  }, []);

  const picked = rows.find((row) => row.id === (chosen ?? DEFAULT_HARNESS));

  if (failure) {
    return (
      <div className="sheet">
        <div className="blocker" role="alert">
          <h2>The list of Bots could not be read</h2>
          <p>{failure}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet">
      <p className="steps-of">Step 1 of 2</p>
      <h1>Your first Bot</h1>
      {/*
        Written to the person who has to act, not about the situation.
        
        An earlier version said the default "makes no difference unless you write code", which
        describes a state and leaves a non-technical reader wondering what they were told. This
        gives them the one thing to do — nothing — and puts the conditional where the only person it
        applies to will read it.
      */}
      <p className="lede">
        OpenBot sets this up for you. If you write code, you can choose the
        agent framework below.
      </p>

      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          {picked && picked.id !== DEFAULT_HARNESS
            ? `Using ${picked.name}`
            : "Choose the agent framework"}
        </summary>
        <p className="footnote" style={{ margin: "0.6rem 0 0" }}>
          Any of these works with any AI provider. Only the last one asks you
          for an address.
        </p>
        <fieldset className="picker">
          <legend className="sr-only">Bot</legend>
          {rows.map((row) => (
            <label
              key={row.id}
              className={`tile${(chosen ?? DEFAULT_HARNESS) === row.id ? " chosen" : ""}`}
            >
              <input
                type="radio"
                name="harness"
                className="tile-input"
                value={row.id}
                checked={(chosen ?? DEFAULT_HARNESS) === row.id}
                onChange={() => onChoose(row.id)}
              />
              <Mark id={row.mark} name={row.name} />
              {/* The name is on every row, mark or no mark, so a person who does not recognise a
                  logo can still read it. */}
              <span className="tile-name">{row.name}</span>
              <span className="tile-summary">{row.summary}</span>
              {row.credential === "anthropic" && (
                <span className="tile-note">No API key needed</span>
              )}
              {row.credential === "their-endpoint" && (
                <span className="tile-note">Nothing is installed</span>
              )}
            </label>
          ))}
        </fieldset>
      </details>

      <div className="row">
        <button type="button" className="quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
