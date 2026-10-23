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
  CONFIRM_WINDOW_MS,
  connectRefusalSentence,
  type DetectedRecorder,
  detectRecorder,
  sendConnectCode,
} from "@/lib/recorder/bridge";
import { mintRecorderConnectCode } from "@/lib/recorder/mutations";
import {
  recorderConnectionsQueryOptions,
  recorderKeys,
} from "@/lib/recorder/queries";
import { queryClient } from "@/query-client";

type Attempt =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "awaiting" }
  | { state: "expired" }
  | { state: "failed"; message: string };

/** Whether the Recorder in this browser is installed, and connected to this OpenBot as you. `onInstallId` hears this
 * browser's own copy once it is known (it answers with it only once connected), so the list of connected browsers can
 * say which row is this one. */
export function ThisBrowser({
  onInstallId,
}: {
  onInstallId?: (installId: string | undefined) => void;
} = {}) {
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

  useEffect(() => {
    onInstallId?.(installId);
  }, [installId, onInstallId]);

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
          message: connectRefusalSentence(answer.error, answer.retryAfterMs),
        });
        return;
      }
      setConnectedAs(answer.installId);
      if (answer.connected) {
        // A trusted OpenBot: connected already, with no Connect page to wait on. The new connection is read before the
        // row stops saying it is connecting, so it goes straight to Connected.
        await queryClient.invalidateQueries({ queryKey: recorderKeys.all });
        setAttempt({ state: "idle" });
        return;
      }
      setAttempt({ state: "awaiting" });
    } catch (error) {
      setAttempt({
        state: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Couldn't connect this browser.",
      });
    }
  }

  return (
    <PageSection title="This browser">
      {connections.error ? (
        <p className="text-destructive text-sm" role="alert">
          Couldn't check whether this browser is connected. Reload the page.
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
  if (!detected) return "The OpenBot Recorder isn't installed in this browser.";
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
