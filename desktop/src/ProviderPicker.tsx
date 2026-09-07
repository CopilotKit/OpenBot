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
  /** Minted by signing in, never typed. Only a plan has one. */
  token?: string;
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
  /*
   * The sign-in, mid-flight.
   *
   * `url` present means the browser has been sent somewhere and a code is expected back. Kept here
   * rather than in the Rust side's head because the screen has to show the link: an open that
   * silently did nothing leaves somebody staring at a code box with no idea where the code comes
   * from.
   */
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [token, setToken] = useState(chosen?.token ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  async function beginSignIn() {
    setBusy(true);
    setFailure("");
    try {
      setSignInUrl(await invoke<string>("begin_claude_sign_in"));
    } catch (error) {
      setFailure(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function finishSignIn() {
    setBusy(true);
    setFailure("");
    try {
      // Held, not shown. It goes on to `start_stack` the same way a typed key does.
      setToken(await invoke<string>("finish_claude_sign_in", { code }));
      setSignInUrl(null);
      setCode("");
    } catch (error) {
      setFailure(String(error));
      // The flow is single-use, so a refused code means starting again rather than retyping.
      setSignInUrl(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    invoke<Provider[]>("providers")
      .then(setRows)
      .catch(() => undefined);
  }, []);

  const row = rows.find((r) => r.id === open) ?? null;

  // What "done" means differs by the way in, and each is checked before Continue lights up rather
  // than after a run fails with something unreadable.
  const ready =
    (login === "plan" && token.trim().length > 0) ||
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

          {login === "plan" &&
            (token ? (
              <p className="lede">
                Signed in to {row.name}. Your plan will be used, and no key is
                stored on this machine.
              </p>
            ) : signInUrl ? (
              <>
                <p className="lede">
                  Approve the request in your browser, then paste the code it
                  shows you.
                </p>
                {/* Shown as well as opened. On a machine with no registered
                    browser the open does nothing and says nothing, and a code
                    box with no link is then a dead end. */}
                <p className="fallback">
                  Didn't open?{" "}
                  <a href={signInUrl} target="_blank" rel="noreferrer">
                    Open the sign-in page
                  </a>
                </p>
                <div className="field">
                  <label htmlFor="code">Code from your browser</label>
                  <input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <button
                  type="button"
                  disabled={busy || code.trim().length === 0}
                  onClick={finishSignIn}
                >
                  {busy ? "Checking…" : "Finish signing in"}
                </button>
              </>
            ) : (
              <>
                <p className="lede">
                  Opens {row.name} in your browser. Nothing is typed here and no
                  key is stored.
                </p>
                <button type="button" disabled={busy} onClick={beginSignIn}>
                  {busy ? "Starting…" : `Sign in with ${row.name}`}
                </button>
              </>
            ))}

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
          {failure && (
            <p className="caution" role="alert">
              {failure}
            </p>
          )}

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
              token: token.trim() || undefined,
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
