import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, GalleryFrame } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import {
  AGENT_OAUTH_CALLBACK_MESSAGE,
  AGENT_OAUTH_CALLBACK_PATH,
  callbackMatches,
  completedAuthConfig,
  consentUrl,
  type CredentialRequest,
  readConnectionOutcome,
  readCredentialRequest,
} from "@/lib/copilot/adk-credential";

/**
 * A remote agent asking to act as this person somewhere else.
 *
 * The card names the provider and what is asked for, and the person either signs in or declines.
 * Sign-in happens in a popup rather than by leaving the page: the run that asked is suspended in
 * this tab, and navigating away would abandon it. The popup ends on our own callback page, which
 * posts the provider's answer back here (see the callback route in server/src/agents/routes.ts);
 * the answer resumes the run, and the agent exchanges it for a token on its own side. No token
 * ever reaches this card.
 */

type Waiting =
  | {
      status: "inProgress";
      args: Record<string, unknown>;
      respond: undefined;
      result: undefined;
    }
  | {
      status: "executing";
      args: Record<string, unknown>;
      respond: (result: unknown) => Promise<void>;
      result: undefined;
    }
  | {
      status: "complete";
      args: Record<string, unknown>;
      respond: undefined;
      result: string;
    };

const TITLE = "Sign in for this agent";

export function AgentConsentCard(props: Waiting) {
  const request = readCredentialRequest(props.args);

  if (props.status === "inProgress") {
    return (
      <GalleryFrame title={TITLE}>
        <p className="text-sm text-muted-foreground">Preparing the request…</p>
      </GalleryFrame>
    );
  }

  if (props.status === "complete") {
    const outcome = readConnectionOutcome(props.result);
    return (
      <GalleryFrame
        action={
          outcome === "connected" ? (
            <Badge tone="positive">Signed in</Badge>
          ) : outcome === "declined" ? (
            <Badge tone="negative">Declined</Badge>
          ) : undefined
        }
        title={TITLE}
      >
        <p className="text-sm text-muted-foreground">
          {request
            ? outcome === "connected"
              ? `You signed in with ${request.provider} for this agent.`
              : `The agent asked you to sign in with ${request.provider}.`
            : "The agent asked for a sign-in."}
        </p>
      </GalleryFrame>
    );
  }

  if (!request) {
    return <UnanswerableRequest args={props.args} respond={props.respond} />;
  }

  return <ConsentPrompt request={request} respond={props.respond} />;
}

function ConsentPrompt({
  request,
  respond,
}: {
  request: CredentialRequest;
  respond: (result: unknown) => Promise<void>;
}) {
  const [phase, setPhase] = useState<
    "idle" | "waiting" | "abandoned" | "blocked" | "sending"
  >("idle");
  const popup = useRef<Window | null>(null);
  // One redirect for the whole exchange: the provider must be told the same address during sign-in
  // and during the agent's later token exchange, so it is minted once and travels into both.
  const redirectUri = useRef<string>(
    `${window.location.origin}${AGENT_OAUTH_CALLBACK_PATH}`,
  );

  const finish = useCallback(
    async (callbackUrl: string) => {
      setPhase("sending");
      popup.current?.close();
      await respond(
        completedAuthConfig(
          request.authConfig,
          callbackUrl,
          redirectUri.current,
        ),
      );
    },
    [request, respond],
  );

  // The callback page posts to whoever opened it. Same origin only, matched to this request by the
  // OAuth state, so two waiting cards cannot take each other's answer.
  useEffect(() => {
    if (phase !== "waiting") return;
    const heard = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== AGENT_OAUTH_CALLBACK_MESSAGE) return;
      if (typeof data.url !== "string") return;
      if (!callbackMatches(data.url, request.state)) return;
      void finish(data.url);
    };
    window.addEventListener("message", heard);
    // A closed popup means the person walked away from the provider's page. The card says so and
    // offers the button again rather than waiting forever on a window that no longer exists.
    const watch = window.setInterval(() => {
      if (popup.current?.closed) {
        setPhase((current) => (current === "waiting" ? "abandoned" : current));
      }
    }, 1000);
    return () => {
      window.removeEventListener("message", heard);
      window.clearInterval(watch);
    };
  }, [phase, request.state, finish]);

  const connect = () => {
    const opened = window.open(
      consentUrl(request, redirectUri.current),
      "openbot-agent-consent",
      "popup,width=480,height=720",
    );
    if (!opened) {
      setPhase("blocked");
      return;
    }
    popup.current = opened;
    setPhase("waiting");
  };

  const decline = async () => {
    setPhase("sending");
    // The config goes back exactly as it came. With no answer URL inside, the agent's exchange
    // finds nothing to redeem and the tool fails with an auth error it can tell the person about.
    await respond(request.authConfig);
  };

  return (
    <GalleryFrame
      action={<Badge tone="caution">Waiting on you</Badge>}
      title={TITLE}
    >
      <p className="text-sm">
        This agent asks you to sign in with{" "}
        <span className="font-medium">{request.provider}</span> so it can act on
        your behalf there.
      </p>

      {request.scopes.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {request.scopes.map((scope) => (
            <li className="text-xs text-muted-foreground" key={scope}>
              {scope}
            </li>
          ))}
        </ul>
      ) : null}

      {phase === "abandoned" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The sign-in window was closed before finishing. You can try again.
        </p>
      ) : null}
      {phase === "blocked" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The browser blocked the sign-in window. Allow popups for this site and
          try again.
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <Button
          disabled={phase === "waiting" || phase === "sending"}
          onClick={connect}
          size="sm"
        >
          {phase === "waiting"
            ? "Waiting for sign-in…"
            : phase === "sending"
              ? "Sending…"
              : `Sign in with ${request.provider}`}
        </Button>
        <Button
          disabled={phase === "sending"}
          onClick={() => void decline()}
          size="sm"
          variant="outline"
        >
          Decline
        </Button>
      </div>
    </GalleryFrame>
  );
}

/**
 * A request the card cannot act on: no authorization URL to send anybody to.
 *
 * The run is still suspended on this call, so it must be answered to let the conversation
 * continue. What came in goes back unchanged — the agent's own parser recognizes its own config,
 * and a made-up shape would fail inside the agent instead of in front of the person.
 */
function UnanswerableRequest({
  args,
  respond,
}: {
  args: Record<string, unknown>;
  respond: (result: unknown) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const echo =
    (args.authConfig as Record<string, unknown> | undefined) ??
    (args.auth_config as Record<string, unknown> | undefined) ??
    args;
  return (
    <GalleryFrame
      action={<Badge tone="negative">Cannot sign in</Badge>}
      title={TITLE}
    >
      <p className="text-sm text-muted-foreground">
        The agent asked for a sign-in but did not say where. Dismissing tells it
        no sign-in happened.
      </p>
      <div className="mt-4">
        <Button
          disabled={sending}
          onClick={() => {
            setSending(true);
            void respond(echo);
          }}
          size="sm"
          variant="outline"
        >
          {sending ? "Sending…" : "Dismiss"}
        </Button>
      </div>
    </GalleryFrame>
  );
}
