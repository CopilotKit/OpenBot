import {
  IconChevronRight,
  IconCircleCheckFilled,
  IconCloud,
  IconExternalLink,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
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
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeConnection } from "@/lib/ai-connection/describe";
import {
  beginPlanSignIn,
  beginProviderSignIn,
  cancelPlanSignIn,
  cancelProviderSignIn,
  finishPlanSignIn,
  finishProviderSignIn,
  type Plan,
} from "@/lib/ai-connection/desktop";
import {
  type ConnectPhase,
  connectAiMutationOptions,
} from "@/lib/ai-connection/mutations";
import {
  AI_PROVIDERS,
  type AiProvider,
  ENDPOINT_PRESETS,
  hostOf,
  isEndpointAddress,
  loginsHere,
  providerById,
} from "@/lib/ai-connection/providers";
import {
  aiConnectionQueryOptions,
  desktopAiSupportQueryOptions,
} from "@/lib/ai-connection/queries";
import type {
  AiConnection,
  AiConnectionInput,
  AiConnectionLogin,
} from "@/lib/api/generated/model";
import { describeAiConnection } from "@/lib/desktop/ai-connection";
import { changeAiConnectionMutationOptions } from "@/lib/desktop/mutations";
import {
  type DesktopAiConnection,
  desktopAiConnectionQueryOptions,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { markFor } from "@/lib/marks";
import { queryClient } from "@/query-client";

/**
 * Settings → General's AI model: the AI provider OpenBot's Bots run on and how OpenBot signs in to
 * it, with a dialog that changes it while OpenBot keeps running. Never the key itself.
 *
 * Drawn where the server says an admin can change it here (getAiConnection's `editable`). Keys and
 * addresses work in any browser; a plan or a provider sign-in only inside OpenBot Desktop, which
 * holds and renews what they sign in with. An OpenBot older than this operation, or a Desktop older
 * than changing it in place, keeps the row from before: Change there stops OpenBot and opens the
 * setup window.
 */
export function AiModelSection() {
  const connection = useQuery(aiConnectionQueryOptions());
  const support = useQuery(desktopAiSupportQueryOptions());
  if (connection.isPending || support.isPending) return null;
  if (
    connection.error ||
    support.error ||
    connection.data === null ||
    support.data === "older"
  )
    return <DesktopAiModelSection />;
  if (!connection.data.editable) return null;
  return (
    <PageSection
      description="Choose the AI provider your Bots use and how OpenBot signs in to it."
      title="AI model"
    >
      <PageRows>
        <AiConnectionRow
          connection={connection.data}
          inDesktop={support.data === "in-place"}
        />
      </PageRows>
    </PageSection>
  );
}

/** A provider's mark on the row's tile, or a cloud for the row that stands for every provider. */
function ProviderTile({ provider }: { provider: AiProvider | undefined }) {
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

function AiConnectionRow({
  connection,
  inDesktop,
}: {
  connection: AiConnection;
  inDesktop: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A new dialog each time it opens, so nothing typed into the last one is kept.
  const [opened, setOpened] = useState(0);
  const described = describeConnection(connection);
  return (
    <>
      <Item
        render={
          <button
            onClick={() => {
              setOpened((count) => count + 1);
              setOpen(true);
            }}
            type="button"
          />
        }
        size="sm"
      >
        <ProviderTile provider={providerById(connection.provider)} />
        <ItemContent>
          <ItemTitle>{described?.provider ?? "Not chosen yet"}</ItemTitle>
          <ItemDescription>
            {described?.summary ?? "Choose the AI your Bots use."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <AiConnectionDialog
          connection={connection}
          inDesktop={inDesktop}
          key={opened}
          onClose={() => setOpen(false)}
        />
      </Dialog>
    </>
  );
}

type Step =
  | { at: "current" }
  | { at: "choose" }
  | { at: "done"; connection: AiConnection; desktopProblem: string | null };

function AiConnectionDialog({
  connection,
  inDesktop,
  onClose,
}: {
  connection: AiConnection;
  inDesktop: boolean;
  onClose: () => void;
}) {
  const described = describeConnection(connection);
  const [step, setStep] = useState<Step>(
    described ? { at: "current" } : { at: "choose" },
  );
  if (step.at === "done")
    return (
      <DialogContent>
        <Connected
          connection={step.connection}
          desktopProblem={step.desktopProblem}
          onClose={onClose}
        />
      </DialogContent>
    );
  if (step.at === "choose")
    return (
      <DialogContent>
        <ChooseConnection
          connection={connection}
          inDesktop={inDesktop}
          onBack={described ? () => setStep({ at: "current" }) : onClose}
          onConnected={(next) => setStep({ at: "done", ...next })}
        />
      </DialogContent>
    );
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>AI connection</DialogTitle>
        <DialogDescription>
          {described
            ? `Your Bots use ${described.provider}. OpenBot keeps the key or sign-in and never shows it.`
            : "Your Bots don't have an AI provider yet."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        {described && <Details details={described.details} />}
        <p className="text-muted-foreground">
          You can switch to another provider or key while OpenBot keeps running.
          Your next message uses the new connection.
        </p>
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button onClick={() => setStep({ at: "choose" })} size="sm">
          Change
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function Details({ details }: { details: { label: string; value: string }[] }) {
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

/** A sign-in in the browser, while it waits for the person to approve it there. */
type Waiting = { url: string; code?: string | null; attemptId?: string };

function ChooseConnection({
  connection,
  inDesktop,
  onBack,
  onConnected,
}: {
  connection: AiConnection;
  inDesktop: boolean;
  onBack: () => void;
  onConnected: (connected: {
    connection: AiConnection;
    desktopProblem: string | null;
  }) => void;
}) {
  const [providerId, setProviderId] = useState<AiProvider["id"] | null>(null);
  const provider = providerById(providerId);
  const logins = provider ? loginsHere(provider, inDesktop) : [];
  const [login, setLogin] = useState<AiConnectionLogin | null>(null);
  const preset = provider ? ENDPOINT_PRESETS[provider.id] : undefined;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [useSaved, setUseSaved] = useState(true);
  const [phase, setPhase] = useState<ConnectPhase>("checking");
  // A sign-in in the browser: waiting for it, done, or failed with Desktop's sentence.
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [signInCode, setSignInCode] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [signInFailure, setSignInFailure] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // The key an Unbiased AI sign-in mints: held for the one request that sends it, never drawn.
  const minted = useRef<string | null>(null);
  const attempt = useRef<{ plan?: Plan; attemptId?: string } | null>(null);
  const run = useRef(0);
  const connect = useMutation(connectAiMutationOptions(queryClient));

  /** Stop a sign-in still waiting in the browser, so its tab can't finish into a closed dialog. */
  function stopSignIn() {
    run.current += 1;
    const pending = attempt.current;
    attempt.current = null;
    if (pending?.plan) void cancelPlanSignIn(pending.plan).catch(() => {});
    if (pending?.attemptId)
      void cancelProviderSignIn(pending.attemptId).catch(() => {});
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
    const nextLogins = next ? loginsHere(next, inDesktop) : [];
    setLogin(nextLogins[0] ?? null);
    const nextPreset = next ? ENDPOINT_PRESETS[next.id] : undefined;
    setApiKey("");
    setBaseUrl(nextPreset?.baseUrl ?? "");
    setModel(nextPreset?.model ?? "");
    setUseSaved(true);
    setSignedIn(false);
    setSignInFailure(null);
    setSignInCode("");
    minted.current = null;
  }

  function chooseLogin(next: AiConnectionLogin) {
    if (next === login) return;
    stopSignIn();
    connect.reset();
    setSignedIn(false);
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

  async function signIn() {
    if (!provider || !login) return;
    stopSignIn();
    const mine = run.current;
    const current = () => run.current === mine;
    setSigningIn(true);
    setSignInFailure(null);
    setSignedIn(false);
    try {
      if (login === "plan") {
        const plan: Plan = provider.id === "anthropic" ? "claude" : "chatgpt";
        attempt.current = { plan };
        const { url } = await beginPlanSignIn(plan);
        if (!current()) return;
        setWaiting({ url });
        window.open(url, "_blank", "noopener");
        // Claude's sign-in hands back a code to paste here; ChatGPT's finishes in the browser.
        if (plan === "claude") {
          setSigningIn(false);
          return;
        }
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

  async function finishClaude() {
    const mine = run.current;
    setSigningIn(true);
    setSignInFailure(null);
    try {
      await finishPlanSignIn("claude", signInCode.trim());
      if (run.current !== mine) return;
      attempt.current = null;
      setWaiting(null);
      setSignInCode("");
      setSignedIn(true);
    } catch (error) {
      if (run.current !== mine) return;
      // A refused code ends the attempt: the sign-in starts again.
      attempt.current = null;
      setWaiting(null);
      setSignInFailure(
        error instanceof Error ? error.message : "Couldn't sign in. Try again.",
      );
    } finally {
      if (run.current === mine) setSigningIn(false);
    }
  }

  function submit() {
    const body = input();
    if (!ready || !body || connect.isPending) return;
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

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Change AI connection</DialogTitle>
        <DialogDescription>
          {provider
            ? "OpenBot checks the connection before it switches. Nothing changes if the check fails."
            : "Choose the AI your Bots use. OpenBot keeps running while it switches."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-4 overflow-y-auto">
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
                <ItemDescription>
                  {inDesktop ? row.summary : row.keySummary}
                </ItemDescription>
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
                login={login}
                onCancel={stopSignIn}
                onCode={setSignInCode}
                onFinishCode={finishClaude}
                onSignIn={signIn}
                provider={provider}
                signedIn={signedIn}
                waiting={waiting}
              />
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
            {connect.error.message}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button
          disabled={busy}
          onClick={() => {
            stopSignIn();
            onBack();
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {provider ? "Back" : "Cancel"}
        </Button>
        {provider ? (
          <Button disabled={!ready || busy} size="sm" type="submit">
            {busy ? pendingLabel : "Connect"}
          </Button>
        ) : null}
      </DialogFooter>
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

function SignInFields({
  busy,
  code,
  failure,
  login,
  onCancel,
  onCode,
  onFinishCode,
  onSignIn,
  provider,
  signedIn,
  waiting,
}: {
  busy: boolean;
  code: string;
  failure: string | null;
  login: "plan" | "oauth";
  onCancel: () => void;
  onCode: (code: string) => void;
  onFinishCode: () => void;
  onSignIn: () => void;
  provider: AiProvider;
  signedIn: boolean;
  waiting: Waiting | null;
}) {
  const claude = login === "plan" && provider.id === "anthropic";
  const signInName = provider.id === "google" ? "Google" : provider.name;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {SIGN_IN_SAYS[provider.id]}
      </p>
      {signedIn ? (
        <p className="flex items-center gap-2 text-sm">
          <IconCircleCheckFilled className="size-4 text-emerald-600 dark:text-emerald-400" />
          Signed in to {provider.name}.
        </p>
      ) : waiting ? (
        <div className="flex flex-col gap-3">
          {waiting.code ? (
            <p className="text-sm">
              Verification code:{" "}
              <strong className="font-mono">{waiting.code}</strong>
            </p>
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
          {claude ? (
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
                  onClick={onFinishCode}
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
          <div>
            <Button onClick={onCancel} size="sm" type="button" variant="ghost">
              Cancel sign-in
            </Button>
          </div>
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
      {failure ? (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function Connected({
  connection,
  desktopProblem,
  onClose,
}: {
  connection: AiConnection;
  desktopProblem: string | null;
  onClose: () => void;
}) {
  const described = describeConnection(connection);
  const provider = providerById(connection.provider);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Connected to {described?.provider ?? "your AI"}
        </DialogTitle>
        <DialogDescription>
          Your next message runs on it. Anything already running finishes on the
          connection it started with.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        <Item role="status" size="sm" variant="muted">
          <ProviderTile provider={provider} />
          <ItemContent>
            <ItemTitle>{described?.provider}</ItemTitle>
            <ItemDescription>{described?.summary}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconCircleCheckFilled
              aria-label="Connected"
              className="size-5 text-emerald-600 dark:text-emerald-400"
            />
          </ItemActions>
        </Item>
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

/**
 * The row from before changing the connection in place: in an OpenBot Desktop older than that, or
 * against an OpenBot server that doesn't offer it. Change there stops OpenBot and opens Desktop's
 * own setup window. Only inside Desktop; a plain browser draws nothing here.
 */
function DesktopAiModelSection() {
  const connection = useQuery(desktopAiConnectionQueryOptions());
  if (desktopShell() === null || !connection.data) return null;
  return (
    <PageSection
      description="Choose the AI provider your Bots use and how OpenBot signs in to it."
      title="AI model"
    >
      <PageRows>
        <DesktopAiConnectionRow connection={connection.data} />
      </PageRows>
    </PageSection>
  );
}

function DesktopAiConnectionRow({
  connection,
}: {
  connection: DesktopAiConnection;
}) {
  const [open, setOpen] = useState(false);
  const change = useMutation(changeAiConnectionMutationOptions());
  const described = describeAiConnection(connection);
  // On success the desktop app is stopping OpenBot, and this page goes with it.
  const stopping = change.isPending || change.isSuccess;
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconSparkles />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{described?.provider ?? "Not chosen yet"}</ItemTitle>
          <ItemDescription>
            {described?.summary ?? "Choose the AI your Bots use."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI connection</DialogTitle>
            <DialogDescription>
              {described
                ? `Your Bots use ${described.provider}. Your key or sign-in stays on this computer.`
                : "Your Bots don't have an AI provider yet."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
            {described && <Details details={described.details} />}
            <p className="text-muted-foreground">
              To change it, OpenBot stops and the setup window opens. OpenBot
              starts again with the connection you choose there.
            </p>
            {change.error ? (
              <p className="text-destructive" role="alert">
                Couldn't open the setup window. Try again.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={stopping}
              onClick={() => change.mutate()}
              size="sm"
            >
              {stopping ? "Stopping OpenBot…" : "Change AI connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
