import { IconArchive, IconBuilding, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  type ComponentType,
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { LeaveOrganizationDialog } from "@/components/organizations/organization-settings-page";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { requestAccountDeletionMutationOptions } from "@/lib/account-deletion/mutations";
import {
  deletionResumed,
  deletionToResume,
  pendingPageDeps,
  resumeDeletionAfterSignIn,
  showPendingDeletion,
} from "@/lib/account-deletion/pending";
import {
  ACCOUNT_DELETION_BLOCKED,
  type AccountDeletionBlocker,
  accountDeletionKeys,
  accountDeletionQueryOptions,
  blockerWords,
  DELETE_PHRASE,
  DELETION_WAIT_DAYS,
  offersAccountDeletion,
  olderOpenBot,
  reauthenticationRequired,
  sameEmail,
  samePhrase,
  settledInItsSettings,
} from "@/lib/account-deletion/queries";
import { signInAgainAtProvider } from "@/lib/account-deletion/reauthenticate";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ClientError } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { failureSaid } from "@/lib/load-failure";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { switchOrganizationMutationOptions } from "@/lib/organizations/mutations";
import { queryClient } from "@/query-client";

const ORGANIZATION_SETTINGS = "/settings/organization";
const GENERAL_SETTINGS = "/settings";

/**
 * Back from signing in again to delete the account (lib/account-deletion/pending.ts): sign-in lands
 * at home, and this takes the person on to General settings, where the delete dialog opens again.
 * The place is fixed here, never read from an address. Draws nothing.
 */
export function ResumeAccountDeletion() {
  const router = useRouter();
  // Once, as the signed-in app opens: never again while the person moves about it.
  useEffect(() => {
    if (!deletionToResume()) return;
    if (router.state.location.pathname !== GENERAL_SETTINGS)
      void router.navigate({ to: GENERAL_SETTINGS });
  }, [router]);
  return null;
}

/**
 * Settings, General, last: deleting the person's own account, as GitHub has it. The organizations
 * that stop it now come first (`blockers`, the server's verdict), each with what to do there: one
 * they are the only owner of opens its settings, where they make someone else an owner or delete
 * it; one with other owners they leave, here. With none left, Delete account opens the dialog that
 * says what goes and what stays, and asks for their email address and the phrase.
 *
 * Nothing on an OpenBot older than the question, which can't delete an account, and nothing in the
 * personal edition, which has no account to delete and isn't asked.
 */
export function DeleteAccountSection() {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const offered =
    !capabilities.isPending && offersAccountDeletion(capabilities.data);
  const deletion = useQuery({
    ...accountDeletionQueryOptions(),
    enabled: offered,
  });
  const [open, setOpen] = useState(false);
  const blockers = deletion.data?.blockers ?? [];
  const scheduled =
    deletion.data?.status === "scheduled" ? deletion.data : undefined;

  // A deletion already scheduled: the app is the pending page from here.
  useEffect(() => {
    if (scheduled) showPendingDeletion({ deleteAfter: scheduled.deleteAfter });
  }, [scheduled]);

  // Back from signing in again to delete the account: the dialog opens where they left it.
  // Taken once it is answered either way, so a failed read never sends them back here again.
  useEffect(() => {
    if (deletion.isPending || !deletionToResume()) return;
    deletionResumed();
    if (deletion.data?.blockers.length === 0) setOpen(true);
  }, [deletion.isPending, deletion.data]);

  if (!offered || deletion.isPending) return null;
  if (deletion.error && olderOpenBot(deletion.error)) return null;
  return (
    <PageSection
      description={
        blockers.length > 0
          ? "Before you can delete your account, sort out these organizations."
          : `Delete your account and everything that's only yours. You have ${DELETION_WAIT_DAYS} days to change your mind.`
      }
      title="Delete account"
    >
      {deletion.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(deletion.error)}
        </p>
      ) : blockers.length > 0 ? (
        <PageRows>
          {blockers.map((blocker, index) => (
            <Fragment key={blocker.organizationId}>
              <BlockerRow blocker={blocker} />
              {index !== blockers.length - 1 && <Separator />}
            </Fragment>
          ))}
        </PageRows>
      ) : null}
      <Button
        className="mt-4"
        disabled={!deletion.data || blockers.length > 0}
        onClick={() => setOpen(true)}
        variant="destructive"
      >
        Delete account
      </Button>
      <DeleteAccountDialog onOpenChange={setOpen} open={open} />
    </PageSection>
  );
}

