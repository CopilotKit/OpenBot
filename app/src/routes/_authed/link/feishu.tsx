import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { savePendingAuthReturn } from "@/lib/auth/pending-return";
import { tryClient } from "@/lib/client";

type FeishuClaim = { workspace: string; user: string; email?: string };
type FeishuLinkFailure = { kind: "error"; message: string };
type FeishuLinkCompletion = ReturnType<typeof feishuLinkResult>;
type FeishuLinkReauth = { kind: "reauth" };
type FeishuLinkResponse =
  | FeishuLinkCompletion
  | FeishuLinkFailure
  | FeishuLinkReauth;
type ClaimState =
  | { kind: "loading" }
  | { kind: "ready"; claim: FeishuClaim }
  | { kind: "terminal"; outcome: FeishuLinkCompletion }
  | { kind: "error" };

class FeishuLinkTerminalError extends Error {
  constructor(readonly outcome: FeishuLinkCompletion) {
    super(outcome.message);
  }
}
class FeishuLinkReauthError extends Error {}

export const Route = createFileRoute("/_authed/link/feishu")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    const token = feishuLinkToken(search);
    return token ? { token } : {};
  },
  component: FeishuLinkPage,
});

/** A claim token is opaque: trim it for requests, but never render or cache it. */
export function feishuLinkToken(search: Record<string, unknown>): string | null {
  if (typeof search.token !== "string") return null;
  const token = search.token.trim();
  return token === "" ? null : token;
}

export function feishuLinkResult(status: number) {
  if (status === 200)
    return {
      kind: "linked",
      message: "Feishu is linked to your OpenBot account.",
    } as const;
  if (status === 409)
    return {
      kind: "conflict",
      message:
        "That Feishu identity is already linked to another OpenBot account.",
    } as const;
  return {
    kind: "invalid",
    message:
      "This Feishu link has expired or is invalid. Return to Feishu and try again.",
  } as const;
}

export function feishuLinkFailure(): FeishuLinkFailure {
  return {
    kind: "error",
    message: "Feishu could not be linked right now. Try again.",
  };
}

/** Only documented token refusals are terminal-invalid; unknown responses stay retryable. */
export function feishuLinkResponseOutcome(status?: number): FeishuLinkResponse {
  if (status === 401) return { kind: "reauth" };
  if (status === 200 || status === 400 || status === 409)
    return feishuLinkResult(status);
  return feishuLinkFailure();
}

/** Selects the only identity metadata this page may display. */
export function feishuLinkClaim(value: unknown): FeishuClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = value as {
    providerTenantId?: unknown;
    providerUserId?: unknown;
    providerEmail?: unknown;
  };
  const workspace = displayString(claim.providerTenantId);
  const user = displayString(claim.providerUserId);
  if (!workspace || !user) return null;
  if (claim.providerEmail === null) return { workspace, user };
  const email = displayString(claim.providerEmail);
  return email ? { workspace, user, email } : null;
}

function displayString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const display = value.trim();
  return display || null;
}

async function loadFeishuClaim(
  token: string,
  signal: AbortSignal,
  _attempt?: number,
): Promise<FeishuClaim> {
  const response = await tryClient(
    `/api/external-links/feishu?token=${encodeURIComponent(token)}`,
    { signal },
  );
  if (!response.ok) {
    const outcome = feishuLinkResponseOutcome(response.status);
    if (outcome.kind === "reauth") throw new FeishuLinkReauthError();
    if (outcome.kind !== "error") throw new FeishuLinkTerminalError(outcome);
    throw new Error("Could not load Feishu link.");
  }
  const claim = feishuLinkClaim(await response.json().catch(() => null));
  if (!claim) throw new Error("Could not read Feishu link.");
  return claim;
}

async function completeFeishuLink(
  token: string,
  signal: AbortSignal,
): Promise<FeishuLinkResponse> {
  const response = await tryClient("/api/external-links/feishu", {
    method: "POST",
    body: { token },
    signal,
  });
  return feishuLinkResponseOutcome(response.status);
}

function FeishuLinkPage() {
  const { token } = Route.useSearch();
  const reauthenticate = useCallback(() => {
    if (!token) return;
    savePendingAuthReturn(
      `/link/feishu?token=${encodeURIComponent(token)}`,
      window.sessionStorage,
    );
    window.location.assign("/sign");
  }, [token]);

  if (!token) return <TerminalOutcome outcome={feishuLinkResult(400)} />;

  // A new URL gets a new component lifetime, so no token-A state can render under token B.
  return (
    <FeishuLinkConfirmation
      key={token}
      onReauthenticate={reauthenticate}
      token={token}
    />
  );
}

