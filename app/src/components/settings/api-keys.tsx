import { IconExternalLink, IconKey, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import {
  createApiKeyMutationOptions,
  type NewApiKey,
  revokeApiKeyMutationOptions,
} from "@/lib/api-keys/mutations";
import { type ApiKey, apiKeyListQueryOptions } from "@/lib/api-keys/queries";
import { openInSystemBrowser } from "@/lib/desktop/open-in-browser";
import { desktopShell } from "@/lib/desktop/shell";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";
import { copyText } from "./linked-accounts";

/** The longest name the API takes (`CreateApiKeyRequest.name`). */
const NAME_LIMIT = 32;

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** What a key is called on screen. The API allows a key with no name; the screen never makes one. */
function keyName(apiKey: ApiKey): string {
  return apiKey.name?.trim() || "Unnamed key";
}

/** A key's row, under its name: how it starts, when it was made, its last use, and its end if it has one. */
export function apiKeyDescription(apiKey: ApiKey, now = Date.now()): string {
  const parts = [
    ...(apiKey.start ? [`${apiKey.start}…`] : []),
    `Created ${day.format(new Date(apiKey.createdAt))}`,
    apiKey.lastUsedAt
      ? `Last used ${relativeTime(apiKey.lastUsedAt)}`
      : "Never used",
  ];
  if (apiKey.expiresAt) {
    const expires = new Date(apiKey.expiresAt);
    parts.push(
      `${expires.getTime() <= now ? "Expired" : "Expires"} ${day.format(expires)}`,
    );
  }
  return parts.join(" · ");
}

/**
 * Settings → API keys: the keys a person made for their own scripts and programs, with Create and
 * Revoke.
 *
 * A key is shown whole once, when it is made, and is kept nowhere in the app after that dialog
 * closes. Two answers from the API are not failures and read as a sentence: an OpenBot with no
 * sign-in has no keys, and OpenBot Desktop connected to an OpenBot elsewhere is sent to the browser,
 * because only a person signed in on the web can manage keys.
 */
export function ApiKeysPage() {
  const list = useQuery(apiKeyListQueryOptions());
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<NewApiKey | null>(null);
  const ready = list.data?.state === "ready";
  const createButton = (size: "sm" | "lg", variant: "default" | "outline") => (
    <Button onClick={() => setCreating(true)} size={size} variant={variant}>
      <IconPlus />
      Create key
    </Button>
  );
  return (
    <PageShell
      action={ready ? createButton("lg", "default") : undefined}
      description="Create a key so a script or another program can use OpenBot as you."
      title="API keys"
    >
      {/* One section, so it carries no heading: the page title already names it. */}
      <PageSection>
        {list.isPending ? null : list.error ? (
          <p className="text-destructive text-sm" role="alert">
            Couldn't load your API keys. Reload the page.
          </p>
        ) : list.data.state === "unavailable" ? (
          <PageEmpty
            icon={IconKey}
            title="API keys aren't available on this OpenBot"
          >
            This OpenBot runs on one computer for one person and has no sign-in,
            so it has no API keys.
          </PageEmpty>
        ) : list.data.state === "browser-only" ? (
          <BrowserOnly />
        ) : list.data.apiKeys.length === 0 ? (
          <PageEmpty
            action={createButton("sm", "outline")}
            icon={IconKey}
            title="No API keys yet"
          >
            A key lets a script or another program use OpenBot as you.
          </PageEmpty>
        ) : (
          <PageRows>
            {list.data.apiKeys.map((apiKey, index) => (
              <Fragment key={apiKey.id}>
                {index > 0 ? <Separator /> : null}
                <ApiKeyRow apiKey={apiKey} />
              </Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>
      <CreateApiKeyDialog
        onMade={(key) => {
          setCreating(false);
          setMade(key);
        }}
        onOpenChange={setCreating}
        open={creating}
      />
      <NewApiKeyDialog made={made} onClose={() => setMade(null)} />
    </PageShell>
  );
}

/**
 * Where keys are managed when this window can't: OpenBot in a browser. In OpenBot Desktop a button
 * opens this page there; anywhere else there is nothing to press, so it is only said.
 */
function BrowserOnly() {
  const [failed, setFailed] = useState(false);
  const address = `${window.location.origin}/settings/api-keys`;
  return (
    <PageEmpty
      action={
        desktopShell() ? (
          <Button
            onClick={async () =>
              setFailed(!(await openInSystemBrowser(address)))
            }
            size="sm"
            variant="outline"
          >
            <IconExternalLink />
            Open in browser
          </Button>
        ) : undefined
      }
      icon={IconKey}
      title="API keys are managed in your browser"
    >
      {failed ? (
        <span role="alert">
          Couldn't open your browser. Go to {address} there.
        </span>
      ) : (
        "Create API keys from OpenBot in your browser."
      )}
    </PageEmpty>
  );
}

/**
 * One key, with its own Revoke: asked first in a dialog, because whatever uses the key stops working
 * at once, and pending for this row alone. A refusal is said in the dialog, where the person asked.
 */
function ApiKeyRow({ apiKey }: { apiKey: ApiKey }) {
  const [asking, setAsking] = useState(false);
  const revoke = useMutation(revokeApiKeyMutationOptions(queryClient));
  const name = keyName(apiKey);
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconKey />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{name}</ItemTitle>
          <ItemDescription>{apiKeyDescription(apiKey)}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            aria-label={`Revoke ${name}`}
            disabled={revoke.isPending}
            onClick={() => {
              revoke.reset();
              setAsking(true);
            }}
            size="sm"
            variant="ghost"
          >
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </Button>
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setAsking} open={asking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {name}?</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 text-sm">
            <p>
              Anything that uses this key stops working right away. You can't
              undo this.
            </p>
            {revoke.error ? (
              <p className="mt-2 text-destructive" role="alert">
                {revoke.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setAsking(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate(apiKey.id, { onSuccess: () => setAsking(false) })
              }
              size="sm"
              variant="destructive"
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The one thing a key needs from a person: a name. One field, so a dialog and not a screen of its own. */
function CreateApiKeyDialog({
  onMade,
  onOpenChange,
  open,
}: {
  onMade: (made: NewApiKey) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const create = useMutation(createApiKeyMutationOptions(queryClient));
  const trimmed = name.trim();
  const close = (next: boolean) => {
    if (!next) {
      setName("");
      create.reset();
    }
    onOpenChange(next);
  };
  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed || create.isPending) return;
            create.mutate(
              { name: trimmed },
              {
                onSuccess: (made) => {
                  // Handed on and dropped here, so the key is held only by the dialog that shows it.
                  setName("");
                  create.reset();
                  onMade(made);
                },
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Field>
              <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
              <FieldDescription>
                Name it after what will use it, so you can tell your keys apart.
              </FieldDescription>
              <Input
                autoComplete="off"
                autoFocus
                id="api-key-name"
                maxLength={NAME_LIMIT}
                onChange={(event) => setName(event.target.value)}
                placeholder="Nightly report"
                value={name}
              />
            </Field>
            {create.error ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {create.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => close(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={!trimmed || create.isPending}
              size="sm"
              type="submit"
            >
              {create.isPending ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The key itself, this once. Closing the dialog drops it: the API never gives it again. */
function NewApiKeyDialog({
  made,
  onClose,
}: {
  made: NewApiKey | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const close = () => {
    setCopied(false);
    setCopyFailed(false);
    onClose();
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={made !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy your API key</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4">
          {made ? (
            <div className="grid gap-3 text-sm">
              <p>
                Copy this key now and keep it somewhere safe. You can't see it
                again after you close this.
              </p>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono">
                  {made.key}
                </code>
                <Button
                  onClick={async () => {
                    const ok = await copyText(made.key, navigator.clipboard);
                    setCopied(ok);
                    setCopyFailed(!ok);
                  }}
                  size="sm"
                  variant="outline"
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {copyFailed ? (
                <p className="text-destructive" role="alert">
                  Couldn't copy. Select the key and copy it yourself.
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={close} size="sm">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
