import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";
import { asProblem, InlineFailure, type Problem } from "./Problem";

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
  /** A saved value exists and will be read only by the Start action. */
  saved?: boolean;
  baseUrl?: string;
  model?: string;
};

export type SavedConfiguration = {
  intelligenceApiKey?: boolean;
  modelApiKeys?: Partial<Record<"openai" | "anthropic", boolean>>;
  modelSessions?: Partial<Record<"openai" | "anthropic", boolean>>;
};

export type HeldConfiguration = {
  INTELLIGENCE_API_KEY?: string;
  INTELLIGENCE_API_URL?: string;
  INTELLIGENCE_GATEWAY_WS_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  saved?: SavedConfiguration;
};

function isHttpEndpointUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host.length > 0 &&
      // Some browser URL parsers preserve hostname spaces as percent escapes.
      !/\s/.test(decodeURIComponent(url.hostname))
    );
  } catch {
    return false;
  }
}

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
  held,
  onChoose,
  onBack,
}: {
  chosen: ModelChoice | null;
  /**
   * Credentials a previous run already wrote, by environment name.
   *
   * Used to fill the key field for whichever provider is chosen, so somebody who has set this up
   * before is not sent to find a key they already produced. Their own file, on their own machine.
   */
  held: HeldConfiguration;
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
  const [tokens, setTokens] = useState<Record<string, string>>(
    chosen?.provider && chosen.token ? { [chosen.provider]: chosen.token } : {},
  );
  const [busy, setBusy] = useState(false);
  /*
   * What the sign-in is doing, while it is doing it.
   *
   * A plan sign-in runs in a container, so on a first run it installs the engine and boots its
   * machine first, which is minutes. "Starting…" for that long is a hang as far as anybody
   * watching is concerned, so the same steps the setup screen lists are shown here as one line.
   */
  const [progress, setProgress] = useState<string | null>(null);
  // A problem, not a string: a sign-in failure carries the container's own output, and
  // stringifying it printed "[object Object]" where the diagnosis should have been.
  const [failure, setFailure] = useState<Problem | null>(null);
  const openRef = useRef(open);
  const signInRunRef = useRef(0);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  /*
   * The two plans sign in differently, and the screen has to know which.
   *
   * Anthropic's CLI wants a code typed back, so that half shows a field. ChatGPT's login finishes
   * itself when the browser redirect reaches its callback, so that half shows only a wait. Offering
   * a code box for a flow that never produces one is how a person concludes it is broken.
   */
  async function beginSignIn() {
    if (!row) return;
    const providerId = row.id;
    const run = signInRunRef.current + 1;
    signInRunRef.current = run;
    const stillCurrent = () =>
      signInRunRef.current === run && openRef.current === providerId;
    setBusy(true);
    setFailure(null);
    setProgress(null);
    try {
      const start =
        providerId === "anthropic"
          ? "begin_claude_sign_in"
          : "begin_chatgpt_sign_in";
      const nextSignInUrl = await invoke<string>(start);
      if (!stillCurrent()) return;
      setSignInUrl(nextSignInUrl);
      // ChatGPT needs no code, so the wait starts straight away.
      if (providerId !== "anthropic") {
        const nextToken = await invoke<string>("finish_chatgpt_sign_in");
        if (stillCurrent()) {
          setTokens((previous) => ({ ...previous, [providerId]: nextToken }));
          setSignInUrl(null);
        }
      }
    } catch (error) {
      if (stillCurrent()) {
        setFailure(asProblem(error));
        setSignInUrl(null);
      }
    } finally {
      if (stillCurrent()) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  async function finishSignIn() {
    if (!row) return;
    const providerId = row.id;
    const run = signInRunRef.current + 1;
    signInRunRef.current = run;
    const stillCurrent = () =>
      signInRunRef.current === run && openRef.current === providerId;
    setBusy(true);
    setFailure(null);
    try {
      // Held, not shown. It goes on to `start_stack` the same way a typed key does.
      const nextToken = await invoke<string>("finish_claude_sign_in", { code });
      if (stillCurrent()) {
        setTokens((previous) => ({ ...previous, [providerId]: nextToken }));
        setSignInUrl(null);
        setCode("");
      }
    } catch (error) {
      if (stillCurrent()) {
        setFailure(asProblem(error));
        // The flow is single-use, so a refused code means starting again rather than retyping.
        setSignInUrl(null);
      }
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }

  useEffect(() => {
    invoke<Provider[]>("providers")
      .then(setRows)
      .catch(() => undefined);
  }, []);

  // The same event the setup screen's step list is built from. Only the newest line is kept: this
  // is one sentence under a button, not a second copy of that list.
  useEffect(() => {
    const stop = listen<{ step: string; ok: boolean; detail: string }>(
      "setup:progress",
      (event) => setProgress(event.payload.detail),
    );
    return () => {
      stop.then((off) => off());
    };
  }, []);

  const row = rows.find((r) => r.id === open) ?? null;
  const token = row ? (tokens[row.id] ?? "") : "";
  const savedPlan =
    row?.id === "openai" || row?.id === "anthropic"
      ? held.saved?.modelSessions?.[row.id] === true
      : false;
  const savedApiKey =
    row?.id === "openai" || row?.id === "anthropic"
      ? held.saved?.modelApiKeys?.[row.id] === true
      : false;

  // What "done" means differs by the way in, and each is checked before Continue lights up rather
  // than after a run fails with something unreadable.
  const ready =
    (login === "plan" && (token.trim().length > 0 || savedPlan)) ||
    (login === "api-key" && (apiKey.trim().length > 0 || savedApiKey)) ||
    /*
     * An endpoint needs an address and a model name. NOT A KEY: this row's own summary names
     * Ollama and vLLM, and neither has one, so requiring a key refused the two examples the screen
     * offers. The Rust side already treats it as optional and writes `OPENAI_API_KEY` only when it
     * is given.
     */
    (login === "endpoint" &&
      isHttpEndpointUrl(baseUrl) &&
      model.trim().length > 0);

  function continueWithChoice() {
    if (!row || !login || !ready) return;
    const trimmedApiKey = apiKey.trim();
    const trimmedToken = token.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedModel = model.trim();
    onChoose({
      provider: row.id,
      login,
      ...((login === "api-key" || login === "endpoint") && trimmedApiKey
        ? { apiKey: trimmedApiKey }
        : {}),
      ...(login === "plan" && trimmedToken ? { token: trimmedToken } : {}),
      ...((login === "plan" && !trimmedToken && savedPlan) ||
      (login === "api-key" && !trimmedApiKey && savedApiKey)
        ? { saved: true }
        : {}),
      ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
      ...(trimmedModel ? { model: trimmedModel } : {}),
    });
  }

  return (
    <div className="sheet">
      <p className="steps-of">Step 2 of 2</p>
      <h1>Connect your AI</h1>
      <p className="lede">
        Sign in to the plan you already pay for. No key needed.
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
                signInRunRef.current += 1;
                setOpen(r.id);
                // A failure belongs to the row that produced it. Left in place, a refused OpenAI
                // sign-in stayed on screen under the endpoint row's fields, where it read as a
                // complaint about the address just typed.
                setFailure(null);
                setSignInUrl(null);
                setCode("");
                setBusy(false);
                setProgress(null);
                // The first way in is the default, which is the plan wherever there is one.
                setLogin(r.logins[0] ?? null);
                // Fill from what is already on this machine, if anything.
                const kept =
                  r.id === "openai"
                    ? held.OPENAI_API_KEY
                    : r.id === "anthropic"
                      ? held.ANTHROPIC_API_KEY
                      : undefined;
                setApiKey(kept ?? "");
                if (r.id === "openai-compatible" && held.OPENAI_BASE_URL) {
                  setBaseUrl(held.OPENAI_BASE_URL);
                }
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
            (token || savedPlan ? (
              <>
                <p className="lede">
                  Signed in to {row.name}. Your plan will be used, and no key is
                  stored on this machine.
                </p>
                {/*
                 * Said here because it changes an answer the person already gave.
                 *
                 * A subscription only works through the one Bot that speaks that vendor's
                 * sign-in, so choosing a plan re-points the Bot. Doing that silently would leave
                 * somebody looking at a Bot they did not choose with no idea why; see
                 * `harness::speaking_for` for the failure that came of not saying it at all.
                 */}
                <p className="footnote">
                  Your Bot will be{" "}
                  {row.id === "anthropic" ? "Claude Agent SDK" : "LangGraph"},
                  which is the one that can use this plan.
                </p>
              </>
            ) : signInUrl ? (
              <>
                <p className="lede">
                  {row.id === "anthropic"
                    ? "Approve the request in your browser, then paste the code it shows you."
                    : `Approve the request in your browser. ${row.name} will finish this on its own.`}
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
                {row.id === "anthropic" ? (
                  <>
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
                  <p className="footnote" style={{ margin: 0 }}>
                    Waiting for you to approve it…
                  </p>
                )}
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
                {busy && progress && (
                  <p className="footnote" style={{ marginBottom: 0 }}>
                    {progress}
                  </p>
                )}
              </>
            ))}

          {login === "api-key" && (
            <>
              {savedApiKey && !apiKey ? (
                <p className="lede">A saved {row.name} API key will be used.</p>
              ) : null}
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
            </>
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
                <label htmlFor="ekey">API key, if the endpoint needs one</label>
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
          {failure && <InlineFailure problem={failure} />}

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
          onClick={continueWithChoice}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
