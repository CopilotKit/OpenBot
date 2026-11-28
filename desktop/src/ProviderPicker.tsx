import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { EndpointMark } from "./EndpointMark";
import { ExternalLink } from "./ExternalLink";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { ButtonMark, Mark } from "./Mark";
import { asProblem, InlineFailure, type Problem } from "./Problem";
import { Sections, SetupRail } from "./Sections";
import { type Progress, SetupProgress, StatusLine } from "./SetupProgress";

export type Login = "plan" | "api-key" | "endpoint" | "oauth";

/** How long "✓ Signed in" shows before the screen moves on by itself. */
export const CONFIRMED_FOR_MS = 1000;

export type Provider = {
  id: string;
  name: string;
  summary: string;
  logins: Login[];
  mark: string | null;
  caution: { says: string; reads_more_at: string } | null;
};

/** What the flow carries forward once this screen is done. */
/** The sentence `preparation::require` refuses a sign-in or start with when Install must run again. */
export const INSTALL_REQUIRED =
  "Finish installing OpenBot's local software before signing in or starting. Return to Install and try again.";

export type ModelChoice = {
  provider: string;
  login: Login;
  apiKey?: string;
  /** Minted by signing in, never typed. Only a plan has one. */
  token?: string;
  /** Explicit intent to try a saved value; only Start checks whether it is available. */
  saved?: boolean;
  baseUrl?: string;
  containerBaseUrl?: string;
  model?: string;
};

export type SavedConfiguration = {
  model?:
    | "open-ai-api-key"
    | "anthropic-api-key"
    | "claude-plan"
    | "chat-gpt-plan"
    | "compatible-endpoint"
    | "google-oauth"
    | "xai-oauth"
    | null;
  intelligenceApiKey?: boolean | null;
  modelApiKeys?: Partial<
    Record<"openai" | "anthropic" | "compatible", boolean | null>
  >;
  /** A ChatGPT sign-in an earlier version saved, which has to be done again. */
  chatgptSignInChanged?: boolean;
  modelSessions?: Partial<
    Record<"openai" | "anthropic" | "google" | "xai", boolean | null>
  >;
};

export type HeldConfiguration = {
  INTELLIGENCE_API_KEY?: string;
  INTELLIGENCE_API_URL?: string;
  INTELLIGENCE_GATEWAY_WS_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_CONTAINER_BASE_URL?: string;
  BOT_MODEL?: string;
  saved?: SavedConfiguration;
};

const endpointPresets: Record<
  string,
  // `keyLink` is written out whole: the article goes by how the name sounds ("an xAI"), not by
  // its first letter.
  { baseUrl: string; model: string; keyUrl: string; keyLink: string }
> = {
  // https://ai.google.dev/gemini-api/docs/openai
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    keyLink: "Get a Google Gemini API key",
  },
  // https://docs.x.ai/developers/model-capabilities/legacy/chat-completions
  xai: {
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    keyUrl: "https://console.x.ai/",
    keyLink: "Get an xAI API key",
  },
  trustedrouter: {
    baseUrl: "https://api.trustedrouter.com/v1",
    model: "anthropic/claude-sonnet-5.5",
    keyUrl: "https://trustedrouter.com/console/api-keys",
    keyLink: "Get a TrustedRouter API key",
  },
  // Privatemode's hosted, OpenAI-compatible address and recommended default model.
  // https://docs.privatemode.ai/api/proxyless-api/
  privatemode: {
    baseUrl: "https://proxyless-api.privatemode.ai/v1",
    model: "glm-latest",
    keyUrl: "https://portal.privatemode.ai",
    keyLink: "Get a Privatemode API key",
  },
};

/** What approving in the browser does, for each provider that signs in that way. */
const oauthExplanation: Record<string, string> = {
  xai: "Authorize OpenBot to use models available to your xAI account.",
};

/** Stop a plan's sign-in still waiting for the browser: Claude's, or ChatGPT's. */
function cancelPlanSignIn(provider: string) {
  const claude = provider === "anthropic";
  invoke(claude ? "cancel_claude_sign_in" : "cancel_chatgpt_sign_in").catch(
    () => {
      console.error(
        `OpenBot could not stop the ${claude ? "Claude" : "ChatGPT"} sign-in.`,
      );
    },
  );
}

