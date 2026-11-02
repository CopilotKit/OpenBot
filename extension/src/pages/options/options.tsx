import type { RecorderConnectVia } from "@openbot/shared/recorder-api";
import {
  IconBuildingSkyscraper,
  IconLink,
  IconMicrophone,
  IconMicrophoneOff,
  IconPlugConnectedX,
  IconUser,
  IconWorldOff,
} from "@tabler/icons-react";
import { Fragment, useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { PageStateResponse } from "../../protocol/messages";
import { Page } from "../ui/page";
import { ask as askBackground } from "../ui/runtime";

type OptionsDeps = { ask: typeof askBackground };

const VIA: Record<RecorderConnectVia, string> = {
  web: "Connected from OpenBot in your browser",
  desktop: "Connected from OpenBot Desktop",
  "openbot-browser": "Connected by OpenBot when it opened this browser",
  "bot-browser": "Connected by OpenBot while you record in a Bot's browser",
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The Recorder's one settings page: which OpenBot this browser is connected to, and how to disconnect it; whether the
 * person narrates their recordings; and the sites they keep out of them, each with Record again. */
export function Options({ deps }: { deps?: Partial<OptionsDeps> }) {
  const ask = deps?.ask ?? askBackground;
  const [state, setState] = useState<PageStateResponse | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    ask<PageStateResponse | { ok: false; error: string }>({
      type: "page.state",
    }).then((response) => {
      if (!live) return;
      if (response.ok && "state" in response) setState(response);
      else if (!response.ok) setError(response.error);
    });
    return () => {
      live = false;
    };
  }, [ask]);

  /** A change of narration or of the sites left out, then the state again, so the page shows what the Recorder kept. */
  const change = async (
    message:
      | { type: "page.narration"; on: boolean }
      | { type: "page.site"; site: string; recorded: boolean },
  ) => {
    const response = await ask(message);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setError(null);
    const fresh = await ask<PageStateResponse | { ok: false; error: string }>({
      type: "page.state",
    });
    if (fresh.ok && "state" in fresh) setState(fresh);
  };

  const disconnect = async () => {
    const response = await ask({ type: "page.disconnect" });
    if (!response.ok) {
      setError(response.error);
      setAsking(false);
      return;
    }
    setError(null);
    setAsking(false);
    setState((current) =>
      current ? { ...current, connection: null } : current,
    );
  };

  if (!state) {
    return (
      <Page title="OpenBot Recorder" width="prose">
        {error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </Page>
    );
  }

  const { connection, policy } = state;
  const kept = state.state.kept;
  // A Disconnect discards everything this browser still holds: the recording in progress, the stopped recordings
  // still sending to Intelligence, and the kept ones.
  const recording = state.state.phase !== "idle";
  const sending = Math.max(0, state.state.draining - (kept?.recordings ?? 0));
  return (
    <Page title="OpenBot Recorder" width="prose">
      <PageSection title="Connection">
        {connection ? (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconLink />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>OpenBot address</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.openbotUrl}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUser />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{connection.user.name}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {VIA[connection.via]}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlugConnectedX />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>This browser</ItemTitle>
                <ItemDescription>
                  Disconnect this browser from OpenBot.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button size="sm" onClick={() => setAsking(true)}>
                  Disconnect
                </Button>
              </ItemActions>
            </Item>
          </PageRows>
        ) : (
          <PageEmpty>
            This browser is not connected to OpenBot. Open OpenBot, go to
            Settings, Browsers, and choose Connect this browser.
          </PageEmpty>
        )}
        {error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </PageSection>
      <PageSection
        title="Narration"
        description="Whether the Recorder listens to you while you record and adds what you say to your steps as text. Your browser turns it into text on your own computer."
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              {state.narration === "on" ? (
                <IconMicrophone />
              ) : (
                <IconMicrophoneOff />
              )}
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Narration</ItemTitle>
              <ItemDescription>
                {state.narration === "on"
                  ? "On. The Recorder listens while you record."
                  : state.narration === "off"
                    ? "Off. The Recorder does not open your microphone."
                    : "Not chosen yet. The Recorder does not open your microphone."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Narration"
                checked={state.narration === "on"}
                onCheckedChange={(on) =>
                  void change({ type: "page.narration", on })
                }
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <PageSection
        title="Sites not recorded"
        description="Nothing you do on these sites is recorded, in any tab. Each recorded tab has a button that adds its site here."
      >
        {state.excludedSites.length === 0 ? (
          <PageEmpty>
            No sites are left out yet. While you record, choose Don't record on
            a tab's recording mark to leave its site out.
          </PageEmpty>
        ) : (
          <PageRows>
            {state.excludedSites.map((site, index) => (
              <Fragment key={site}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconWorldOff />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{site}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Record ${site} again`}
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void change({ type: "page.site", site, recorded: true })
                      }
                    >
                      Record again
                    </Button>
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>
      {policy.openbotUrl ? (
        <PageSection
          title="Set by your organization"
          description="Your organization chose which OpenBot this Recorder connects to."
        >
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBuildingSkyscraper />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>OpenBot address</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-sm">
                  {policy.openbotUrl}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect this browser?</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 text-sm">
            <p>The Recorder records nothing until you connect it again.</p>
            {recording ? (
              <p className="mt-2">
                The recording in progress stops, and what it has not sent to
                Intelligence yet is discarded.
              </p>
            ) : null}
            {sending > 0 ? (
              <p className="mt-2">
                {plural(sending, "recording", "recordings")} still sending to
                Intelligence {sending === 1 ? "stops" : "stop"}, and what{" "}
                {sending === 1 ? "it has" : "they have"} not sent yet is
                discarded.
              </p>
            ) : null}
            {kept ? (
              <p className="mt-2">
                {plural(kept.events, "event", "events")} from{" "}
                {plural(kept.recordings, "recording", "recordings")} still
                waiting in this browser {kept.events === 1 ? "is" : "are"}{" "}
                discarded.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={disconnect}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
