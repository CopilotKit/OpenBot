import { IconBrowser } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  type DetectedRecorder,
  detectRecorder,
  sendConnectCode,
} from "@/lib/recorder/bridge";
import { mintRecorderConnectCode } from "@/lib/recorder/mutations";
import { recorderConnectionsQueryOptions } from "@/lib/recorder/queries";

/** How long a connect request waits for the person to confirm it in the Recorder's tab. */
const CONFIRM_WINDOW_MS = 5 * 60_000;

const REFUSALS: Record<string, string> = {
  "not-https": "The Recorder only connects to OpenBot over HTTPS.",
  "pinned-elsewhere": "Your organization set the Recorder to another OpenBot.",
  "policy-invalid":
    "Your organization's Recorder policy names an OpenBot address the Recorder cannot use. Ask your IT team.",
  busy: "The Recorder is finishing another connect request. Try again in a moment.",
};
/** The Recorder can also answer `unreachable` or `invalid`, which have no sentence of their own. */
const REFUSAL_FALLBACK = "The Recorder did not accept the request. Try again.";

/** The Recorder takes only so many connects from one OpenBot in ten minutes; its refusal says how long is left. */
function throttledSentence(retryAfterMs: number | undefined): string {
  const lead = "Too many connect requests in a short time.";
  if (retryAfterMs === undefined) return `${lead} Try again in a few minutes.`;
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `${lead} Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

function refusalSentence(error: string, retryAfterMs?: number): string {
  if (error === "throttled") return throttledSentence(retryAfterMs);
  return REFUSALS[error] ?? REFUSAL_FALLBACK;
}

type Attempt =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "awaiting" }
  | { state: "expired" }
  | { state: "failed"; message: string };

/** Whether the Recorder in this browser is installed, and connected to this OpenBot as you. */
export function ThisBrowser() {
  const [attempt, setAttempt] = useState<Attempt>({ state: "idle" });
  // The install id the connect answer carried: a copy only reports its own once connected.
  const [connectedAs, setConnectedAs] = useState<string | undefined>();
  const awaiting = attempt.state === "awaiting";
  const connections = useQuery(recorderConnectionsQueryOptions({ awaiting }));
  const ids = connections.data?.extensionIds;
  const idsKey = ids?.join(",");
  // `undefined` while asking, `null` when no Recorder answered.
  const [detected, setDetected] = useState<
    DetectedRecorder | null | undefined
  >();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the id list, so a refetch with the same ids does not ask again
  useEffect(() => {
    if (!ids) return;
    let current = true;
    void detectRecorder(ids).then((found) => {
      if (current) setDetected(found);
    });
    return () => {
      current = false;
    };
  }, [idsKey]);

  const installId = detected?.installId ?? connectedAs;
  const connected =
    installId !== undefined &&
    (connections.data?.connections.some((c) => c.installId === installId) ??
      false);

  // Once the connection appears the wait is over, so polling stops.
  useEffect(() => {
    if (connected && awaiting) setAttempt({ state: "idle" });
  }, [connected, awaiting]);

  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(
      () => setAttempt({ state: "expired" }),
      CONFIRM_WINDOW_MS,
    );
    return () => clearTimeout(timer);
  }, [awaiting]);

  async function connect() {
    if (!detected) return;
    setAttempt({ state: "sending" });
    try {
      const { code } = await mintRecorderConnectCode();
      const answer = await sendConnectCode(detected.id, code);
      if (!answer.ok) {
        setAttempt({
          state: "failed",
          message: refusalSentence(answer.error, answer.retryAfterMs),
        });
        return;
      }
      setConnectedAs(answer.installId);
      setAttempt({ state: "awaiting" });
    } catch (error) {
      setAttempt({
        state: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Could not connect this browser.",
      });
    }
  }

  return (
    <PageSection title="This browser">
      {connections.error ? (
        <p className="text-destructive text-sm" role="alert">
          Could not check whether this browser is connected.
        </p>
      ) : detected === undefined ? null : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconBrowser />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>OpenBot Recorder</ItemTitle>
              <ItemDescription>
                {describe(detected, connected, attempt)}
              </ItemDescription>
            </ItemContent>
            {detected && !connected ? (
              <ItemActions>
                <Button
                  size="sm"
                  disabled={attempt.state === "sending" || awaiting}
                  onClick={() => void connect()}
                >
                  Connect this browser
                </Button>
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
      )}
    </PageSection>
  );
}

function describe(
  detected: DetectedRecorder | null,
  connected: boolean,
  attempt: Attempt,
): string {
  if (!detected)
    return "The OpenBot Recorder is not installed in this browser.";
  if (connected) return "Connected";
  switch (attempt.state) {
    case "awaiting":
      return "Confirm in the OpenBot Recorder tab that opened.";
    case "expired":
      return "The request expired. Try again.";
    case "failed":
      return attempt.message;
    default:
      return "Installed. Connect it to record tasks for your Bots.";
  }
}
