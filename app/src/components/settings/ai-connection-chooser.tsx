import {
  IconChevronRight,
  IconCircleCheckFilled,
  IconCloud,
  IconExternalLink,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { CopyButton } from "@/components/copy-button";
import {
  CHATGPT_DEAD_PAGE,
  ChatGptCodeSteps,
  ChatGptPaste,
  ChatGptSettingsLink,
  ChatGptSteps,
  wrongPage,
} from "@/components/settings/chatgpt-browser-sign-in";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type AiConnectionOwner,
  describeConnection,
} from "@/lib/ai-connection/describe";
import {
  beginPlanSignIn,
  beginProviderSignIn,
  cancelPlanSignIn,
  cancelProviderSignIn,
  finishesInDesktop,
  finishPlanSignIn,
  finishProviderSignIn,
  type Plan,
} from "@/lib/ai-connection/desktop";
import {
  type Connected as ConnectedResult,
  type ConnectPhase,
  connectAiMutationOptions,
  connectPersonalAiMutationOptions,
  finishPersonalSignIn,
  readPersonalSignIn,
  startPersonalSignIn,
} from "@/lib/ai-connection/mutations";
import {
  AI_PROVIDERS,
  type AiProvider,
  ENDPOINT_PRESETS,
  hostOf,
  isEndpointAddress,
  isSignIn,
  loginsHere,
  personalLogins,
  providerById,
  sharedLogins,
  signInWords,
} from "@/lib/ai-connection/providers";
import {
  awaitSignInRedirect,
  beginSignInRedirect,
  cancelSignInRedirect,
  fallbackMethod,
  signInThroughDesktop,
  takesRedirect,
} from "@/lib/ai-connection/sign-in-redirect";
import type {
  AiConnection,
  AiConnectionInput,
  AiConnectionLogin,
  AiConnectionProvider,
  AiConnectionProviderAnswer,
  AiSignIn,
  AiSignInInputMethod,
} from "@/lib/api/generated/model";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ClientError } from "@/lib/client";
import { desktopShell } from "@/lib/desktop/shell";
import { markFor } from "@/lib/marks";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

/**
 * Choosing an AI connection: the provider list, the way in (a key, an address, or a sign-in), and
 * Connect, which the server checks with the provider before it saves anything. The app's port of
 * OpenBot Desktop's setup window (desktop/src/ProviderPicker.tsx), shared by every place a person
 * connects an AI.
 *
 * TWO KINDS OF CONNECTION. `organization` is the AI every Bot in the organization runs on, which an
 * admin changes in Settings; inside OpenBot Desktop it may be a plan or a provider sign-in Desktop
 * holds. `personal` is a person's own AI on OpenBot Cloud: a key or an address for every provider,
 * and first the setup window's sign-in (a ChatGPT or Claude plan, a Google, xAI or Unbiased AI
 * sign-in) wherever the server runs it itself (`signIns`). The server keeps that sign-in for the
 * person and renews it, so never a Desktop-held one there, even inside Desktop: the server runs
 * the person's Bots. Inside Desktop, Desktop only listens for a Claude or ChatGPT plan's redirect,
 * so the person pastes nothing (lib/ai-connection/sign-in-redirect.ts); the sign-in stays the
 * server's.
 *
 * TWO SURFACES. In a dialog (Settings) it draws the dialog's header, body and footer. On a page
 * (onboarding) it draws the same body and buttons inside a card, under the page's own heading.
 */
export type ChooserMode =
  | {
      kind: "organization";
      inDesktop: boolean;
      /**
       * Beside each person's own AI (OpenBot Cloud): this is the organization's, for everyone in
       * it who hasn't connected their own, and the chooser says so.
       */
      organizationWide?: boolean;
      /**
       * On OpenBot Cloud in a plain browser: the admin may share their own sign-in as the
       * organization's AI. `signIns`: the providers the server signs them in to itself, as Connect
       * your AI offers them. `mine`: their own AI where it is a plan or a sign-in the server keeps
       * for them and can use now, which they can share without signing in again.
       */
      share?: {
        signIns: readonly AiConnectionProviderAnswer[];
        mine: AiConnection | null;
      };
    }
  | { kind: "personal"; signIns: readonly AiConnectionProviderAnswer[] };

export type ChooserSurface = "dialog" | "card";

const SurfaceContext = createContext<ChooserSurface>("dialog");

/** The dialog's header, or nothing on a card: the page's own heading says it there. */
function ChooserHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  if (useContext(SurfaceContext) === "card") return null;
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
  );
}

