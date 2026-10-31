import { IconBrowser } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { noteStoreTabOpened } from "@/components/browser/browser-nav-item";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
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
  type RecorderStore,
  recorderStorePageHere,
  sendConnectCode,
} from "@/lib/recorder/bridge";
import { mintRecorderConnectCode } from "@/lib/recorder/mutations";
import {
  recorderConnectionsQueryOptions,
  recorderConnectWaitQueryOptions,
  recorderKeys,
} from "@/lib/recorder/queries";
import { queryClient } from "@/query-client";

/** What the store's own button says, in the browser this page is open in. */
const ADD_TO: Record<RecorderStore, string> = {
  chrome: "Add to Chrome",
  edge: "Add to Edge",
};

/** `since`: when the awaited connect started. `cancelled` and `closed`: the person pressed Cancel on the Recorder's
 * Connect page, or closed it, which the Recorder says as soon as it is asked. */
type Attempt =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "awaiting"; since: number }
  | { state: "expired" }
  | { state: "cancelled" }
  | { state: "closed" }
  | { state: "failed"; message: string };

/** Whether the Recorder in this browser is installed, and connected to this OpenBot as you. `onInstallId` hears this
 * browser's own copy once it is known (it answers with it only once connected: not while its Connect page waits for
 * the person, since any site can ask to connect), so the list of connected browsers can say which row is this one. */
export function ThisBrowser({
  onInstallId,
}: {
  onInstallId?: (installId: string | undefined) => void;
} = {}) {
  const [attempt, setAttempt] = useState<Attempt>({ state: "idle" });
  // The install id a trusted OpenBot's connect answer carried: a copy only reports its own once connected.
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
    const look = () =>
      void detectRecorder(ids).then((found) => {
        if (current) setDetected(found);
      });
    look();
    // Asked again when the person comes back to the tab, which is when they will have added it from its store page.
    window.addEventListener("focus", look);
    return () => {
      current = false;
      window.removeEventListener("focus", look);
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

  // While the Recorder's Connect page waits, the Recorder is asked again each time the connections are: it says its
  // install id once the person has approved, and that id is what finds this browser's new connection in the list.
  const listedAt = connections.dataUpdatedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the list is, which `listedAt` stands for
  useEffect(() => {
    if (!awaiting || !ids) return;
    let current = true;
    void detectRecorder(ids).then((found) => {
      if (current && found?.installId) setDetected(found);
    });
    return () => {
      current = false;
    };
  }, [awaiting, idsKey, listedAt]);

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

  // While the Recorder's Connect page waits, the Recorder is asked where it has got to: a Cancel there, or the tab
  // closed, ends the wait at once, with Connect back.
  const wait = useQuery({
    ...recorderConnectWaitQueryOptions(
      detected?.id ?? "",
      attempt.state === "awaiting" ? attempt.since : 0,
    ),
    enabled: awaiting && !!detected,
  });
  useEffect(() => {
    if (awaiting && (wait.data === "cancelled" || wait.data === "closed"))
      setAttempt({ state: wait.data });
  }, [awaiting, wait.data]);

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
      setAttempt({ state: "awaiting", since: Date.now() });
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
            ) : detected === null ? (
              <AddRecorder />
            ) : null}
          </Item>
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * The Recorder's store page in this browser, in a new tab, where it is published, as the sidebar's Browser button opens
 * it (`StorePageLink`): a link, because it goes somewhere, with the same note waiting in OpenBot for when the person
 * comes back. Once they added it, coming back to this page finds it and offers Connect. Nothing where the browser has no
 * store page for it.
 */
function AddRecorder() {
  const here = recorderStorePageHere();
  if (!here) return null;
  return (
    <ItemActions>
      {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
      <a
        className={buttonVariants({ size: "sm" })}
        href={here.page}
        onClick={() => noteStoreTabOpened(here.store)}
        rel="noopener noreferrer"
        target="_blank"
      >
        {ADD_TO[here.store]}
      </a>
    </ItemActions>
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
    case "cancelled":
      return "You cancelled in the OpenBot Recorder tab. Nothing was connected.";
    case "closed":
      return "The OpenBot Recorder tab closed before you confirmed. Nothing was connected.";
    case "failed":
      return attempt.message;
    default:
      return "Installed. Connect it to record tasks for your Bots.";
  }
}