function endpointIdentity(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl.trim()).href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function endpointProvider(baseUrl: string | undefined): string {
  return (
    Object.entries(endpointPresets).find(
      ([, preset]) =>
        endpointIdentity(preset.baseUrl) === endpointIdentity(baseUrl),
    )?.[0] ?? "openai-compatible"
  );
}

export function recordedModel(held: HeldConfiguration): ModelChoice | null {
  switch (held.saved?.model) {
    case "open-ai-api-key":
      return { provider: "openai", login: "api-key", saved: true };
    case "anthropic-api-key":
      return { provider: "anthropic", login: "api-key", saved: true };
    case "claude-plan":
      return { provider: "anthropic", login: "plan", saved: true };
    case "chat-gpt-plan":
      return {
        provider: "openai",
        login: "plan",
        saved: held.saved.chatgptSignInChanged !== true,
      };
    case "xai-oauth":
      return {
        provider: "xai",
        login: "oauth",
        saved: true,
        model: held.BOT_MODEL,
      };
    // A Google sign-in saved before Gemini took an API key only: nothing to resume. The screen
    // says so and asks for a key instead (`googleSignInEnded`).
    case "google-oauth":
      return null;
    case "compatible-endpoint":
      return {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl: held.OPENAI_BASE_URL,
        containerBaseUrl: held.OPENAI_CONTAINER_BASE_URL,
        model: held.BOT_MODEL,
        saved: held.saved.modelApiKeys?.compatible === true,
      };
    default:
      return null;
  }
}

/**
 * Connect a model.
 *
 * Plans remain the default wherever supported. Google and xAI use the same endpoint credential
 * route as custom models, while their named rows supply the address for the user.
 */
