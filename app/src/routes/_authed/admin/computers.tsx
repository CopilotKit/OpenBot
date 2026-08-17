import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";

type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  egress: string | null;
};

/** API placeholder id; the list endpoint returns all computers. */
const COMPUTER_ID = "openbot-computer";

export const Route = createFileRoute("/_authed/admin/computers")({
  component: ComputersPage,
});

function ComputersPage() {
  const [computers, setComputers] = useState<ComputerProfile[] | null>(null);
  /** Whether each Bot has an isolated browser profile. */
  const [isolation, setIsolation] = useState<"per-bot" | "shared" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Bot id currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profile, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameFor = useBotNames();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/computers/${COMPUTER_ID}/computers`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setProblem(body?.error ?? "The computers could not be listed.");
        return;
      }
      const body = (await response.json()) as {
        computers: ComputerProfile[];
        isolation?: "per-bot" | "shared";
      };
      setComputers(body.computers);
      setIsolation(body.isolation ?? null);
      setProblem(null);
    } catch {
      setProblem("The computers could not be reached.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (botId: string, action: "stop" | "reset") => {
      setBusy(botId);
      setConfirming(null);
      try {
        const response = await fetch(
          `/api/computers/${encodeURIComponent(botId)}/computers/${action}`,
          { method: "POST", credentials: "include" },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setProblem(body?.error ?? `The computer could not be ${action}.`);
        } else {
          setProblem(null);
        }
      } catch {
        setProblem("The computer could not be reached.");
      } finally {
        setBusy(null);
        await load();
      }
    },
    [load],
  );

  return (
    <PageShell
      description="Each Bot's browser and the profile it keeps. A profile is what makes a Bot still signed in tomorrow, and resetting one signs it out of everything."
      title="Computers"
    >
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="font-medium">
            Every Bot is sharing one computer.
          </span>{" "}
          They share its logins, its files and its session, so a Bot can reach
          what another signed into. Set <code>COMPUTER_SUPERVISOR_URL</code> to
          give each Bot its own.
        </p>
      ) : isolation === "per-bot" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          Each Bot has a computer of its own: its own container, its own files
          and its own browser profile.
        </p>
      ) : null}

      <PageSection title="Computers in this deployment">
        {computers === null && problem ? (
          <PageEmpty>The list could not be loaded.</PageEmpty>
        ) : computers === null ? (
          <PageEmpty>Loading…</PageEmpty>
        ) : computers.length === 0 ? (
          <PageEmpty>
            No computers yet. One appears the first time a Bot opens a page.
          </PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={computer.botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle title={computer.botId}>
                      {nameFor(computer.botId)}
                    </ItemTitle>
                    <ItemDescription>
                      {computer.running
                        ? `Browser running since ${new Date(computer.startedAt ?? "").toLocaleTimeString()}`
                        : "No browser running. It starts when the Bot next needs it."}
                      {" · "}
                      {computer.egress
                        ? `Leaves through ${computer.egress}`
                        : "Leaves directly"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={busy === computer.botId || !computer.running}
                      onClick={() => void run(computer.botId, "stop")}
                      size="sm"
                      variant="outline"
                    >
                      {busy === computer.botId ? "Working…" : "Stop browser"}
                    </Button>
                    <Button
                      disabled={busy === computer.botId}
                      onClick={() => setConfirming(computer.botId)}
                      size="sm"
                      variant="outline"
                    >
                      Reset
                    </Button>
                  </ItemActions>
                </Item>
                {index !== computers.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names the Bot, so the sentence somebody agrees to says
       * which computer it destroys.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reset {confirming ? nameFor(confirming) : ""}'s computer?
            </DialogTitle>
            <DialogDescription>
              Its profile is deleted, so the Bot is signed out of every service
              it had logged into and starts clean. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirming(null)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={busy === confirming}
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {busy === confirming ? "Resetting…" : "Reset it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="mt-4 text-muted-foreground text-sm">
        <strong>Stop</strong> closes the browser and keeps its logins: the next
        thing the Bot does starts it again where it left off.{" "}
        <strong>Reset</strong> deletes the profile, so the Bot is signed out of
        everything and starts clean. Both are recorded in{" "}
        <Link className="underline" to="/admin/audit">
          Audit
        </Link>
        .
      </p>
    </PageShell>
  );
}
