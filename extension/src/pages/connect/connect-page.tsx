import { RECORDER_DESTINATION } from "@openbot/shared/recorder-disclosure";
import {
  IconChevronRight,
  IconReplace,
  IconServer,
  IconTag,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { defaultBrowserName } from "../../shared/browser-name";
import { Page } from "../ui/page";
import { ask } from "../ui/runtime";

type Pending = { origin: string; via: "web" | "desktop" };
/** The connection this browser has now, which approving replaces. */
type Replaces = { origin: string; email: string };
type Phase =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "ready"; pending: Pending; replaces?: Replaces }
  | { kind: "connected"; name: string }
  | { kind: "cancelled" };

/** Who asked. Any site can ask to connect, so a web request is said to come from a page at the address shown, never
 * from OpenBot: confirming that it is OpenBot is what the person is asked to do. */
const SOURCE = {
  web: "A page at this address in this browser asked to connect.",
  desktop: "OpenBot Desktop on this computer asked.",
} as const;

/**
 * The page that asks the person to confirm the OpenBot address before this browser signs in to it.
 * The address is the decision, so it is the first row, read only, in the monospace face.
 */
export function ConnectPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [name, setName] = useState(defaultBrowserName);
  const [draft, setDraft] = useState(name);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    ask({ type: "page.connect.pending" }).then((answer) => {
      if (!live) return;
      if (!answer.ok) {
        setPhase({ kind: "error", message: answer.error });
      } else if ("pending" in answer && answer.pending) {
        setPhase({
          kind: "ready",
          pending: answer.pending,
          ...(answer.replaces ? { replaces: answer.replaces } : {}),
        });
      } else {
        setPhase({ kind: "none" });
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const connect = async (pending: Pending) => {
    setBusy(true);
    setMessage(null);
    // No permission to ask for: the install granted access to every site, this OpenBot's included.
    const answer = await ask({
      type: "page.connect.decide",
      approve: true,
      label: name,
      origin: pending.origin,
    });
    setBusy(false);
    if (answer.ok) setPhase({ kind: "connected", name });
    else setMessage(answer.error);
  };

  const cancel = async (pending: Pending) => {
    setBusy(true);
    await ask({
      type: "page.connect.decide",
      approve: false,
      label: name,
      origin: pending.origin,
    });
    setBusy(false);
    setPhase({ kind: "cancelled" });
  };

  return (
    <Page
      title="Connect this browser to OpenBot"
      description={`Confirm this is your OpenBot. It signs this browser in. ${RECORDER_DESTINATION}`}
      width="prose"
    >
      {phase.kind === "ready" ? (
        <>
          <PageSection>
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconServer />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="font-mono">
                    {phase.pending.origin}
                  </ItemTitle>
                  <ItemDescription>{SOURCE[phase.pending.via]}</ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
              {/* Connecting here ends the connection this browser has now, so the page says which one before the click. */}
              {phase.replaces ? (
                <>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <IconReplace />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        This replaces your connection to{" "}
                        <span className="font-mono">
                          {phase.replaces.origin}
                        </span>
                      </ItemTitle>
                      <ItemDescription>
                        Connected there as {phase.replaces.email}.
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                  <Separator />
                </>
              ) : null}
              <Item
                size="sm"
                render={
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(name);
                      setEditing(true);
                    }}
                  />
                }
              >
                <ItemMedia variant="icon">
                  <IconTag />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Name</ItemTitle>
                  <ItemDescription>{name}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
          </PageSection>
          <div className="mt-8 flex flex-row gap-2">
            <Button
              size="lg"
              disabled={busy}
              onClick={() => connect(phase.pending)}
            >
              Connect
            </Button>
            <Button
              size="lg"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel(phase.pending)}
            >
              Cancel
            </Button>
          </div>
          {message ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {message}
            </p>
          ) : null}
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Browser name</DialogTitle>
              </DialogHeader>
              <DialogBody className="mt-4">
                <Field>
                  <Label htmlFor="browser-name">Name this browser</Label>
                  <Input
                    id="browser-name"
                    value={draft}
                    maxLength={80}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </Field>
              </DialogBody>
              <DialogFooter className="mt-4">
                <Button
                  size="sm"
                  disabled={draft.trim() === ""}
                  onClick={() => {
                    setName(draft.trim());
                    setEditing(false);
                  }}
                >
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : phase.kind === "connected" ? (
        <p className="mt-8 text-sm" role="status">
          Connected as {phase.name}. You can close this tab.
        </p>
      ) : phase.kind === "cancelled" ? (
        <p className="mt-8 text-muted-foreground text-sm" role="status">
          Nothing was connected. You can close this tab.
        </p>
      ) : phase.kind === "error" ? (
        <p className="mt-8 text-destructive text-sm" role="alert">
          {phase.message}
        </p>
      ) : phase.kind === "none" ? (
        <p className="mt-8 text-muted-foreground text-sm" role="status">
          No connection is waiting. Choose Connect this browser in OpenBot to
          start one.
        </p>
      ) : null}
    </Page>
  );
}
