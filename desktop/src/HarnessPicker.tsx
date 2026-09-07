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
};

/**
 * Pick a Bot.
 *
 * The list is data from the Rust catalogue, so this screen is a list and not twelve branches, and
 * adding a harness never comes back here.
 *
 * NO DEFAULT AND NO PRESELECTION. The person chooses. A preselected row is a choice made on their
 * behalf that they will not notice making, and the harness decides what their Bot is.
 */
export function HarnessPicker({
  chosen,
  onChoose,
  onContinue,
}: {
  chosen: string | null;
  onChoose: (id: string) => void;
  onContinue: () => void;
}) {
  const [rows, setRows] = useState<Harness[]>([]);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    invoke<Harness[]>("harnesses")
      .then(setRows)
      .catch((e) => setFailure(String(e)));
  }, []);

  if (failure) {
    return (
      <div className="blocker" role="alert">
        <h2>The list of Bots could not be read</h2>
        <p>{failure}</p>
      </div>
    );
  }

  return (
    <>
      <h1>Pick a Bot</h1>
      <p className="lede">
        This is the agent that does the work. You can change it later, and you
        can add more.
      </p>

      <fieldset className="picker">
        <legend className="sr-only">Bot</legend>
        {rows.map((row) => (
          <label
            key={row.id}
            className={`tile${chosen === row.id ? " chosen" : ""}`}
          >
            <input
              type="radio"
              name="harness"
              className="tile-input"
              value={row.id}
              checked={chosen === row.id}
              onChange={() => onChoose(row.id)}
            />
            <Mark id={row.mark} name={row.name} />
            {/* The name is on every row, mark or no mark. Somebody who does not recognise a logo
                can still read the row. */}
            <span className="tile-name">{row.name}</span>
            <span className="tile-summary">{row.summary}</span>
            {row.credential === "anthropic" && (
              <span className="tile-note">Needs no API key</span>
            )}
            {row.credential === "their-endpoint" && (
              <span className="tile-note">Nothing is installed</span>
            )}
          </label>
        ))}
      </fieldset>

      <div className="row">
        <button type="button" disabled={!chosen} onClick={onContinue}>
          Continue
        </button>
      </div>
    </>
  );
}