/** One organization that stops the account being deleted, and the one thing to do there. */
function BlockerRow({ blocker }: { blocker: AccountDeletionBlocker }) {
  const [leaving, setLeaving] = useState(false);
  const organization = {
    id: blocker.organizationId,
    name: blocker.organizationName,
  };
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconBuilding />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          <span className="truncate">{blocker.organizationName}</span>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {blockerWords(blocker)}
        </ItemDescription>
      </ItemContent>
      {/* Under the words on a phone, as on Organization's members: a button beside them squeezes them. */}
      <ItemActions className="max-sm:basis-full max-sm:pl-11">
        {settledInItsSettings(blocker) ? (
          <OpenOrganizationSettings organizationId={blocker.organizationId} />
        ) : (
          <>
            <Button
              onClick={() => setLeaving(true)}
              size="sm"
              variant="outline"
            >
              Leave organization
            </Button>
            <LeaveOrganizationDialog
              onLeft={() =>
                void queryClient.invalidateQueries({
                  queryKey: accountDeletionKeys.all,
                })
              }
              onOpenChange={setLeaving}
              open={leaving}
              organization={organization}
              returnTo="/settings"
            />
          </>
        )}
      </ItemActions>
    </Item>
  );
}

/**
 * An organization's settings, where its owner makes someone else an owner or deletes it. The
 * settings are the one the person works in, so another one is switched to first, as the account
 * menu switches.
 */