export function ProviderPicker({
  chosen,
  held,
  root,
  onChoose,
  onInstallRequired,
  onBack,
  returning = false,
  busy: starting = false,
  status,
  background,
  failure: setupFailure,
  onProviderChange,
}: {
  chosen: ModelChoice | null;
  /**
   * Credentials a previous run already wrote, by environment name.
   *
   * Used to fill the key field for whichever provider is chosen, so somebody who has set this up
   * before is not sent to find a key they already produced. Their own file, on their own machine.
   */
  held: HeldConfiguration;
  root: string;
  onChoose: (choice: ModelChoice) => void;
  /**
   * A plan sign-in was refused because the installation no longer matches. The window goes back
   * to Install, and the choice made here comes back with the person afterwards.
   */
  onInstallRequired?: (problem: Problem, choice: ModelChoice) => void;
  /** Without it there is no Back, as while local Intelligence sets up behind this screen. */
  onBack?: () => void;
  returning?: boolean;
  busy?: boolean;
  /** One line about work running behind this screen. */
  status?: ReactNode;
  /** What runs behind this step, at the sidebar's foot: the background install. */
  background?: ReactNode;
  /** A failure from setup itself (a Start that sent the window back here), shown in this card. */
  failure?: ReactNode;
  /**
   * The person chose another provider, or went back to the list. Any failure from setup belongs to
   * the provider tried before, so the caller drops it, as this screen drops its own.
   */
  onProviderChange?: () => void;
}) {
  const initialChoice = chosen ?? recordedModel(held);
  /*
   * The connection saved last is a Google sign-in, which Gemini no longer takes: the screen says so
   * above the list, with one button that opens Google Gemini's API key.
   */
  const googleSignInEnded =
    chosen === null && held.saved?.model === "google-oauth";
  const [reuse, setReuse] = useState(
    initialChoice?.saved
      ? { provider: initialChoice.provider, login: initialChoice.login }
      : null,
  );
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState<string | null>(
    initialChoice?.provider === "openai-compatible"
      ? endpointProvider(initialChoice.baseUrl)
      : (initialChoice?.provider ?? null),
  );
  const [login, setLogin] = useState<Login | null>(
    initialChoice?.login ?? null,
  );
  const [apiKey, setApiKey] = useState(initialChoice?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(initialChoice?.baseUrl ?? "");
  const [containerBaseUrl, setContainerBaseUrl] = useState(
    initialChoice?.containerBaseUrl ?? "",
  );
  const [model, setModel] = useState(initialChoice?.model ?? "");
  const [reuseEndpointKey, setReuseEndpointKey] = useState(
    initialChoice?.provider === "openai-compatible" &&
      initialChoice.saved === true,
  );
  /*
   * The sign-in, mid-flight.
   *
   * `url` present means the browser has been sent somewhere and the sign-in waits for it to come
   * back. Kept here rather than in the Rust side's head because the screen has to show the link: an
   * open that silently did nothing leaves somebody waiting with no idea where to approve.
   */
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>(
    initialChoice?.provider && initialChoice.token
      ? { [initialChoice.provider]: initialChoice.token }
      : {},
  );
  const [busy, setBusy] = useState(false);
  /*
   * What the sign-in is doing, while it is doing it.
   *
   * Local software is already installed before this screen. A plan sign-in starts its prepared
   * container, and progress explains what is happening while its browser session opens.
   */
  const [progress, setProgress] = useState<string | null>(null);
  /*
   * The download a plan sign-in starts with, while it runs: its image, which Install downloads only
   * for an installation already on that plan. Shown as Install shows a download.
   */
  const [download, setDownload] = useState<Progress | null>(null);
  // A problem, not a string: a sign-in failure carries the container's own output, and
  // stringifying it printed "[object Object]" where the diagnosis should have been.
  const [failure, setFailure] = useState<Problem | null>(null);
  const providerPickerRef = useRef<HTMLFieldSetElement>(null);
  const setupBodyRef = useRef<HTMLDivElement>(null);
  const restoreProviderFocus = useRef<string | null>(null);
  useEffect(() => {
    // A new authentication form starts at its beginning, regardless of catalogue scroll.
    if (open !== null && setupBodyRef.current)
      setupBodyRef.current.scrollTop = 0;
    if (!restoreProviderFocus.current) return;
    const provider = open ?? restoreProviderFocus.current;
    restoreProviderFocus.current = null;
    // The fieldset remounts when moving between the catalogue and anchored selection.
    // Returning clears the selection, so find the previous provider by value, not :checked.
    const input = Array.from(
      providerPickerRef.current?.querySelectorAll<HTMLInputElement>(
        'input[name="provider"]',
      ) ?? [],
    ).find((input) => input.value === provider);
    input?.focus({ preventScroll: open !== null });
    // The hidden radio is only one pixel tall; reveal its whole visible label as well.
    if (open === null)
      input?.closest(".tile")?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const openRef = useRef(open);
  const signInRunRef = useRef(0);
  // A sign-in that just finished on this screen moves on by itself once the screen is ready.
  const continueAfterSignIn = useRef(false);
  const oauthAttempt = useRef<string | null>(null);
  /*
   * The plan sign-in still waiting for the browser, if any: its run and which plan.
   *
   * Leaving it stops it. Left running, its tab could still finish: the browser said "You're signed
   * in" while this screen had moved on and dropped the result.
   */
  const planRun = useRef<{ run: number; provider: string } | null>(null);
  const [oauthCode, setOauthCode] = useState<string | null>(null);
  const [oauthSignedIn, setOauthSignedIn] = useState<string | null>(
    initialChoice?.login === "oauth" && initialChoice.saved
      ? initialChoice.provider
      : null,
  );

  function stopPlanSignIn() {
    const waiting = planRun.current;
    if (waiting === null) return;
    planRun.current = null;
    cancelPlanSignIn(waiting.provider);
  }

  async function cancelOAuth() {
    signInRunRef.current += 1;
    const attemptId = oauthAttempt.current;
    oauthAttempt.current = null;
    setBusy(false);
    setSignInUrl(null);
    setOauthCode(null);
    if (attemptId) {
      try {
        await invoke("cancel_model_oauth", { attemptId });
      } catch (error) {
        setFailure(asProblem(error));
      }
    }
  }

  async function beginOAuth() {
    if (!row) return;
    const providerId = row.id;
    const run = ++signInRunRef.current;
    const current = () =>
      signInRunRef.current === run && openRef.current === providerId;
    setBusy(true);
    setFailure(null);
    setOauthSignedIn(null);
    try {
      const authorization = await invoke<{
        attemptId: string;
        url: string;
        userCode: string | null;
      }>("begin_model_oauth", { root: root.trim(), provider: providerId });
      if (!current()) {
        await invoke("cancel_model_oauth", {
          attemptId: authorization.attemptId,
        });
        return;
      }
      oauthAttempt.current = authorization.attemptId;
      setSignInUrl(authorization.url);
      setOauthCode(authorization.userCode);
      try {
        await invoke("plugin:opener|open_url", { url: authorization.url });
      } catch (error) {
        if (current()) setFailure(asProblem(error));
      }
      await invoke<void>("finish_model_oauth", {
        attemptId: authorization.attemptId,
      });
      if (current()) {
        continueAfterSignIn.current = true;
        setOauthSignedIn(providerId);
        setSignInUrl(null);
        setOauthCode(null);
        setFailure(null);
      }
    } catch (error) {
      if (current()) {
        setFailure(asProblem(error));
        setSignInUrl(null);
        setOauthCode(null);
      }
    } finally {
      if (current()) {
        oauthAttempt.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(
    () => () => {
      signInRunRef.current += 1;
      const waiting = planRun.current;
      if (waiting !== null) {
        planRun.current = null;
        cancelPlanSignIn(waiting.provider);
      }
      const attemptId = oauthAttempt.current;
      if (attemptId) {
        invoke("cancel_model_oauth", { attemptId }).catch(() => {
          console.error(
            "OpenBot could not cancel the pending provider sign-in.",
          );
        });
      }
    },
    [],
  );

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  /*
   * Both plans finish on their own: the browser comes back to this computer once the person
   * approves, Claude's to Desktop's own listener and ChatGPT's to its login's. So the screen shows
   * only a wait, with the link in case the browser didn't open. Nothing is typed here.
   */
  async function beginSignIn() {
    if (!row) return;
    const providerId = row.id;
    const run = signInRunRef.current + 1;
    signInRunRef.current = run;
    const stillCurrent = () =>
      signInRunRef.current === run && openRef.current === providerId;
    setReuse(null);
    setBusy(true);
    setFailure(null);
    setProgress(null);
    setDownload(null);
    try {
      const claude = providerId === "anthropic";
      planRun.current = { run, provider: providerId };
      const nextSignInUrl = await invoke<string>(
        claude ? "begin_claude_sign_in" : "begin_chatgpt_sign_in",
        { root: root.trim() },
      );
      if (!stillCurrent()) return;
      setSignInUrl(nextSignInUrl);
      // Held, not shown. It goes on to `start_stack` the same way a typed key does.
      const nextToken = await invoke<string>(
        claude ? "finish_claude_sign_in" : "finish_chatgpt_sign_in",
      );
      if (stillCurrent()) {
        continueAfterSignIn.current = true;
        setTokens((previous) => ({ ...previous, [providerId]: nextToken }));
        setSignInUrl(null);
      }
    } catch (error) {
      if (stillCurrent()) {
        const problem = asProblem(error);
        if (onInstallRequired && problem.said === INSTALL_REQUIRED) {
          onInstallRequired(problem, { provider: providerId, login: "plan" });
          return;
        }
        setFailure(problem);
        setSignInUrl(null);
      }
    } finally {
      if (planRun.current?.run === run) planRun.current = null;
      if (stillCurrent()) {
        setBusy(false);
        setProgress(null);
        setDownload(null);
      }
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
    const stop = listen<Progress>("setup:progress", (event) => {
      const row = event.payload;
      setProgress(row.detail);
      setDownload(
        row.step === "images" && row.running && row.downloads ? row : null,
      );
    });
    return () => {
      stop.then((off) => off());
    };
  }, []);

  const row = rows.find((r) => r.id === open) ?? null;
  const googleRow = rows.find((r) => r.id === "google");
  const preset = row ? endpointPresets[row.id] : undefined;
  const token = row ? (tokens[row.id] ?? "") : "";
  const savedPlan =
    row?.id === "openai" || row?.id === "anthropic"
      ? held.saved?.modelSessions?.[row.id] === true ||
        (reuse?.provider === row.id && reuse.login === "plan")
      : false;
  const savedApiKey =
    row?.id === "openai" || row?.id === "anthropic"
      ? held.saved?.modelApiKeys?.[row.id] === true ||
        (reuse?.provider === row.id && reuse.login === "api-key")
      : false;
  const savedEndpointKey =
    login === "endpoint" &&
    reuseEndpointKey &&
    held.saved?.modelApiKeys?.compatible === true &&
    baseUrl.trim() === held.OPENAI_BASE_URL?.trim();
  const containerBaseUrlIsValid =
    containerBaseUrl.trim().length === 0 || isHttpEndpointUrl(containerBaseUrl);

  // What "done" means differs by the way in, and each is checked before Continue lights up rather
  // than after a run fails with something unreadable.
  const ready =
    (login === "oauth" &&
      oauthSignedIn === row?.id &&
      model.trim().length > 0) ||
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
      containerBaseUrlIsValid &&
      model.trim().length > 0 &&
      (!preset || apiKey.trim().length > 0 || savedEndpointKey));

  function continueWithChoice() {
    if (!row || !login || !ready) return;
    const trimmedApiKey = apiKey.trim();
    const trimmedToken = token.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedModel = model.trim();
    const trimmedContainerBaseUrl = containerBaseUrl.trim();
    onChoose({
      provider: login === "endpoint" ? "openai-compatible" : row.id,
      login,
      ...((login === "api-key" || login === "endpoint") && trimmedApiKey
        ? { apiKey: trimmedApiKey }
        : {}),
      ...(login === "plan" && trimmedToken ? { token: trimmedToken } : {}),
      ...(login === "oauth" ? { saved: true } : {}),
      ...((login === "plan" && !trimmedToken && savedPlan) ||
      (login === "api-key" && !trimmedApiKey && savedApiKey) ||
      (login === "endpoint" && !trimmedApiKey && savedEndpointKey)
        ? { saved: true }
        : {}),
      ...(login !== "oauth" && trimmedBaseUrl
        ? { baseUrl: trimmedBaseUrl }
        : {}),
      ...(login !== "oauth" && trimmedContainerBaseUrl
        ? { containerBaseUrl: trimmedContainerBaseUrl }
        : {}),
      ...(trimmedModel ? { model: trimmedModel } : {}),
    });
  }
  /*
   * Signed in, so on to the next step: the sign-in was the thing this screen was waiting for, and
   * a Continue after "Signed in" is a click that only confirms what just happened. A sign-in that
   * leaves something else to fill in (an OAuth row's model) waits for Continue as before.
   *
   * Not at once, though: a tick beside "Signed in" for a second first, so the screen says it worked
   * before it changes. Choosing another row in that second cancels the move.
   */
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const continueLatest = useRef(continueWithChoice);
  continueLatest.current = continueWithChoice;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when readiness or a sign-in changes.
  useEffect(() => {
    if (!continueAfterSignIn.current || busy) return;
    // Used up on the first look after the sign-in either way, so a field filled in later never
    // moves the screen on from under somebody still typing.
    continueAfterSignIn.current = false;
    if (ready && !starting && row) setConfirmed(row.id);
  }, [ready, busy, starting, tokens, oauthSignedIn]);
  useEffect(() => {
    if (!confirmed) return;
    if (confirmed !== open) {
      setConfirmed(null);
      return;
    }
    const timer = setTimeout(() => {
      setConfirmed(null);
      continueLatest.current();
    }, CONFIRMED_FOR_MS);
    return () => clearTimeout(timer);
  }, [confirmed, open]);

  /** Back to every provider: the chosen one's sign-in, if any, stops. */
  function chooseAnother() {
    restoreProviderFocus.current = open;
    if (oauthAttempt.current) void cancelOAuth();
    stopPlanSignIn();
    signInRunRef.current += 1;
    setOpen(null);
    setFailure(null);
    onProviderChange?.();
    setSignInUrl(null);
    setBusy(false);
    setProgress(null);
    setDownload(null);
    setLogin(null);
  }
  const chooseAnotherLatest = useRef(chooseAnother);
  chooseAnotherLatest.current = chooseAnother;
  // Escape goes back too, except while typing, where it would throw away a half-typed key.
  const anyChosen = row !== null;
  useEffect(() => {
    if (!anyChosen) return;
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement;
      if (event.key === "Escape" && !typing) chooseAnotherLatest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyChosen]);

  /** Open one provider's row, as choosing it in the list does. `focused`: its radio had focus. */
  function openRow(r: Provider, focused = false) {
    // Selecting a row moves its fieldset outside the scrolling catalogue. Keep the
    // focused radio focused when React mounts it in that anchored position.
    restoreProviderFocus.current = focused ? r.id : null;
    if (oauthAttempt.current) void cancelOAuth();
    stopPlanSignIn();
    signInRunRef.current += 1;
    setOpen(r.id);
    // A failure belongs to the row that produced it. Left in place, a refused OpenAI
    // sign-in stayed on screen under the endpoint row's fields, where it read as a
    // complaint about the address just typed. The same goes for a failure setup sent
    // back here: a refused OpenAI key stayed under the Anthropic row.
    setFailure(null);
    onProviderChange?.();
    setSignInUrl(null);
    setBusy(false);
    setProgress(null);
    setDownload(null);
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
    const nextPreset = endpointPresets[r.id];
    const restoreEndpoint =
      r.id === "openai-compatible" ||
      (nextPreset && endpointProvider(held.OPENAI_BASE_URL) === r.id);
    setReuseEndpointKey(
      Boolean(restoreEndpoint) && held.saved?.modelApiKeys?.compatible === true,
    );
    if (restoreEndpoint && held.OPENAI_BASE_URL) {
      setBaseUrl(held.OPENAI_BASE_URL);
      setContainerBaseUrl(held.OPENAI_CONTAINER_BASE_URL ?? "");
      setModel(held.BOT_MODEL ?? nextPreset?.model ?? "");
    } else {
      setBaseUrl(nextPreset?.baseUrl ?? "");
      setContainerBaseUrl("");
      setModel(nextPreset?.model ?? "");
    }
  }

  const providerPicker = (
    <fieldset ref={providerPickerRef} className="picker providers">
      <legend className="sr-only">Model provider</legend>
      {/* Once one is chosen it stands alone, with Change to see them all again. */}
      {(row ? [row] : rows).map((r) => (
        <label
          key={r.id}
          className={`tile wide${open === r.id ? " chosen" : ""}${row ? " beside-change" : ""}`}
        >
          <input
            type="radio"
            name="provider"
            className="tile-input"
            value={r.id}
            checked={open === r.id}
            onChange={(event) =>
              openRow(r, document.activeElement === event.currentTarget)
            }
          />
          {r.id === "openai-compatible" ? (
            <EndpointMark />
          ) : (
            <Mark id={r.mark} name={r.name} />
          )}
          <span className="tile-name">{r.name}</span>
          <span className="tile-summary">{r.summary}</span>
        </label>
      ))}
      {row && (
        <button
          type="button"
          className="text-link change-provider"
          aria-label="Choose a different provider"
          onClick={chooseAnother}
        >
          Change
        </button>
      )}
    </fieldset>
  );

  return (
    <>
      {/* What runs behind this step is said at the sidebar's foot (`background`), not under the
          form: nothing in the step moves as it comes and goes, and it never spins beside it. */}
      <SetupRail foot={background}>
        {!returning && <Sections at="AI" />}
      </SetupRail>
      <div className="sheet setup-layout page-first provider-layout">
        <div className="setup-header-block">
          <h1>
            {returning ? "Refresh your AI connection" : "Connect your AI"}
          </h1>
          <p className="lede">
            Choose the AI your Bots use. Sign in with a plan you already have,
            or use an API key.
          </p>
        </div>

        {row && <div className="setup-provider-identity">{providerPicker}</div>}

        <div ref={setupBodyRef} className="setup-body">
          {googleSignInEnded && !row && (
            <div className="blocker google-sign-in-ended" role="alert">
              <h2>Google sign-in for Gemini has ended</h2>
              <p>Add a Gemini API key to keep your Bots running on Gemini.</p>
              <div className="row">
                <button
                  type="button"
                  disabled={!googleRow}
                  onClick={() => googleRow && openRow(googleRow)}
                >
                  Add a Gemini API key
                </button>
              </div>
            </div>
          )}
          {!row && providerPicker}

          {row && (
            <div className="setup-content setup-panel chosen-provider">
              {row.logins.length > 1 && (
                <div className="segmented" role="tablist">
                  {row.logins.map((option) => (
                    <button
                      type="button"
                      key={option}
                      role="tab"
                      aria-selected={login === option}
                      className={login === option ? "on" : ""}
                      onClick={() => {
                        if (login === "oauth" && option !== login)
                          void cancelOAuth();
                        // A refused sign-in says nothing about the API key tab, and the reverse.
                        if (option !== login) setFailure(null);
                        setLogin(option);
                      }}
                    >
                      {option === "plan"
                        ? "Sign in with my plan"
                        : option === "oauth"
                          ? "Sign in"
                          : "Use an API key"}
                    </button>
                  ))}
                </div>
              )}

              {login === "oauth" && (
                <>
                  {/* Set as the plan's description is, so its button has the same space above it. */}
                  <p className="lede">{oauthExplanation[row.id]}</p>
                  {oauthSignedIn === row.id ? (
                    <p className="lede">
                      {confirmed === row.id && <SignedInMark />}
                      Signed in to {row.name}.
                    </p>
                  ) : signInUrl ? (
                    <>
                      <StatusLine>
                        Waiting for you to approve sign-in in your browser.
                      </StatusLine>
                      {oauthCode && (
                        <p>
                          Verification code: <strong>{oauthCode}</strong>
                        </p>
                      )}
                      <ExternalLink href={signInUrl}>
                        Open sign-in page
                      </ExternalLink>
                      <button
                        type="button"
                        className="quiet"
                        onClick={cancelOAuth}
                      >
                        Cancel sign-in
                      </button>
                    </>
                  ) : null}
                  {!busy && (
                    <button
                      type="button"
                      className="quiet sign-in-with"
                      onClick={beginOAuth}
                    >
                      <ButtonMark id={row.mark} />
                      Sign in {oauthSignedIn === row.id ? "again " : ""}with{" "}
                      {row.name}
                    </button>
                  )}
                  {busy && !signInUrl && (
                    <StatusLine>Preparing sign-in…</StatusLine>
                  )}
                  <div className="field">
                    <label htmlFor="oauth-model">Model name</label>
                    <input
                      id="oauth-model"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </>
              )}

              {login === "plan" &&
                (token || (savedPlan && !signInUrl && !busy) ? (
                  <>
                    <p className="lede">
                      {token && confirmed === row.id && <SignedInMark />}
                      {token
                        ? `Signed in to ${row.name}.`
                        : `A saved ${row.name} sign-in will be checked when you start.`}{" "}
                      Your plan will be used.
                    </p>
                    {!token && (
                      <button
                        type="button"
                        className="quiet sign-in-with"
                        disabled={busy}
                        onClick={beginSignIn}
                      >
                        <ButtonMark id={row.mark} />
                        Sign in again with {row.name}
                      </button>
                    )}
                    {/*
                     * Said here because it changes an answer the person already gave.
                     *
                     * A subscription only works through the one Bot that speaks that vendor's
                     * sign-in, so choosing a plan re-points the Bot. Doing that silently would leave
                     * somebody looking at a Bot they did not choose with no idea why; see
                     * `harness::speaking_for` for the failure that came of not saying it at all.
                     */}
                    <p className="footnote">
                      Your Bot will use{" "}
                      {row.id === "anthropic"
                        ? "Claude Agent SDK"
                        : "OpenAI Agents SDK"}
                      . It’s the one that can use this plan.
                    </p>
                  </>
                ) : signInUrl ? (
                  <>
                    <p className="lede">
                      Approve the request in your browser. {row.name} will
                      finish this on its own.
                    </p>
                    <StatusLine>Waiting for you to approve it…</StatusLine>
                    {/* Shown as well as opened. On a machine with no registered
                    browser the open does nothing and says nothing, and a wait
                    with no link is then a dead end. */}
                    <p className="fallback">
                      Didn't open?{" "}
                      <a href={signInUrl} target="_blank" rel="noreferrer">
                        Open the sign-in page
                      </a>
                    </p>
                  </>
                ) : (
                  <>
                    {row.id === "openai" && held.saved?.chatgptSignInChanged ? (
                      <p className="sign-in-changed" role="status">
                        ChatGPT's sign-in has changed. Sign in to ChatGPT again
                        to keep using your plan.
                      </p>
                    ) : (
                      <p className="lede">
                        {row.name} opens in your browser. You won't type
                        anything here or need an API key.
                      </p>
                    )}
                    <div className="provider-sign-in-actions">
                      <button
                        type="button"
                        className="quiet sign-in-with"
                        disabled={busy}
                        onClick={beginSignIn}
                      >
                        <ButtonMark id={row.mark} />
                        {busy ? "Starting…" : `Sign in with ${row.name}`}
                      </button>
                      {!busy &&
                        (row.id === "openai" || row.id === "anthropic") &&
                        held.saved?.modelSessions?.[row.id] !== false && (
                          <button
                            type="button"
                            className="quiet"
                            onClick={() =>
                              setReuse({ provider: row.id, login: "plan" })
                            }
                          >
                            Use a saved{" "}
                            {row.id === "anthropic" ? "Claude" : "ChatGPT"}{" "}
                            sign-in
                          </button>
                        )}
                    </div>
                    {busy &&
                      (download ? (
                        <SetupProgress
                          label="Sign-in download"
                          steps={[download]}
                        />
                      ) : (
                        <StatusLine>
                          {progress ?? "Preparing sign-in…"}
                        </StatusLine>
                      ))}
                  </>
                ))}

              {login === "api-key" && (
                <>
                  {savedApiKey && !apiKey ? (
                    <p className="lede">
                      A saved {row.name} API key will be used.
                    </p>
                  ) : null}
                  {!savedApiKey &&
                    (row.id === "openai" || row.id === "anthropic") &&
                    held.saved?.modelApiKeys?.[row.id] !== false && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => {
                          setApiKey("");
                          setReuse({ provider: row.id, login: "api-key" });
                        }}
                      >
                        Use a saved {row.name} API key
                      </button>
                    )}
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
                  <p className="footnote">
                    OpenBot keeps this key on this computer.
                  </p>
                </>
              )}

              {login === "endpoint" && (
                <>
                  {savedEndpointKey && !apiKey && (
                    <p className="lede">
                      A saved API key for this endpoint will be used.{" "}
                      {!preset && (
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => setReuseEndpointKey(false)}
                        >
                          Continue without the saved key
                        </button>
                      )}
                    </p>
                  )}
                  {!preset && (
                    <>
                      <div className="field">
                        <label htmlFor="base">Base URL</label>
                        <input
                          id="base"
                          value={baseUrl}
                          onChange={(e) => {
                            const next = e.target.value;
                            setBaseUrl(next);
                            if (
                              held.OPENAI_CONTAINER_BASE_URL &&
                              containerBaseUrl.trim() ===
                                held.OPENAI_CONTAINER_BASE_URL.trim() &&
                              next.trim() !== held.OPENAI_BASE_URL?.trim()
                            ) {
                              setContainerBaseUrl("");
                            }
                          }}
                          placeholder="https://…/v1"
                          spellCheck={false}
                        />
                      </div>
                      <details className="field">
                        <summary>Advanced compatible endpoint options</summary>
                        <label htmlFor="container-base">
                          Container Base URL, if different
                        </label>
                        <input
                          id="container-base"
                          value={containerBaseUrl}
                          onChange={(e) => setContainerBaseUrl(e.target.value)}
                          placeholder="http://ollama:11434/v1"
                          spellCheck={false}
                        />
                        <p className="footnote">
                          Leave this empty unless containers need a different
                          address for a locally hosted model. Remote endpoints
                          usually use the same Base URL.
                        </p>
                      </details>
                    </>
                  )}
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
                    <label htmlFor="ekey">
                      {preset
                        ? `${row.name} API key`
                        : "API key, if the endpoint needs one"}
                    </label>
                    <input
                      id="ekey"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <p className="footnote">
                    OpenBot keeps this key on this computer.
                  </p>
                  {preset && (
                    <p className="footnote">
                      <ExternalLink key={preset.keyUrl} href={preset.keyUrl}>
                        {preset.keyLink}
                      </ExternalLink>
                    </p>
                  )}
                </>
              )}

              {/* Said before it happens rather than diagnosed after the Bots stop answering. */}
              {failure && <InlineFailure problem={failure} />}

              {/* About a plan's own pool of use, so said only where the person signs in with one. On
              Windows G it sat under "Anthropic API key", where it does not apply. */}
              {row.caution && login === "plan" && (
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

          {setupFailure}
        </div>

        {/* Actions stay outside the scrolling catalogue and authentication body. */}
        <div className="setup-footer step-footer">
          <div className="row">
            {onBack && (
              <button
                type="button"
                className="quiet"
                onClick={onBack}
                disabled={starting}
              >
                Back
              </button>
            )}
            <button
              type="button"
              disabled={starting || !row || !login || !ready}
              onClick={continueWithChoice}
            >
              Continue
            </button>
          </div>
          {/* Under the form, never above it: what runs behind this step comes and goes while the
          person types here, and nothing above the fields may move. See `BehindSlot`. */}
          {status}
        </div>
      </div>
    </>
  );
}

/** The tick beside "Signed in" for the second before the screen moves on by itself. */
function SignedInMark() {
  return (
    <span className="signed-in-mark" aria-hidden="true">
      ✓{" "}
    </span>
  );
}