export function FeishuLinkConfirmation({
  complete = completeFeishuLink,
  load = loadFeishuClaim,
  onReauthenticate,
  token,
}: {
  complete?: (token: string, signal: AbortSignal) => Promise<FeishuLinkResponse>;
  load?: (
    token: string,
    signal: AbortSignal,
    attempt: number,
  ) => Promise<FeishuClaim>;
  onReauthenticate: () => void;
  token: string;
}) {
  const [claim, setClaim] = useState<ClaimState>({ kind: "loading" });
  const [submission, setSubmission] = useState<
    FeishuLinkCompletion | FeishuLinkFailure | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [retry, setRetry] = useState(0);
  const submitting = useRef(false);
  const postController = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setClaim({ kind: "loading" });
    setSubmission(null);

    load(token, controller.signal, retry)
      .then((loaded) => {
        if (active && !controller.signal.aborted)
          setClaim({ kind: "ready", claim: loaded });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof FeishuLinkReauthError) return onReauthenticate();
        if (error instanceof FeishuLinkTerminalError) {
          setClaim({ kind: "terminal", outcome: error.outcome });
          return;
        }
        setClaim({ kind: "error" });
      });

    return () => {
      active = false;
      controller.abort();
      postController.current?.abort();
    };
  }, [retry, token, onReauthenticate, load]);

  const submit = () => {
    if (submitting.current) return;
    submitting.current = true;
    setIsSubmitting(true);
    const attempt = { generation: ++generation.current, token };
    const controller = new AbortController();
    postController.current = controller;
    setSubmission(null);

    complete(attempt.token, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return;
        if (outcome.kind === "reauth") return onReauthenticate();
        setSubmission(outcome);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSubmission(feishuLinkFailure());
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          attempt.generation === generation.current
        ) {
          submitting.current = false;
          setIsSubmitting(false);
        }
      });
  };

  if (claim.kind === "loading") return <LoadingPage />;
  if (claim.kind === "terminal")
    return <TerminalOutcome outcome={claim.outcome} />;
  if (claim.kind === "error") {
    return (
      <PageShell title="Link Feishu">
        <PageSection>
          <p className="text-destructive text-sm" role="alert">
            Feishu could not be checked right now. Try again.
          </p>
          <Button
            className="mt-4"
            onClick={() => setRetry((value) => value + 1)}
            type="button"
          >
            Try again
          </Button>
        </PageSection>
      </PageShell>
    );
  }
  if (submission && submission.kind !== "error")
    return <TerminalOutcome outcome={submission} />;

  return (
    <PageShell
      description="Confirm that this is the Feishu identity you want to link to your OpenBot account."
      title="Link Feishu"
    >
      <PageSection title="Feishu identity">
        <dl className="mt-4 rounded-lg border border-border bg-card text-sm">
          <ClaimField label="Feishu workspace" value={claim.claim.workspace} />
          <ClaimField label="Feishu user" value={claim.claim.user} />
          {claim.claim.email !== undefined ? (
            <ClaimField label="Feishu email" value={claim.claim.email} />
          ) : null}
        </dl>
      </PageSection>
      <PageSection>
        {submission ? (
          <p className="text-destructive text-sm" role="alert">
            {submission.message}
          </p>
        ) : null}
        <Button disabled={isSubmitting} onClick={submit} type="button">
          {isSubmitting ? "Linking Feishu…" : "Link Feishu"}
        </Button>
      </PageSection>
    </PageShell>
  );
}

function LoadingPage() {
  return (
    <PageShell
      description="Checking the Feishu identity that asked to be linked."
      title="Link Feishu"
    >
      <p className="mt-12 text-muted-foreground text-sm" role="status">
        Loading Feishu link…
      </p>
    </PageShell>
  );
}

function ClaimField({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border border-b px-4 py-3 last:border-b-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function TerminalOutcome({ outcome }: { outcome: FeishuLinkCompletion }) {
  return (
    <PageShell title="Link Feishu">
      <PageSection>
        <p
          className={
            outcome.kind === "linked" ? "text-sm" : "text-destructive text-sm"
          }
          role={outcome.kind === "linked" ? "status" : "alert"}
        >
          {outcome.message}
        </p>
      </PageSection>
    </PageShell>
  );
}