function OpenOrganizationSettings({
  organizationId,
}: {
  organizationId: string;
}) {
  const navigate = useNavigate();
  const current = useCurrentOrganizationId();
  const open = () => navigate({ to: ORGANIZATION_SETTINGS });
  const switching = useMutation(
    switchOrganizationMutationOptions(queryClient, async () => {
      await open();
    }),
  );
  return (
    <div className="flex flex-col items-end gap-1 max-sm:items-start">
      <Button
        disabled={switching.isPending}
        onClick={() =>
          organizationId === current
            ? void open()
            : switching.mutate(organizationId)
        }
        size="sm"
        variant="outline"
      >
        {switching.isPending ? "Opening…" : "Open its settings"}
      </Button>
      {switching.error ? (
        <p className="text-destructive text-sm" role="alert">
          {failureSaid(switching.error)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Says what deleting the account does, asks for the person's email address and the phrase, and
 * deletes it: in 14 days, or now. In 14 days, the app becomes the pending page at once. Now, the
 * person is signed out and sent to sign-in. A session too old to delete an account is offered
 * Sign in again, which comes back to this dialog.
 *
 * `now`: the pending page's, for somebody already waiting out the 14 days. It deletes now and
 * nothing else, with the same confirmation and the same recent sign-in. A sign-in the request
 * ended is sent to sign in again, as the pending page's Cancel deletion is.
 */
export function DeleteAccountDialog({
  now: nowOnly = false,
  onOpenChange,
  open,
}: {
  now?: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const formId = useId();
  const user = useQuery(currentUserQueryOptions()).data;
  const email = user?.email;
  const request = useMutation(
    requestAccountDeletionMutationOptions(queryClient),
  );
  const { reset } = request;
  const signOutNow = useMutation(signOutMutationOptions(queryClient));
  const signOut = useSignOut();
  // Signed in again at their provider without signing out, and back here (reauthenticate.ts); where
  // there is no provider to send them to, signed out to sign in again.
  const signInAgain = useMutation({
    mutationFn: async () => {
      resumeDeletionAfterSignIn();
      const started = user
        ? await signInAgainAtProvider(queryClient, user)
        : false;
      if (!started) signOut.run();
    },
  });
  const [typedEmail, setTypedEmail] = useState("");
  const [typedPhrase, setTypedPhrase] = useState("");
  const confirmed = sameEmail(typedEmail, email) && samePhrase(typedPhrase);
  const busy = request.isPending || signOutNow.isPending;
  const reauthenticate = reauthenticationRequired(request.error);

  // Each opening starts empty, and a refusal from the last one is not news about this one.
  useEffect(() => {
    if (open) {
      setTypedEmail("");
      setTypedPhrase("");
      reset();
    }
  }, [open, reset]);

  const remove = (immediate: boolean) => {
    if (!confirmed || busy) return;
    request.mutate(
      { confirmEmail: typedEmail, confirmPhrase: typedPhrase, immediate },
      {
        onSuccess: async (scheduled) => {
          onOpenChange(false);
          if (!immediate) {
            showPendingDeletion({ deleteAfter: scheduled.deleteAfter });
            return;
          }
          // Gone: nothing is left to be signed in to. Whatever the sign-out says, sign-in is next.
          const out = await signOutNow
            .mutateAsync()
            .catch(() => ({ leaving: false }));
          if (!out.leaving) pendingPageDeps.openSignIn();
        },
        onError: (error) => {
          // An organization stops it: the section behind lists it now, with what to do.
          if (
            error instanceof ClientError &&
            error.code === ACCOUNT_DELETION_BLOCKED
          )
            onOpenChange(false);
          // On the pending page, a sign-in the request ended: signing in again comes back here.
          if (nowOnly && error instanceof ClientError && error.status === 401)
            pendingPageDeps.openSignIn();
        },
      },
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {nowOnly ? "Delete your account now?" : "Delete your account?"}
          </DialogTitle>
          <DialogDescription>
            {nowOnly
              ? "Your account is deleted straight away, and you can't undo it."
              : `Your account is deleted in ${DELETION_WAIT_DAYS} days. Sign in before then to cancel. Delete now deletes it straight away, and you can't undo it.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <div className="flex flex-col gap-3 text-sm">
            <WhatHappens icon={IconTrash} title="Deleted">
              <li>
                Your conversations, memory, Bots, skills and routines that are
                only yours.
              </li>
              <li>Your saved logins, connections and computer.</li>
            </WhatHappens>
            <WhatHappens icon={IconArchive} title="Kept">
              <li>
                Messages you sent in organizations you share with others. They
                show as from Deleted user.
              </li>
              <li>
                Security log entries, for 180 days, without your name or email.
              </li>
            </WhatHappens>
          </div>
          <form
            className="mt-5"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              remove(nowOnly);
            }}
          >
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor={`${formId}-email`}>
                  Type your email address
                </FieldLabel>
                <Input
                  autoComplete="off"
                  autoFocus
                  disabled={busy}
                  id={`${formId}-email`}
                  onChange={(event) => {
                    setTypedEmail(event.target.value);
                    reset();
                  }}
                  spellCheck={false}
                  type="email"
                  value={typedEmail}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-phrase`}>
                  {/* One run of text: the label lays its children out with a gap between them. */}
                  <span>
                    Type <span className="font-semibold">{DELETE_PHRASE}</span>
                  </span>
                </FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={busy}
                  id={`${formId}-phrase`}
                  onChange={(event) => {
                    setTypedPhrase(event.target.value);
                    reset();
                  }}
                  spellCheck={false}
                  value={typedPhrase}
                />
              </Field>
            </FieldGroup>
          </form>
        </DialogBody>
        {/* Outside the scrolling body, so a refusal is on screen however long the body is. */}
        {request.error ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-destructive text-sm" role="alert">
              {signInAgain.error
                ? failureSaid(signInAgain.error)
                : failureSaid(request.error)}
            </p>
            {reauthenticate ? (
              <Button
                disabled={signInAgain.isPending || signOut.pending}
                onClick={() => signInAgain.mutate()}
                size="sm"
                variant="outline"
              >
                {signInAgain.isPending || signOut.pending
                  ? "Opening sign-in…"
                  : "Sign in again"}
              </Button>
            ) : null}
          </div>
        ) : null}
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          {nowOnly ? (
            <Button
              disabled={!confirmed || busy}
              form={formId}
              size="sm"
              type="submit"
              variant="destructive"
            >
              {busy ? "Deleting…" : "Delete now"}
            </Button>
          ) : (
            <>
              <Button
                disabled={!confirmed || busy}
                onClick={() => remove(true)}
                size="sm"
                variant="outline"
              >
                {request.isPending && request.variables?.immediate
                  ? "Deleting…"
                  : "Delete now"}
              </Button>
              <Button
                disabled={!confirmed || busy}
                form={formId}
                size="sm"
                type="submit"
                variant="destructive"
              >
                {request.isPending && !request.variables?.immediate
                  ? "Deleting…"
                  : `Delete in ${DELETION_WAIT_DAYS} days`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One half of what deleting does: a heading and its list, on a muted fill (a card's colour is the
 * dialog's own, so it would not show).
 */
function WhatHappens({
  children,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  icon: ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2.5">
      <p className="flex items-center gap-1.5 font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
        {children}
      </ul>
    </div>
  );
}
