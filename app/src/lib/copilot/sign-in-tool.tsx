import { IconLock } from "@tabler/icons-react";
import { useState } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readSignIn, requestSignIn } from "@/lib/passwords/mutations";
import { FINAL_SIGN_IN } from "@/lib/passwords/queries";
import { useActiveBotHolder } from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { useComputerAvailable } from "./computer-available";

/** How long the open chat waits for the person to answer. The server's request lasts as long. */
const WAIT_MS = 15 * 60_000;
const POLL_MS = 1_500;

/** Must match SIGN_IN_TOOL_DESCRIPTION in server/src/computer/headless-tools.ts. */
const DESCRIPTION =
  "Ask the person you work for to sign you in to a website. They get a private sign-in form outside this conversation (or take over the browser), and their login is typed straight into your browser by the computer. You never see the username, password or code, and must never ask for them any other way. Open the site's sign-in page first, then call this with the site's address. This turn pauses until they answer; you are then told only whether it worked.";

type Outcome = {
  ok?: boolean;
  signedIn?: boolean;
  site?: string;
  requestId?: string;
  result?: string;
  reason?: string;
};

function parse(result: string | undefined): Outcome {
  if (!result) return {};
  try {
    const value = JSON.parse(result) as unknown;
    return value && typeof value === "object" ? (value as Outcome) : {};
  } catch {
    return {};
  }
}

/**
 * The open chat's half of `computer_request_sign_in`.
 *
 * The handler opens the request and waits on it; the render draws a card whose button opens the
 * private form in a dialog. The form posts to the server, never into this tool call, so neither the
 * arguments nor the result the model reads ever carry a credential. An unattended turn uses the
 * headless tool of the same name, and its owner gets the form as a link on their delivery channels.
 */
export function SignInTool() {
  const bot = useActiveBotHolder();
  // The request the handler opened, so the render can show its form before the call finishes.
  const [pending, setPending] = useState<Record<string, string>>({});
  // A sign-in is typed into the Bot's computer; see useComputerAvailable.
  const available = useComputerAvailable();
  useFrontendTool({
    available,
    name: "computer_request_sign_in",
    description: DESCRIPTION,
    parameters: z.object({
      site: z
        .string()
        .describe("The website's address, e.g. https://example.com"),
      reason: z
        .string()
        .optional()
        .describe("Why you need to be signed in, in a few words"),
    }),
    handler: async (
      input: { site: string; reason?: string },
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const asked = await requestSignIn(
        {
          botId: bot.current,
          site: input.site,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
        },
        signal,
      );
      if (!asked.ok) return { ok: false, reason: asked.reason };
      const id = asked.request.id;
      if (toolCall?.id) {
        const callId = toolCall.id;
        setPending((current) => ({ ...current, [callId]: id }));
      }
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        if (signal?.aborted)
          return {
            ok: false,
            requestId: id,
            result: "The request was stopped.",
          };
        const state = await readSignIn(id, signal);
        if (state && FINAL_SIGN_IN.includes(state.status))
          return {
            ok: state.status === "signed_in",
            signedIn: state.status === "signed_in",
            site: state.origin,
            requestId: id,
            result:
              state.outcome ??
              (state.status === "signed_in"
                ? `Signed in to ${state.origin}.`
                : `The sign-in to ${state.origin} did not complete.`),
            note: "You were not told the credentials and must never ask for them another way.",
          };
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return {
        ok: false,
        requestId: id,
        result: "Nobody signed in. Do not ask for the login another way.",
      };
    },
    render: ({ args, result, status, toolCallId }) => {
      const outcome = parse(result);
      const requestId =
        outcome.requestId ?? (toolCallId ? pending[toolCallId] : undefined);
      return (
        <SignInCard
          site={typeof args?.site === "string" ? args.site : ""}
          requestId={requestId}
          running={status !== "complete"}
          outcome={outcome}
        />
      );
    },
  });
  return null;
}

function SignInCard({
  site,
  requestId,
  running,
  outcome,
}: {
  site: string;
  requestId?: string;
  running: boolean;
  outcome: Outcome;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <ToolLine
        label={
          running
            ? "Waiting for you to sign in"
            : outcome.signedIn
              ? "Signed in"
              : "Sign-in did not complete"
        }
        detail={site}
        running={running}
        failed={!running && !outcome.signedIn}
      >
        {!running && (outcome.result ?? outcome.reason) ? (
          <p className="text-muted-foreground text-sm">
            {outcome.result ?? outcome.reason}
          </p>
        ) : undefined}
      </ToolLine>
      {/* Outside the line, so the one thing the person must do is not behind a disclosure. */}
      {running && requestId ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            <IconLock />
            Open private sign-in
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Sign in to {site}</DialogTitle>
                <DialogDescription>
                  Goes to your Bot's browser, not into this conversation.
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="mt-4 overflow-y-auto">
                <SignInForm requestId={requestId} />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