function ChooserBody({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  if (useContext(SurfaceContext) === "card")
    return <div className={className}>{children}</div>;
  return (
    <DialogBody className={`mt-4 overflow-y-auto ${className}`}>
      {children}
    </DialogBody>
  );
}

function ChooserFooter({ children }: { children: ReactNode }) {
  if (useContext(SurfaceContext) === "card")
    return (
      <div className="mt-4 flex flex-row items-center justify-end gap-2">
        {children}
      </div>
    );
  return <DialogFooter className="mt-4">{children}</DialogFooter>;
}

/**
 * A card on a page that holds the chooser: the booking calendar's shape (a real control, so the
 * card's fill, never the illustrations' muted panel), with the dialog's padding.
 */
export function ChooserCard({ children }: { children: ReactNode }) {
  return (
    <SurfaceContext.Provider value="card">
      <div
        className="flex w-full min-w-0 flex-col rounded-2xl border border-border bg-card p-5 text-card-foreground"
        data-ai-chooser=""
      >
        {children}
      </div>
    </SurfaceContext.Provider>
  );
}

/** A provider's mark on the row's tile, or a cloud for the row that stands for every provider. */
export function ProviderTile({
  provider,
}: {
  provider: AiProvider | undefined;
}) {
  return (
    <ItemMedia variant="icon">
      {provider?.mark && markFor(provider.mark) ? (
        <HarnessMark id={provider.mark} name={provider.name} />
      ) : provider ? (
        <IconCloud />
      ) : (
        <IconSparkles />
      )}
    </ItemMedia>
  );
}

export function Details({
  details,
}: {
  details: { label: string; value: string }[];
}) {
  return (
    <ItemGroup className="gap-1">
      {details.map((detail) => (
        <Item key={detail.label} role="listitem" size="xs" variant="muted">
          <ItemContent>
            <ItemTitle className="font-normal text-muted-foreground">
              {detail.label}
            </ItemTitle>
          </ItemContent>
          <ItemActions className="min-w-0">
            <span className="truncate font-medium">{detail.value}</span>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}

/** What each way in is called on its tab, in the setup window's words. */
function loginLabel(login: AiConnectionLogin): string {
  switch (login) {
    case "plan":
      return "Sign in with my plan";
    case "oauth":
      return "Sign in";
    default:
      return "Use an API key";
  }
}

/** The ways in this chooser offers for a provider. */
function loginsFor(provider: AiProvider, mode: ChooserMode) {
  if (mode.kind === "personal") return personalLogins(provider, mode.signIns);
  if (mode.share && !mode.inDesktop)
    return sharedLogins(provider, mode.share.signIns);
  return loginsHere(provider, mode.inDesktop);
}

/** The provider row's second line: the setup window's, where its sign-in is offered here. */
function providerSummary(provider: AiProvider, mode: ChooserMode) {
  if (mode.kind === "organization" && mode.inDesktop) return provider.summary;
  return isSignIn(loginsFor(provider, mode)[0] ?? null)
    ? provider.summary
    : provider.keySummary;
}

/**
 * The admin's own sign-in for this provider and way in, where they can share it as it is: their own
 * AI is that provider's plan or sign-in, and it works now.
 */
function keptSignIn(
  mode: ChooserMode,
  provider: AiProvider | undefined,
  login: AiConnectionLogin | null,
): AiConnection | null {
  if (mode.kind !== "organization" || mode.inDesktop || !mode.share)
    return null;
  const mine = mode.share.mine;
  return mine &&
    provider &&
    mine.provider === provider.id &&
    mine.login === login &&
    isSignIn(login)
    ? mine
    : null;
}

/**
 * The note an admin reads before sharing their own sign-in: what it does for everyone else.
 */
function shareNote(provider: AiConnectionProvider, login: AiConnectionLogin) {
  return `Bots across your organization will run on your ${signInWords(provider, login)} for everyone who hasn't connected their own AI.`;
}

/**
 * A sign-in in the browser, while it waits for the person to approve it there. `codeBack`: the
 * person then pastes what the provider gave them here (the code Claude's page shows, or the address
 * ChatGPT sends their browser to). `signInId`: the server's own sign-in, for a person's own AI.
 * `method`: the way in it was started with, where the provider has more than one (ChatGPT).
 * `redirect`: OpenBot Desktop is listening for the provider's redirect, so nothing is pasted.
 */
type Waiting = {
  url: string;
  code?: string | null;
  attemptId?: string;
  signInId?: string;
  codeBack?: boolean;
  method?: AiSignInInputMethod;
  redirect?: boolean;
};

/**
 * How a ChatGPT plan signs in where the server runs it. In a browser, `code` first: a code to enter
 * at ChatGPT, which never lands on a page that won't load. `browser`, the other way: the browser
 * sign-in whose last page won't load, and whose address the person pastes back. Inside OpenBot
 * Desktop, `browser` first: Desktop takes that last page itself, so it loads and nothing is pasted.
 */
type ChatGptWay = "code" | "browser";

const wait = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export function ChooseConnection({
  connection,
  mode,
  onBack,
  onConnected,
}: {
  connection: AiConnection;
  mode: ChooserMode;
  /** Back from a chosen provider, or Cancel from the list. Absent: the list has no way back. */
  onBack?: () => void;
  onConnected: (connected: ConnectedResult) => void;
}) {
  const personal = mode.kind === "personal";
  const inDesktop = mode.kind === "organization" && mode.inDesktop;
  const organizationWide =
    mode.kind === "organization" && mode.organizationWide === true;
  // The organization's AI on OpenBot Cloud in a plain browser: the admin's own sign-in, shared.
  const share =
    mode.kind === "organization" && !mode.inDesktop && mode.share
      ? mode.share
      : null;
  // The server runs the sign-in (Connect your AI's), never OpenBot Desktop.
  const serverRun = personal || share !== null;
  // Inside OpenBot Desktop, which can take a plan's redirect for the server's sign-in.
  const inDesktopWindow = desktopShell() !== null;
  // ChatGPT's first way: its browser sign-in where Desktop takes the redirect, a code elsewhere.
  const firstChatGptWay: ChatGptWay =
    serverRun && inDesktopWindow ? "browser" : "code";
  const [providerId, setProviderId] = useState<AiProvider["id"] | null>(null);
  const provider = providerById(providerId);
  const logins = provider ? loginsFor(provider, mode) : [];
  const [login, setLogin] = useState<AiConnectionLogin | null>(null);
  const kept = keptSignIn(mode, provider, login);
  // The admin's own sign-in, offered first in the list when it can be shared as it is.
  const mineProvider = share?.mine
    ? providerById(share.mine.provider)
    : undefined;
  const shareable =
    mineProvider &&
    share?.mine?.login &&
    sharedLogins(mineProvider, share.signIns).includes(share.mine.login)
      ? keptSignIn(mode, mineProvider, share.mine.login)
      : null;
  const preset = provider ? ENDPOINT_PRESETS[provider.id] : undefined;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [useSaved, setUseSaved] = useState(true);
  const [phase, setPhase] = useState<ConnectPhase>("checking");
  // A sign-in in the browser: waiting for it, done, or failed with its sentence.
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [signInCode, setSignInCode] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [signInFailure, setSignInFailure] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [chatGptWay, setChatGptWay] = useState<ChatGptWay>(firstChatGptWay);
  /*
   * Desktop couldn't take this provider's redirect (an older Desktop, a busy port, a server from
   * before it took the port): its sign-in is finished by paste, as in a browser.
   */
  const [pasteBack, setPasteBack] = useState(false);
  // The key an Unbiased AI sign-in in Desktop mints: held for the one request that sends it, never drawn.
  const minted = useRef<string | null>(null);
  const attempt = useRef<{
    plan?: Plan;
    attemptId?: string;
    redirectId?: string;
  } | null>(null);
  const run = useRef(0);
  const connect = useMutation(
    personal
      ? connectPersonalAiMutationOptions(queryClient)
      : connectAiMutationOptions(queryClient),
  );

  /** Stop a sign-in still waiting in the browser, so its tab can't finish into a closed chooser. */
  function stopSignIn() {
    run.current += 1;
    const pending = attempt.current;
    attempt.current = null;
    if (pending?.plan) void cancelPlanSignIn(pending.plan).catch(() => {});
    if (pending?.attemptId)
      void cancelProviderSignIn(pending.attemptId).catch(() => {});
    if (pending?.redirectId) cancelSignInRedirect(pending.redirectId);
    setWaiting(null);
    setSigningIn(false);
  }
  const stopLatest = useRef(stopSignIn);
  stopLatest.current = stopSignIn;
  useEffect(() => () => stopLatest.current(), []);

  function choose(next: AiProvider | null) {
    stopSignIn();
    connect.reset();
    setProviderId(next?.id ?? null);
    const nextLogins = next ? loginsFor(next, mode) : [];
    setLogin(nextLogins[0] ?? null);
    const nextPreset = next ? ENDPOINT_PRESETS[next.id] : undefined;
    const nextKept = keptSignIn(mode, next ?? undefined, nextLogins[0] ?? null);
    setApiKey("");
    setBaseUrl(nextPreset?.baseUrl ?? "");
    setModel(nextKept?.model ?? nextPreset?.model ?? "");
    setUseSaved(true);
    setSignedIn(nextKept !== null);
    setSignInFailure(null);
    setSignInCode("");
    setChatGptWay(firstChatGptWay);
    setPasteBack(false);
    minted.current = null;
  }

  /** Switch ChatGPT's way in, before a sign-in starts: what failed the other way no longer applies. */
  function chooseChatGptWay(next: ChatGptWay) {
    stopSignIn();
    setSignInFailure(null);
    setSignInCode("");
    setChatGptWay(next);
  }

  function chooseLogin(next: AiConnectionLogin) {
    if (next === login) return;
    stopSignIn();
    connect.reset();
    setSignedIn(keptSignIn(mode, provider, next) !== null);
    setSignInFailure(null);
    setLogin(next);
  }

  const address = preset ? preset.baseUrl : baseUrl;
  const host = hostOf(address);
  const savedKey =
    provider &&
    (login === "api-key" || login === "endpoint") &&
    connection.saved.some(
      (saved) =>
        saved.provider === provider.id &&
        saved.login === login &&
        (login === "api-key" || saved.endpointHost === host),
    );
  const usingSaved = Boolean(savedKey && useSaved);
  const typedKey = apiKey.trim();
  const typedModel = model.trim();

  const ready =
    !!provider &&
    !!login &&
    (login === "api-key"
      ? usingSaved || typedKey.length > 0
      : login === "endpoint"
        ? isEndpointAddress(address) &&
          typedModel.length > 0 &&
          (!preset || usingSaved || typedKey.length > 0)
        : login === "oauth"
          ? signedIn && typedModel.length > 0
          : signedIn);

  function input(): AiConnectionInput | null {
    if (!provider || !login) return null;
    if (login === "api-key")
      return usingSaved
        ? { provider: provider.id, login, useSavedKey: true }
        : { provider: provider.id, login, apiKey: typedKey };
    if (login === "endpoint")
      return {
        provider: provider.id,
        login,
        baseUrl: address.trim(),
        model: typedModel,
        ...(usingSaved
          ? { useSavedKey: true }
          : typedKey
            ? { apiKey: typedKey }
            : {}),
      };
    /*
     * Unbiased AI's sign-in, run by the server: its key is kept for the person, for the provider's
     * own address. A plan or a Google or xAI sign-in the server ran connects as itself, below.
     */
    if (login === "oauth" && personal && provider.id === "unbiased" && preset)
      return {
        provider: provider.id,
        login: "endpoint",
        baseUrl: preset.baseUrl,
        model: typedModel,
        useSavedKey: true,
      };
    // Unbiased AI's sign-in ends in a key for its own address, sent exactly as a typed one is.
    if (login === "oauth" && provider.id === "unbiased" && preset) {
      if (!minted.current) return null;
      return {
        provider: provider.id,
        login: "endpoint",
        apiKey: minted.current,
        baseUrl: preset.baseUrl,
        model: typedModel,
      };
    }
    if (login === "oauth")
      return { provider: provider.id, login, model: typedModel };
    return { provider: provider.id, login };
  }

  /**
   * The server's own sign-in: start it and open the provider's page. With `finish` poll, read where
   * it stands every `interval` seconds until it is approved, failed or expired. With `finish` code,
   * stop and wait for the person to paste what the provider gave them (`finishCode`). What the
   * provider hands back stays on the server.
   *
   * Inside OpenBot Desktop, a Claude plan and ChatGPT's browser sign-in finish through Desktop's
   * listener instead, with nothing pasted. Where that can't work, the paste, as in a browser.
   */
  async function serverSignIn(
    chosen: AiProvider,
    current: () => boolean,
    method: AiSignInInputMethod | undefined,
  ): Promise<"approved" | "code" | false> {
    let started: AiSignIn | null = null;
    const redirectProvider = chosen.id;
    if (
      (redirectProvider === "anthropic" || redirectProvider === "openai") &&
      takesRedirect({
        inDesktop: inDesktopWindow,
        serverRun,
        provider: redirectProvider,
        login,
        method,
        pasteBack,
      })
    ) {
      const through = await signInThroughDesktop(redirectProvider, {
        begin: beginSignInRedirect,
        start: (loopbackPort) =>
          redirectProvider === "anthropic"
            ? startPersonalSignIn(redirectProvider, method, { loopbackPort })
            : startPersonalSignIn(redirectProvider, "browser"),
        wait: awaitSignInRedirect,
        cancel: cancelSignInRedirect,
        finish: finishPersonalSignIn,
        hold: (redirectId) => {
          attempt.current = redirectId ? { redirectId } : null;
        },
        opened: (signIn) => {
          setWaiting({
            url: signIn.url,
            signInId: signIn.id,
            method: signIn.provider === "openai" ? "browser" : method,
            redirect: true,
          });
          window.open(signIn.url, "_blank", "noopener");
        },
        current,
      });
      if (through.outcome === "stopped") return false;
      if (through.outcome === "approved") return "approved";
      // Desktop can't take it here: from now on this provider signs in as it does today.
      setPasteBack(true);
      const instead = fallbackMethod(redirectProvider);
      if (instead === "device") {
        // ChatGPT: today's first way, its code sign-in, started now; the address stays the other way.
        setChatGptWay("code");
        return serverSignIn(chosen, current, instead);
      }
      started = through.begun;
    }
    const begun =
      started ??
      (await startPersonalSignIn(chosen.id, method).catch((error: unknown) => {
        // OpenAI gave no code (the server's 422): most often, device code sign-in is off. Said so.
        if (
          method === "device" &&
          error instanceof ClientError &&
          error.status === 422
        )
          throw new Error(CHATGPT_NO_CODE);
        throw error;
      }));
    if (!current()) return false;
    const codeBack = begun.finish === "code";
    setWaiting({
      url: begun.url,
      code: begun.userCode,
      signInId: begun.id,
      codeBack,
      method,
    });
    window.open(begun.url, "_blank", "noopener");
    if (codeBack) return "code";
    let interval = begun.interval;
    for (;;) {
      await wait(interval);
      if (!current()) return false;
      const status = await readPersonalSignIn(begun.id);
      if (!current()) return false;
      if (status.status === "approved") return "approved";
      if (status.status === "failed" || status.status === "expired")
        throw new Error(status.detail ?? SIGN_IN_DIDNT_FINISH);
      interval = status.interval;
    }
  }

  /** `method`: ChatGPT's code sign-in (`device`) in place of its browser sign-in, the server's default. */
  async function signIn(method?: AiSignInInputMethod) {
    if (!provider || !login) return;
    stopSignIn();
    const mine = run.current;
    const current = () => run.current === mine;
    setSigningIn(true);
    setSignInFailure(null);
    setSignedIn(false);
    try {
      if (serverRun) {
        const reached = await serverSignIn(provider, current, method);
        if (!reached) return;
        // The provider's page gives the person a code to paste here; the field waits for it.
        if (reached === "code") {
          setSigningIn(false);
          return;
        }
      } else if (login === "plan") {
        const plan: Plan = provider.id === "anthropic" ? "claude" : "chatgpt";
        attempt.current = { plan };
        const { url } = await beginPlanSignIn(plan);
        if (!current()) return;
        // A Desktop older than Claude's loopback sign-in sends Claude's code page: paste it here.
        const codeBack = plan === "claude" && !finishesInDesktop(url);
        setWaiting({ url, codeBack });
        window.open(url, "_blank", "noopener");
        if (codeBack) {
          setSigningIn(false);
          return;
        }
        // Otherwise the browser comes back to Desktop, and it finishes on its own.
        await finishPlanSignIn(plan);
      } else {
        const begun = await beginProviderSignIn(
          provider.id as "google" | "xai" | "unbiased",
        );
        if (!current()) {
          void cancelProviderSignIn(begun.attemptId).catch(() => {});
          return;
        }
        attempt.current = { attemptId: begun.attemptId };
        setWaiting({
          url: begun.url,
          code: begun.userCode,
          attemptId: begun.attemptId,
        });
        window.open(begun.url, "_blank", "noopener");
        const finished = await finishProviderSignIn(begun.attemptId);
        if (!current()) return;
        minted.current = finished?.apiKey ?? null;
      }
      if (!current()) return;
      attempt.current = null;
      setWaiting(null);
      setSignedIn(true);
      setSigningIn(false);
    } catch (error) {
      if (!current()) return;
      attempt.current = null;
      setWaiting(null);
      setSigningIn(false);
      setSignInFailure(
        error instanceof Error ? error.message : "Couldn't sign in. Try again.",
      );
    }
  }

  /**
   * Send the code the provider's page gave the person (`given`, when it came straight from a paste,
   * or what is in the box): to the server, or to Desktop's Claude plan.
   */
  async function finishCode(given?: string) {
    const mine = run.current;
    const signInId = waiting?.signInId;
    const pasted = (given ?? signInCode).trim();
    if (!pasted) return;
    setSignInFailure(null);
    // OpenAI's own sign-in page, pasted in place of the page it lands on: said here, nothing sent.
    const wrong =
      signInId && provider?.id === "openai" ? wrongPage(pasted) : null;
    if (wrong) {
      setSignInFailure(wrong);
      return;
    }
    setSigningIn(true);
    try {
      if (signInId) {
        const status = await finishPersonalSignIn(signInId, pasted);
        if (run.current !== mine) return;
        if (status.status !== "approved")
          throw new Error(status.detail ?? SIGN_IN_DIDNT_FINISH);
      } else await finishPlanSignIn("claude", pasted);
      if (run.current !== mine) return;
      attempt.current = null;
      setWaiting(null);
      setSignInCode("");
      setSignedIn(true);
    } catch (error) {
      if (run.current !== mine) return;
      const message =
        error instanceof Error ? error.message : "Couldn't sign in. Try again.";
      setSignInFailure(message);
      /*
       * The server refused what was pasted (400: from another sign-in, or with no code in it) and
       * the sign-in waits on: the box stays open for the right one. Anything else, a sign-in that
       * failed or expired, ends the attempt and it starts again.
       */
      if (signInId && error instanceof ClientError && error.status === 400)
        return;
      attempt.current = null;
      setWaiting(null);
    } finally {
      if (run.current === mine) setSigningIn(false);
    }
  }

  function submit() {
    const body = input();
    if (!ready || !body) return;
    send(body);
  }

  /**
   * Share the admin's own sign-in as it is, from the list: no sign-in again. A Google or xAI
   * sign-in runs on the model their own AI names, or the provider's usual one.
   */
  function shareMine(mine: AiConnection) {
    // The server's answer can name a provider this app doesn't know: that one isn't offered.
    const known = providerById(mine.provider)?.id;
    if (!known || (mine.login !== "plan" && mine.login !== "oauth")) return;
    const named = mine.model ?? ENDPOINT_PRESETS[known]?.model;
    if (mine.login === "oauth" && !named) return;
    send(
      mine.login === "oauth" && named
        ? { provider: known, login: mine.login, model: named }
        : { provider: known, login: mine.login },
    );
  }

  function send(body: AiConnectionInput) {
    if (connect.isPending) return;
    connect.mutate(
      { input: body, desktop: inDesktop, onPhase: setPhase },
      {
        onSuccess: (connected) => {
          minted.current = null;
          setApiKey("");
          onConnected(connected);
        },
      },
    );
  }

  const busy = connect.isPending;
  const pendingLabel =
    phase === "starting"
      ? `Starting ${provider?.id === "anthropic" ? "Claude" : "ChatGPT"}…`
      : phase === "finishing"
        ? "Finishing…"
        : `Checking with ${provider?.name ?? "the provider"}…`;
  const resetFailure = () => {
    if (connect.error) connect.reset();
  };
  /*
   * Back from a chosen provider: to the dialog's previous screen for the organization's AI, as it
   * always was; to the list for a person's own, which has no screen before it on a page.
   */
  const back = personal && provider ? () => choose(null) : onBack;

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ChooserHeader
        description={
          provider
            ? "OpenBot checks the connection before it switches. Nothing changes if the check fails."
            : personal
              ? "Choose the AI your Bots use when they work for you. It's yours alone."
              : organizationWide
                ? "Choose an AI for everyone in your organization. Bots use it for anyone who hasn't connected their own."
                : "Choose the AI your Bots use. OpenBot keeps running while it switches."
        }
        title={
          personal
            ? "Connect your AI"
            : organizationWide
              ? describeConnection(connection)
                ? "Change your organization's AI"
                : "Set up your organization's AI"
              : "Change AI connection"
        }
      />
      <ChooserBody className="flex flex-col gap-4">
        {!provider && shareable?.provider && shareable.login ? (
          <ShareMine
            busy={busy}
            login={shareable.login}
            onShare={() => shareMine(shareable)}
            provider={providerById(shareable.provider)}
          />
        ) : null}
        <fieldset
          aria-label="AI provider"
          className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
        >
          {(provider ? [provider] : AI_PROVIDERS).map((row) => (
            <Item
              key={row.id}
              render={
                <button
                  disabled={busy}
                  onClick={() => choose(provider ? null : row)}
                  type="button"
                />
              }
              // A button centres its text; a row reads from the left like every other.
              className="text-left"
              size="sm"
              variant="muted"
            >
              <ProviderTile provider={row} />
              <ItemContent>
                <ItemTitle>{row.name}</ItemTitle>
                <ItemDescription>{providerSummary(row, mode)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                {provider ? (
                  <span className="text-muted-foreground text-xs">Change</span>
                ) : (
                  <IconChevronRight className="size-4 text-muted-foreground" />
                )}
              </ItemActions>
            </Item>
          ))}
        </fieldset>

        {provider && login ? (
          <FieldGroup className="gap-4">
            {logins.length > 1 ? (
              <Tabs
                onValueChange={(value) =>
                  chooseLogin(value as AiConnectionLogin)
                }
                value={login}
              >
                <TabsList aria-label="How OpenBot signs in" className="w-full">
                  {logins.map((option) => (
                    <TabsTrigger disabled={busy} key={option} value={option}>
                      {loginLabel(option)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : null}

            {login === "plan" || login === "oauth" ? (
              <SignInFields
                busy={busy || signingIn}
                code={signInCode}
                failure={signInFailure}
                kept={kept !== null && signedIn}
                login={login}
                onCancel={stopSignIn}
                onCode={(value) => {
                  // A new paste or edit: what was wrong with the last one no longer applies.
                  setSignInCode(value);
                  setSignInFailure(null);
                }}
                onFinishCode={finishCode}
                serverRun={serverRun}
                desktopListens={serverRun && inDesktopWindow && !pasteBack}
                noPaste={
                  waiting
                    ? waiting.redirect === true
                    : takesRedirect({
                        inDesktop: inDesktopWindow,
                        serverRun,
                        provider: provider.id,
                        login,
                        method:
                          provider.id === "openai" && chatGptWay === "code"
                            ? "device"
                            : undefined,
                        pasteBack,
                      })
                }
                chatGptWay={chatGptWay}
                onChatGptWay={chooseChatGptWay}
                onSignIn={() =>
                  // ChatGPT's plan where the server runs it: the way chosen, a code or the browser.
                  serverRun &&
                  provider.id === "openai" &&
                  login === "plan" &&
                  chatGptWay === "code"
                    ? signIn("device")
                    : signIn()
                }
                provider={provider}
                signedIn={signedIn}
                waiting={waiting}
              />
            ) : null}

            {share && isSignIn(login) ? (
              <p className="text-muted-foreground text-sm">
                {shareNote(provider.id, login)}
              </p>
            ) : null}

            {login === "endpoint" && !preset ? (
              <Field>
                <FieldLabel htmlFor="ai-connection-address">Address</FieldLabel>
                <Input
                  aria-invalid={
                    baseUrl.trim().length > 0 && !isEndpointAddress(baseUrl)
                  }
                  autoComplete="off"
                  disabled={busy}
                  id="ai-connection-address"
                  onChange={(event) => {
                    resetFailure();
                    setBaseUrl(event.target.value);
                  }}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  value={baseUrl}
                />
                <FieldDescription>
                  The address of a server that speaks OpenAI's API.
                </FieldDescription>
              </Field>
            ) : null}

            {login === "endpoint" || login === "oauth" ? (
              <Field>
                <FieldLabel htmlFor="ai-connection-model">
                  Model name
                </FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={busy}
                  id="ai-connection-model"
                  onChange={(event) => {
                    resetFailure();
                    setModel(event.target.value);
                  }}
                  placeholder={
                    preset?.model ?? "The name the server knows it by"
                  }
                  spellCheck={false}
                  value={model}
                />
              </Field>
            ) : null}

            {login === "api-key" || login === "endpoint" ? (
              <KeyFields
                apiKey={apiKey}
                busy={busy}
                keyLink={login === "endpoint" ? preset : undefined}
                label={
                  login === "endpoint" && !preset
                    ? "API key, if it needs one"
                    : `${provider.name} API key`
                }
                onApiKey={(value) => {
                  resetFailure();
                  setApiKey(value);
                }}
                onUseSaved={(value) => {
                  resetFailure();
                  setUseSaved(value);
                }}
                savedKey={Boolean(savedKey)}
                useSaved={usingSaved}
              />
            ) : null}

            {provider.id === "anthropic" && login === "plan" ? (
              <p className="text-muted-foreground text-xs">
                A Claude plan carries a separate monthly pool of Agent SDK
                credits. When that pool is empty, Bots stop until it renews or
                you add API credits.
              </p>
            ) : null}
          </FieldGroup>
        ) : null}

        {connect.error ? (
          <p className="text-destructive text-sm" role="alert">
            {failureSaid(connect.error)}
          </p>
        ) : null}
      </ChooserBody>
      {back || provider ? (
        <ChooserFooter>
          {back ? (
            <Button
              disabled={busy}
              onClick={() => {
                stopSignIn();
                back();
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {provider ? "Back" : "Cancel"}
            </Button>
          ) : null}
          {provider ? (
            <Button disabled={!ready || busy} size="sm" type="submit">
              {busy
                ? pendingLabel
                : share && login && isSignIn(login)
                  ? `Use my ${signInWords(provider.id, login)} for everyone`
                  : "Connect"}
            </Button>
          ) : null}
        </ChooserFooter>
      ) : null}
    </form>
  );
}

function KeyFields({
  apiKey,
  busy,
  keyLink,
  label,
  onApiKey,
  onUseSaved,
  savedKey,
  useSaved,
}: {
  apiKey: string;
  busy: boolean;
  keyLink: { keyUrl: string; keyLink: string } | undefined;
  label: string;
  onApiKey: (value: string) => void;
  onUseSaved: (value: boolean) => void;
  savedKey: boolean;
  useSaved: boolean;
}) {
  return (
    <>
      {savedKey ? (
        <Field orientation="horizontal">
          <Checkbox
            checked={useSaved}
            disabled={busy}
            id="ai-connection-saved"
            onCheckedChange={(checked) => onUseSaved(checked === true)}
          />
          <FieldLabel className="font-normal" htmlFor="ai-connection-saved">
            Use the saved key
          </FieldLabel>
        </Field>
      ) : null}
      {useSaved ? null : (
        <Field>
          <FieldLabel htmlFor="ai-connection-key">{label}</FieldLabel>
          <Input
            autoComplete="off"
            disabled={busy}
            id="ai-connection-key"
            onChange={(event) => onApiKey(event.target.value)}
            spellCheck={false}
            type="password"
            value={apiKey}
          />
          {keyLink ? (
            <FieldDescription>
              <a href={keyLink.keyUrl} rel="noreferrer" target="_blank">
                {keyLink.keyLink}
              </a>
            </FieldDescription>
          ) : null}
        </Field>
      )}
    </>
  );
}

/** What approving a sign-in in the browser does, for each provider that signs in that way. */
const SIGN_IN_SAYS: Record<string, string> = {
  anthropic:
    "Anthropic opens in your browser. Approve the request there, then paste the code it shows you.",
  openai:
    "OpenAI opens in your browser. It finishes on its own once you approve.",
  google:
    "Authorize Gemini API access using the configured Google Cloud project and its API quota.",
  xai: "Authorize OpenBot to use models available to your xAI account.",
  unbiased:
    "Sign in or create an Unbiased AI account in your browser and approve the code shown here.",
};

/**
 * A Claude or ChatGPT plan inside OpenBot Desktop, which takes the provider's redirect: nothing to
 * paste, and the page it lands on loads. The same words where Desktop runs Claude's sign-in itself;
 * a Desktop older than that hands back a code to paste instead, and `SIGN_IN_SAYS` says so.
 */
const NO_PASTE_SAYS: Record<string, string> = {
  anthropic:
    "Anthropic opens in your browser. It finishes on its own once you approve.",
  openai: SIGN_IN_SAYS.openai ?? "",
};

/** ChatGPT's sign-in with a code (`device`): its page asks for the code shown here. */
const CODE_SIGN_IN_SAYS =
  "OpenAI opens in your browser. Enter the code shown here, then approve. It finishes on its own.";

const SIGN_IN_DIDNT_FINISH = "The sign-in didn't finish. Try again.";

/** ChatGPT gave no code for its code sign-in: most often, device code sign-in is off. */
const CHATGPT_NO_CODE =
  "ChatGPT didn't give OpenBot a code. Device code sign-in is probably turned off. Turn it on in ChatGPT's security settings, then try again.";

function SignInFields({
  busy,
  chatGptWay,
  code,
  desktopListens,
  failure,
  kept,
  login,
  noPaste,
  onCancel,
  onChatGptWay,
  onCode,
  onFinishCode,
  onSignIn,
  serverRun,
  provider,
  signedIn,
  waiting,
}: {
  busy: boolean;
  /** How a ChatGPT plan the server runs signs in: a code, or the browser. */
  chatGptWay: ChatGptWay;
  /** Inside OpenBot Desktop, which can take a plan's redirect for the server's sign-in. */
  desktopListens: boolean;
  /** This sign-in finishes through Desktop's listener: no paste box, and no page that won't load. */
  noPaste: boolean;
  code: string;
  failure: string | null;
  /** Signed in already: the admin's own sign-in, kept for them, to share as it is. */
  kept: boolean;
  login: AiConnectionLogin;
  onCancel: () => void;
  onChatGptWay: (way: ChatGptWay) => void;
  onCode: (code: string) => void;
  /** Send `text` when it came straight from a paste, or what is in the box. */
  onFinishCode: (text?: string) => void;
  /** Start the sign-in, or start it again: for ChatGPT, in the way chosen. */
  onSignIn: () => void;
  /** The server runs the sign-in (a person's own AI, or an admin's shared one), not Desktop. */
  serverRun: boolean;
  provider: AiProvider;
  signedIn: boolean;
  waiting: Waiting | null;
}) {
  /*
   * ChatGPT's plan where the server runs it has two ways in. First, a code to enter at ChatGPT
   * (`chatGptCode`), which never shows a page that won't load but needs device code sign-in turned
   * on in ChatGPT: the setting and its link come first. The other way, the browser sign-in
   * (`chatGptInBrowser`), lands on a page that can't load, whose address the person brings back:
   * its own steps first, and its own paste box. A sign-in under way keeps the way it started with.
   * Inside OpenBot Desktop the browser sign-in comes first and is neither: Desktop takes its last
   * page, so it loads and nothing is pasted (`noPaste`).
   */
  const chatGptServer =
    serverRun && provider.id === "openai" && login === "plan";
  const chatGptInBrowser =
    chatGptServer &&
    (waiting ? waiting.method !== "device" : chatGptWay === "browser");
  const chatGptCode = chatGptServer && !chatGptInBrowser;
  const signInName = chatGptServer
    ? "ChatGPT"
    : provider.id === "google"
      ? "Google"
      : provider.name;
  if (kept)
    return (
      <p className="flex items-center gap-2 text-sm">
        <IconCircleCheckFilled className="size-4 shrink-0 text-success" />
        You're signed in with your {signInWords(provider.id, login)}.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {chatGptInBrowser ? (
        signedIn ? null : noPaste ? (
          <p className="text-muted-foreground text-sm">
            {NO_PASTE_SAYS.openai}
          </p>
        ) : waiting ? (
          <p className="text-muted-foreground text-sm">
            Approve the request in OpenAI's tab. When it says “
            {CHATGPT_DEAD_PAGE}”, copy its address and paste it below.
          </p>
        ) : (
          <ChatGptSteps />
        )
      ) : chatGptCode ? (
        signedIn ? null : waiting ? (
          <p className="text-muted-foreground text-sm">{CODE_SIGN_IN_SAYS}</p>
        ) : (
          <ChatGptCodeSteps />
        )
      ) : (
        <p className="text-muted-foreground text-sm">
          {waiting?.method === "device"
            ? CODE_SIGN_IN_SAYS
            : noPaste
              ? NO_PASTE_SAYS[provider.id]
              : provider.id === "anthropic" && !serverRun && !waiting?.codeBack
                ? NO_PASTE_SAYS.anthropic
                : SIGN_IN_SAYS[provider.id]}
        </p>
      )}
      {signedIn ? (
        <p className="flex items-center gap-2 text-sm">
          <IconCircleCheckFilled className="size-4 text-success" />
          Signed in to {provider.name}.
        </p>
      ) : waiting ? (
        <div className="flex flex-col gap-3">
          {/* The code to enter on the provider's page, with a button that copies it to paste there. */}
          {waiting.code ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="text-sm">
                Verification code:{" "}
                <strong className="font-mono">{waiting.code}</strong>
              </p>
              <CopyButton
                key={waiting.code}
                label="Copy the code"
                text={waiting.code}
              />
            </div>
          ) : null}
          <p className="text-muted-foreground text-sm">
            Didn't open?{" "}
            <a
              className="text-foreground underline underline-offset-4"
              href={waiting.url}
              rel="noreferrer"
              target="_blank"
            >
              Open the sign-in page
              <IconExternalLink className="ml-0.5 inline size-3.5" />
            </a>
          </p>
          {waiting.codeBack && chatGptInBrowser ? (
            <ChatGptPaste
              busy={busy}
              code={code}
              failure={failure}
              onCode={onCode}
              onFinish={onFinishCode}
            />
          ) : waiting.codeBack ? (
            <Field>
              <FieldLabel htmlFor="ai-connection-code">
                Code from your browser
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  autoComplete="off"
                  id="ai-connection-code"
                  onChange={(event) => onCode(event.target.value)}
                  spellCheck={false}
                  value={code}
                />
                <Button
                  disabled={busy || code.trim().length === 0}
                  onClick={() => onFinishCode()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {busy ? "Checking…" : "Finish"}
                </Button>
              </div>
            </Field>
          ) : (
            <p className="text-muted-foreground text-sm">
              Waiting for you to approve it in your browser…
            </p>
          )}
          {/*
           * With the setting off, OpenAI takes the code and says so only on its own page, and the
           * code can't be used after. Turned on, a new code is one press away.
           */}
          {chatGptCode ? (
            <p className="text-muted-foreground text-sm">
              Does OpenAI say device code sign-in is off? Turn it on in{" "}
              <ChatGptSettingsLink>
                ChatGPT's security settings
              </ChatGptSettingsLink>
              , then get a new code.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {chatGptCode ? (
              <Button
                onClick={onSignIn}
                size="sm"
                type="button"
                variant="outline"
              >
                Get a new code
              </Button>
            ) : null}
            {/* Its words line up with the lines above; the ghost button's padding hangs outside. */}
            <Button
              className={chatGptCode ? undefined : "-ml-2.5"}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel sign-in
            </Button>
          </div>
        </div>
      ) : null}
      {/* A sign-in that failed or expired: why, just above the button that starts it again. */}
      {failure && !waiting && !signedIn ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-destructive" role="alert">
            {failure}
          </p>
          {/* A code that didn't work: the setting it needs is the likeliest reason. */}
          {chatGptCode ? (
            <p>
              <ChatGptSettingsLink />
            </p>
          ) : null}
        </div>
      ) : null}
      {signedIn || waiting ? null : (
        <div>
          <Button
            disabled={busy}
            onClick={onSignIn}
            size="sm"
            type="button"
            variant="outline"
          >
            {provider.mark && markFor(provider.mark) ? (
              <HarnessMark
                className="size-4"
                id={provider.mark}
                name={provider.name}
              />
            ) : null}
            {busy ? "Starting…" : `Sign in with ${signInName}`}
          </Button>
        </div>
      )}
      {/* ChatGPT's other way in, below the one chosen, before a sign-in starts. */}
      {signedIn || waiting || !chatGptServer ? null : (
        <div className="flex flex-col items-start gap-1 border-border border-t pt-3">
          <p className="text-muted-foreground text-xs">
            {desktopListens
              ? chatGptWay === "code"
                ? "Your browser can sign in instead. It finishes on its own once you approve."
                : "You can also sign in with a code. It needs device code sign-in turned on in ChatGPT."
              : chatGptWay === "code"
                ? "Can't turn on device code sign-in? Your browser can sign in instead. Its last page won't load, and you paste that page's address here."
                : "A code never shows a page that won't load. It needs device code sign-in turned on in ChatGPT."}
          </p>
          {/* Its words line up with the lines above; the ghost button's padding hangs outside. */}
          <Button
            className="-ml-2.5"
            disabled={busy}
            onClick={() =>
              onChatGptWay(chatGptWay === "code" ? "browser" : "code")
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {chatGptWay === "code"
              ? desktopListens
                ? "Sign in with your browser instead"
                : "Copy an address instead"
              : "Sign in with a code instead"}
          </Button>
        </div>
      )}
      {/* A code the server refused while the sign-in waits on; ChatGPT's paste box says it itself. */}
      {failure && waiting && !chatGptInBrowser ? (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/**
 * At the top of the organization's chooser, for an admin whose own AI is a plan or a sign-in the
 * server keeps for them: share it as it is, in one press, with what that does said first.
 */
function ShareMine({
  busy,
  login,
  onShare,
  provider,
}: {
  busy: boolean;
  login: AiConnectionLogin;
  onShare: () => void;
  provider: AiProvider | undefined;
}) {
  if (!provider) return null;
  const words = signInWords(provider.id, login);
  return (
    <Item size="sm" variant="muted">
      <ProviderTile provider={provider} />
      <ItemContent>
        <ItemTitle>Your {words}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {shareNote(provider.id, login)}
        </ItemDescription>
      </ItemContent>
      <ItemFooter className="pl-11">
        <Button disabled={busy} onClick={onShare} size="sm" type="button">
          {busy
            ? `Checking with ${provider.name}…`
            : `Use my ${words} for everyone`}
        </Button>
      </ItemFooter>
    </Item>
  );
}

/** The connection now in use, as a row with a tick. */
export function ConnectedRow({
  connection,
  owner = "you",
}: {
  connection: AiConnection;
  owner?: AiConnectionOwner;
}) {
  // Who is reading, only to say "your" of a sign-in they shared themselves.
  const viewer = useQuery({
    ...currentUserQueryOptions(),
    enabled: Boolean(connection.sharedSignIn),
  }).data;
  const described = describeConnection(connection, owner, viewer?.id);
  return (
    <Item role="status" size="sm" variant="muted">
      <ProviderTile provider={providerById(connection.provider)} />
      <ItemContent>
        <ItemTitle>{described?.provider}</ItemTitle>
        <ItemDescription>{described?.summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconCircleCheckFilled
          aria-label="Connected"
          className="size-5 text-success"
        />
      </ItemActions>
    </Item>
  );
}

/** A dialog's last step: what is connected now, and Done. */
export function Connected({
  connection,
  desktopProblem,
  onClose,
  owner = "you",
}: {
  connection: AiConnection;
  desktopProblem: string | null;
  onClose: () => void;
  owner?: AiConnectionOwner;
}) {
  const described = describeConnection(connection);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Connected to {described?.provider ?? "your AI"}
        </DialogTitle>
        <DialogDescription>
          {owner === "organization"
            ? "Bots use it for anyone in your organization who hasn't connected their own AI."
            : "Your next message runs on it. Anything already running finishes on the connection it started with."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        <ConnectedRow connection={connection} owner={owner} />
        {desktopProblem ? (
          <p className="text-destructive" role="alert">
            {desktopProblem}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button onClick={onClose} size="sm">
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
