import {
  IconBuildingSkyscraper,
  IconLink,
  IconPlugConnectedX,
  IconUser,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
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
import type { PageStateResponse } from "../../protocol/messages";
import { Page } from "../ui/page";
import { ask as askBackground } from "../ui/runtime";

export type OptionsDeps = { ask: typeof askBackground };

const VIA = {
  web: "Connected from OpenBot in your browser",
  desktop: "Connected from OpenBot Desktop",
} as const;

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The Recorder's one settings page: which OpenBot this browser is connected to, and how to disconnect it. */
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
                  Stop recording to OpenBot from this browser.
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
            <p>It stops recording to OpenBot until you connect it again.</p>
            {kept ? (
              <p className="mt-2">
                {plural(kept.events, "event", "events")} from{" "}
                {plural(kept.recordings, "recording", "recordings")} still
                waiting in this browser are discarded.
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
