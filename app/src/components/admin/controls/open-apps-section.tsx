import { IconLock, IconLockOpen } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useEdition } from "@/components/edition/for-a-team";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { setAppsLockedDownMutationOptions } from "@/lib/enterprise/mutations";
import { appsSettingQueryOptions } from "@/lib/enterprise/queries";
import { failureSaid, loadFailure } from "@/lib/load-failure";
import { queryClient } from "@/query-client";
import { ControlsSection } from "./controls-section";

/**
 * Admin, Apps: whether the organization's apps are open (the default) or locked down.
 *
 * Opening is immediate: it takes nothing from anybody. Locking down asks first, because it changes
 * what giving does for everybody, and it is the one moment the admin can also take back what OpenBot
 * gave Bots by itself while apps were open. That is off unless they tick it.
 */
export function OpenAppsSection() {
  const [confirming, setConfirming] = useState(false);
  const [takeBack, setTakeBack] = useState(false);
  const takeBackId = useId();
  const edition = useEdition();
  // Its own resource: the switch is not one of the settings the overview reads.
  const setting = useQuery({
    ...appsSettingQueryOptions(),
    enabled: edition === "team",
  });
  const lock = useMutation(setAppsLockedDownMutationOptions(queryClient));
  const close = () => {
    setConfirming(false);
    setTakeBack(false);
  };
  return (
    <ControlsSection
      description="While apps are open, OpenBot gives each Bot its owner's connected apps and the apps that need no sign-in. What an admin sets on one app or one Bot holds either way."
      title="Giving apps"
    >
      {({ saving }) => {
        const open = setting.data?.lockedDown !== true;
        const failure = lock.error ?? setting.error;
        return (
          <>
            {failure ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {lock.error
                  ? failureSaid(lock.error)
                  : loadFailure(
                      setting.error,
                      "Couldn't load how apps are given. Try again in a moment.",
                    )}
              </p>
            ) : null}
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  {open ? <IconLockOpen /> : <IconLock />}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Open apps</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {open
                      ? "People's connected apps are on for their own Bots, with every action. Turn this off to lock apps down."
                      : "Locked down. An admin approves each request for an app, and one press gives only its read-only actions."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Open apps"
                    checked={open}
                    disabled={saving || lock.isPending || !setting.data}
                    onCheckedChange={(checked) => {
                      if (checked) lock.mutate({ lockedDown: false });
                      else setConfirming(true);
                    }}
                  />
                </ItemActions>
              </Item>
            </PageRows>
            <Dialog
              onOpenChange={(next) => (next ? undefined : close())}
              open={confirming}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Lock apps down?</DialogTitle>
                  <DialogDescription>
                    From now on, an admin approves each request for an app, and
                    one press gives only its read-only actions. Bot owners can
                    give an app only once an admin opens it to them.
                  </DialogDescription>
                </DialogHeader>
                <DialogBody className="mt-4 flex flex-col gap-3">
                  <p className="text-muted-foreground text-sm">
                    Bots keep the apps they have now, unless you take them back
                    here.
                  </p>
                  <label
                    className="flex items-start gap-2 text-sm"
                    htmlFor={takeBackId}
                  >
                    <Checkbox
                      checked={takeBack}
                      className="mt-0.5"
                      id={takeBackId}
                      onCheckedChange={(checked) =>
                        setTakeBack(checked === true)
                      }
                    />
                    <span>
                      Also take back what OpenBot gave Bots while apps were open
                      <span className="mt-1 block text-muted-foreground">
                        That's each person's connected apps on their own Bots,
                        and the apps that need no sign-in on every Bot. What
                        anybody gave by hand stays.
                      </span>
                    </span>
                  </label>
                </DialogBody>
                <DialogFooter className="mt-4">
                  <Button
                    onClick={close}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Keep apps open
                  </Button>
                  <Button
                    disabled={lock.isPending}
                    onClick={() => {
                      lock.mutate({
                        lockedDown: true,
                        takeBackWhatOpenGave: takeBack,
                      });
                      close();
                    }}
                    size="sm"
                    type="button"
                  >
                    Lock apps down
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        );
      }}
    </ControlsSection>
  );
}
