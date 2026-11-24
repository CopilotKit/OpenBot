import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { DirectoryKeyVersion } from "@/lib/api/generated/model";
import { addDirectoryAppMutationOptions } from "@/lib/apps/mutations";
import { directoryAppsQueryOptions } from "@/lib/apps/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { keyVersionOffer } from "@/lib/plugins/directory-state";
import { cn } from "@/lib/utils";

/**
 * AN APP THE DIRECTORY LISTS AS A SIGN-IN IN PLACE OF ITS KEY can still be added with its key, as
 * an app of its own, and the key version often offers far more actions. The sign-in stays the
 * row's own action; this is the quiet second way, drawn as a line of small text under it, in the
 * same underlined style as the row's other inline links (`SignInNote`).
 *
 * - Not added: "Connect with a key instead" for somebody who connects as they add, "Add with a key
 *   instead" in Admin's directory, and nothing for a member, who asks for apps and adds none.
 * - Added: a link to the key version's own page, by the title the server gave it.
 */
export function KeyVersionLine({
  keyVersion,
  mode,
  pending,
  onPress,
  link,
  className,
}: {
  keyVersion: DirectoryKeyVersion;
  mode: "connect" | "add" | "request";
  pending: boolean;
  onPress: () => void;
  /** Where the added key version's page is. */
  link: LinkOptions | null;
  className?: string;
}) {
  if (keyVersion.appId !== null)
    return link ? (
      <p
        className={cn("text-muted-foreground text-xs", className)}
        data-testid="key-version"
      >
        Also added with a key as{" "}
        <Link className="underline underline-offset-2" {...link}>
          {keyVersion.title}
        </Link>
        .
      </p>
    ) : null;
  if (mode === "request") return null;
  return (
    <p
      className={cn("text-muted-foreground text-xs", className)}
      data-testid="key-version"
    >
      <button
        className="underline underline-offset-2"
        disabled={pending}
        onClick={onPress}
        type="button"
      >
        {pending
          ? "Adding…"
          : mode === "connect"
            ? "Connect with a key instead"
            : "Add with a key instead"}
      </button>
      {pending
        ? null
        : ` for ${keyVersion.actionCount.toLocaleString()} ${keyVersion.actionCount === 1 ? "action" : "actions"}.`}
    </p>
  );
}

/**
 * The same offer on an app's own page, for the sign-in version of a directory app whose key version
 * isn't added yet. Drawn only for somebody who may add apps; the caller decides that.
 *
 * The directory is searched by the app's title and the entry is the one this app was added as.
 * Draws nothing until that answers, and nothing if it fails: the page is about the app in hand, and
 * this is only a second way to add it.
 *
 * `connect` adds the key version and opens its key form, as Browse apps does. `add` (Admin) adds it
 * and opens its page there.
 */
export function KeyVersionOffer({
  appId,
  title,
  mode,
}: {
  appId: string;
  title: string;
  mode: "connect" | "add";
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const paths = useManagePaths();
  const directory = useQuery(directoryAppsQueryOptions(title));
  const entry = keyVersionOffer(directory.data, appId);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    ...addDirectoryAppMutationOptions(queryClient),
    onMutate: () => setError(null),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: (keyAppId) =>
      mode === "connect"
        ? navigate({
            to: "/connections/$key",
            params: { key: keyAppId },
            search: { connect: true },
          })
        : navigate(paths.plugin(keyAppId)),
  });
  if (!entry?.keyVersion) return null;
  return (
    <>
      <KeyVersionLine
        // Inset as the notes under the rows are, so it lines up with their text.
        className="mt-3 px-3"
        keyVersion={entry.keyVersion}
        link={null}
        mode={mode}
        onPress={() =>
          add.mutate({ directoryEntryId: entry.id, connectsWith: "key" })
        }
        pending={add.isPending}
      />
      {error ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
