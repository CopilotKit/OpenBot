import {
  IconCloudUpload,
  IconDeviceLaptop,
  IconListCheck,
  IconLogout,
  IconPlug,
  IconPlugConnected,
  IconShieldCheck,
  IconUserCircle,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import {
  LogsRow,
  VersionRow,
} from "@/components/settings/this-computer-sections";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  changeConnectionMutationOptions,
  moveToCloudMutationOptions,
  signOutOfConnectedOpenBotMutationOptions,
} from "@/lib/desktop/mutations";
import { desktopStatusQueryOptions } from "@/lib/desktop/queries";
import { useCurrentOrganizationName } from "@/lib/organizations/queries";
import { COMPUTER_SECTION } from "@/lib/settings/computer-sections";

/** The address's host, which is how a person names the OpenBot they connect to. */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/**
 * Settings → Computer inside an OpenBot Desktop that is connected to an OpenBot running somewhere
 * else: where it is connected, the two ways out, and the app's own details.
 *
 * It takes the place of `ThisComputerSections`. Nothing of OpenBot runs on this computer then, so
 * there are no services to restart or stop, no memory to report and no install folder. The app's
 * version, its updates and its log folder are about the app, and stay.
 *
 * Both ways out end with the window back at setup, so this page goes with them, as it does on Stop.
 */
export function ConnectionSections({ address }: { address: string }) {
  const status = useQuery(desktopStatusQueryOptions({ memory: false }));
  // Which account this app is signed in as there: after a move to OpenBot Cloud, the person looks
  // here for the account that holds their Bots, and signs in with it in a browser.
  const { data: user } = useQuery(currentUserQueryOptions());
  const organization = useCurrentOrganizationName();
  return (
    <>
      <PageSection id={COMPUTER_SECTION.thisComputer} title="Connection">
        <PageRows>
          <Item size="sm">
            <RowMark>
              <IconPlugConnected className="size-4" />
            </RowMark>
            <ItemContent>
              <ItemTitle>Connected to</ItemTitle>
              <ItemDescription className="line-clamp-none break-all">
                {address}
              </ItemDescription>
            </ItemContent>
          </Item>
          {user?.email ? (
            <>
              <Separator />
              <Item size="sm">
                <RowMark>
                  <IconUserCircle className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>Signed in as</ItemTitle>
                  <ItemDescription className="line-clamp-none break-all">
                    {organization
                      ? `${user.email}, in ${organization}`
                      : user.email}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </>
          ) : null}
          <Separator />
          <SignOutRow host={hostOf(address)} />
          <Separator />
          <UseThisComputerRow host={hostOf(address)} />
        </PageRows>
      </PageSection>
      {status.data && (
        <PageSection title="Details">
          <PageRows>
            {status.data.logFolder && (
              <>
                <LogsRow folder={status.data.logFolder} />
                <Separator />
              </>
            )}
            <VersionRow status={status.data} />
          </PageRows>
        </PageSection>
      )}
    </>
  );
}

