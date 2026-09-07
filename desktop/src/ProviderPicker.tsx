import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Mark } from "./Mark";

export type Login = "plan" | "api-key" | "endpoint";

export type Provider = {
  id: string;
  name: string;
  summary: string;
  logins: Login[];
  mark: string | null;
  caution: { says: string; reads_more_at: string } | null;
};

/** What the flow carries forward once this screen is done. */
export type ModelChoice = {
  provider: string;
  login: Login;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

/**
 * Connect a model.
 *
 * Two providers are first-class and everything else is one row, which is the shape rather than a
 * shortlist. See the build doc: growing this into a directory is how the screen stops being
 * finishable by somebody who has never opened a terminal.
 *
 * A PLAN IS THE DEFAULT WHEREVER ONE EXISTS, and the key sits beside it rather than behind it.
 * Anybody with a key and a base URL to hand is a developer; everybody else has a plan they already
 * pay for, and asking them for a key is asking them to go and get one.
 */
export function ProviderPicker({
  chosen,
  onChoose,
  onBack,
}: {
  chosen: ModelChoice | null;
  onChoose: (choice: ModelChoice) => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState<string | null>(chosen?.provider ?? null);
  const [login, setLogin] = useState<Login | null>(chosen?.login ?? null);
  const [apiKey, setApiKey] = useState(chosen?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(chosen?.baseUrl ?? "");
  const [model, setModel] = useState(chosen?.model ?? "");

  useEffect(() => {
    invoke<Provider[]>("providers")
      .then(setRows)
      .catch(() => undefined);
  }, []);

  const row = rows.find((r) => r.id === open) ?? null;

  // What "done" means differs by the way in, and each is checked before Continue lights up rather
  // than after a run fails with something unreadable.
  const ready =
    login === "plan" ||
    (login === "api-key" && apiKey.trim().length > 0) ||
    (login === "endpoint" &&
      baseUrl.trim().startsWith("http") &&
      apiKey.trim().length > 0 &&
      model.trim().length > 0);

  return (
    <>
      <h1>Connect a model</h1>
      <p className="lede">
        This is what your Bots think with. It is a separate choice from the Bot
        you picked, and any Bot works with any of these.
      </p>

      <fieldset className="picker providers">
        <legend className="sr-only">Model provider</legend>
        {rows.map((r) => (
          <label
            key={r.id}
            className={`tile wide${open === r.id ? " chosen" : ""}`}
          >
            <input
              type="radio"
              name="provider"
              className="tile-input"
              value={r.id}
              checked={open === r.id}
              onChange={() => {
                setOpen(r.id);
                // The first way in is the default, which is the plan wherever there is one.
                setLogin(r.logins[0] ?? null);
              }}
            />
            <Mark id={r.mark} name={r.name} />
            <span className="tile-name">{r.name}</span>
            <span className="tile-summary">{r.summary}</span>
          </label>
        ))}
      </fieldset>

      {row && (
        <div className="chosen-provider">
          {row.logins.length > 1 && (
            <div className="segmented" role="tablist">
              {row.logins.map((option) => (
                <button
                  type="button"
                  key={option}
                  role="tab"
                  aria-selected={login === option}
                  className={login === option ? "on" : ""}
                  onClick={() => setLogin(option)}
                >
                  {option === "plan"
                    ? "Sign in with my plan"
                    : "Use an API key"}
                </button>
              ))}
            </div>
          )}

          {login === "plan" && (
            <p className="lede">
              Opens {row.name} in your browser. Nothing is typed here and no key
              is stored.
            </p>
          )}

          {login === "api-key" && (
            <div className="field">
              <label htmlFor="key">{row.name} API key</label>
              <input
                id="key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}

          {login === "endpoint" && (
            <>
              <div className="field">
                <label htmlFor="base">Base URL</label>
                <input
                  id="base"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://…/v1"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label htmlFor="model">Model name</label>
                <input
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="the name the endpoint knows it by"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label htmlFor="ekey">API key</label>
                <input
                  id="ekey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {/* Said before it happens rather than diagnosed after the Bots stop answering. */}
          {row.caution && (
            <p className="caution">
              {row.caution.says}{" "}
              <a
                href={row.caution.reads_more_at}
                target="_blank"
                rel="noreferrer"
              >
                What this means
              </a>
            </p>
          )}
        </div>
      )}

      <div className="row">
        <button type="button" className="quiet" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          disabled={!row || !login || !ready}
          onClick={() =>
            row &&
            login &&
            onChoose({
              provider: row.id,
              login,
              apiKey: apiKey.trim() || undefined,
              baseUrl: baseUrl.trim() || undefined,
              model: model.trim() || undefined,
            })
          }
        >
          Continue
        </button>
      </div>
    </>
  );
}