function SignOutRow({ host }: { host: string }) {
  const [open, setOpen] = useState(false);
  const signOut = useMutation(signOutOfConnectedOpenBotMutationOptions());
  // On success the desktop app is showing setup, and this page goes with it.
  const leaving = signOut.isPending || signOut.isSuccess;
  return (
    <>
      <Item size="sm">
        <RowMark>
          <IconLogout className="size-4" />
        </RowMark>
        <ItemContent>
          <ItemTitle>Sign out</ItemTitle>
          <ItemDescription className="line-clamp-none">
            Sign out of this OpenBot on this computer.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button onClick={() => setOpen(true)} size="sm" variant="outline">
            Sign out
          </Button>
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out of {host}?</DialogTitle>
            <DialogDescription>
              You'll sign in again in your browser the next time you use OpenBot
              here. Your Bots and conversations stay as they are.
            </DialogDescription>
          </DialogHeader>
          {signOut.error ? (
            <DialogBody className="mt-4 text-sm">
              <p className="text-destructive" role="alert">
                Couldn't sign out. Try again.
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={leaving}
              onClick={() => signOut.mutate()}
              size="sm"
            >
              {leaving ? "Signing out…" : "Sign out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Settings → Computer inside an OpenBot Desktop that runs OpenBot on this computer: the way to
 * connect to an OpenBot that runs somewhere else instead. Drawn under `ThisComputerSections`, and
 * only by a desktop app that can connect. With `moveToCloud`, the move to OpenBot Cloud comes first
 * (`MoveToCloudRow`).
 *
 * It stops OpenBot here, as Stop does, and the window shows setup at the choice of where OpenBot
 * runs. This page goes with it.
 */
export function ConnectInsteadSection({
  moveToCloud = false,
}: {
  moveToCloud?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const change = useMutation(changeConnectionMutationOptions());
  const leaving = change.isPending || change.isSuccess;
  return (
    <PageSection title="Connection">
      <PageRows>
        {moveToCloud ? (
          <>
            <MoveToCloudRow />
            <Separator />
          </>
        ) : null}
        <Item size="sm">
          <RowMark>
            <IconDeviceLaptop className="size-4" />
          </RowMark>
          <ItemContent>
            <ItemTitle>OpenBot runs on this computer</ItemTitle>
            <ItemDescription className="line-clamp-none">
              You can connect to an OpenBot your company runs instead.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button onClick={() => setOpen(true)} size="sm" variant="outline">
              Connect to an OpenBot
            </Button>
          </ItemActions>
        </Item>
      </PageRows>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect to an OpenBot instead?</DialogTitle>
            <DialogDescription>
              OpenBot stops on this computer and setup opens, where you type the
              address of the OpenBot to connect to. Nothing on this computer is
              lost, and you can come back to it later.
            </DialogDescription>
          </DialogHeader>
          {change.error ? (
            <DialogBody className="mt-4 text-sm">
              <p className="text-destructive" role="alert">
                Couldn't open setup. Try again.
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={leaving}
              onClick={() => change.mutate()}
              size="sm"
            >
              {leaving ? "Stopping OpenBot…" : "Stop and open setup"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

/**
 * Move to OpenBot Cloud: everything this OpenBot keeps goes to the person's OpenBot Cloud account,
 * then OpenBot is removed from this computer. The dialog says what happens; Continue asks the
 * desktop app, which shows setup at the move with OpenBot still running, since what moves is read
 * from it. Setup says what moves and asks again before anything does. This page goes with it.
 */
function MoveToCloudRow() {
  const [open, setOpen] = useState(false);
  const move = useMutation(moveToCloudMutationOptions());
  // On success the desktop app is showing setup, and this page goes with it.
  const leaving = move.isPending || move.isSuccess;
  return (
    <>
      <Item size="sm">
        <RowMark>
          <IconCloudUpload className="size-4" />
        </RowMark>
        <ItemContent>
          <ItemTitle>OpenBot Cloud</ItemTitle>
          <ItemDescription className="line-clamp-none">
            Move your Bots and their work to OpenBot Cloud, and free up space on
            this computer.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button onClick={() => setOpen(true)} size="sm" variant="outline">
            Move to OpenBot Cloud
          </Button>
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to OpenBot Cloud?</DialogTitle>
            <DialogDescription>
              Your Bots, conversations, memory, skills, routines and files move
              to your OpenBot Cloud account. Then OpenBot is removed from this
              computer to free up space.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 text-sm">
            <ul className="flex flex-col gap-3">
              {[
                {
                  icon: IconListCheck,
                  said: "Setup opens next and shows everything that moves before you confirm. You'll sign in to OpenBot Cloud in your browser.",
                },
                {
                  icon: IconPlug,
                  said: "Your app connections are private, so they can't move. You'll reconnect them in OpenBot Cloud.",
                },
                {
                  icon: IconShieldCheck,
                  said: "Nothing is removed from this computer until everything has arrived and been checked.",
                },
              ].map(({ icon: Icon, said }) => (
                <li className="flex gap-3" key={said}>
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="text-pretty">{said}</span>
                </li>
              ))}
            </ul>
            {move.error ? (
              <p className="text-destructive" role="alert">
                Couldn't open setup. Try again.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button disabled={leaving} onClick={() => move.mutate()} size="sm">
              {leaving ? "Opening setup…" : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UseThisComputerRow({ host }: { host: string }) {
  const [open, setOpen] = useState(false);
  const change = useMutation(changeConnectionMutationOptions());
  // On success the desktop app is showing setup, and this page goes with it.
  const leaving = change.isPending || change.isSuccess;
  return (
    <>
      <Item size="sm">
        <RowMark>
          <IconDeviceLaptop className="size-4" />
        </RowMark>
        <ItemContent>
          <ItemTitle>Use OpenBot on this computer instead</ItemTitle>
          <ItemDescription className="line-clamp-none">
            Run every part of OpenBot on this computer.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button onClick={() => setOpen(true)} size="sm" variant="outline">
            Use this computer
          </Button>
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use OpenBot on this computer instead?</DialogTitle>
            <DialogDescription>
              This signs you out of {host} and opens setup, where you choose
              where OpenBot runs. Nothing on this computer is lost, and you can
              connect to {host} again later.
            </DialogDescription>
          </DialogHeader>
          {change.error ? (
            <DialogBody className="mt-4 text-sm">
              <p className="text-destructive" role="alert">
                Couldn't open setup. Try again.
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={leaving}
              onClick={() => change.mutate()}
              size="sm"
            >
              {leaving ? "Opening setup…" : "Switch to this computer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
