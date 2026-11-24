import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useConnectInNewTab } from "@/components/plugins/connect-in-new-tab";
import { requestAppMutationOptions } from "@/lib/app-access/mutations";
import {
  addDirectoryAppMutationOptions,
  type DirectoryAppInput,
} from "@/lib/apps/mutations";
import { type DirectoryApp, directorySlug } from "@/lib/apps/queries";
import { directoryConnect } from "@/lib/plugins/directory-state";
import { invalidatePlugins } from "@/lib/plugins/mutations";
import { connectionsQueryOptions } from "@/lib/plugins/queries";

/**
 * What one press of an app from the directory does, for the person pressing it.
 *
 * - `connect`: somebody who may add apps (the personal edition's one person, or an admin of their
 *   organization, OpenBot Cloud's usual case) adds it and connects their own account in the same
 *   press. An app that signs in opens its sign-in in a tab claimed on the click; one that takes a
 *   key opens its page with the key form; one that needs no account is simply added.
 * - `add`: Admin's own directory. Adding is the admin's act for everybody, and each person connects
 *   their own account afterwards.
 * - `request`: a member, who can't add apps, asks an admin to add it.
 */
export type DirectoryPressMode = "connect" | "add" | "request";

/**
 * The press, shared by Browse apps and Connections' search so the two can never do different things
 * with the same app.
 *
 * ONE MUTATION SERVES EVERY ROW, so which rows are mid-request is held beside it in sets that
 * survive a second press: the observer's own `isPending` and `variables` name only the latest one.
 * Its `onError` still fires after a second press replaces the first, which is why the refusal is
 * kept here and not read off the observer.
 */
export function useDirectoryPress(mode: DirectoryPressMode) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tab = useConnectInNewTab();
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(new Set());
  const [requesting, setRequesting] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  /** The entry whose sign-in is open, so only its row says it is waiting. */
  const [signingIn, setSigningIn] = React.useState<string | null>(null);
  /** The app that sign-in is for, once it has an id, for an app that turned out to take a key. */
  const signingInServer = React.useRef<string | null>(null);

  const held = (set: ReadonlySet<string>, id: string) => new Set(set).add(id);
  const released = (set: ReadonlySet<string>, id: string) => {
    const left = new Set(set);
    left.delete(id);
    return left;
  };

  const enable = useMutation({
    ...addDirectoryAppMutationOptions(queryClient),
    onMutate: (input: { directoryEntryId: string }) => {
      setError(null);
      setAdding((set) => held(set, input.directoryEntryId));
    },
    onError: (thrown: Error) => setError(thrown.message),
    // Spelled out: a second `onSettled` replaces the spread one, and its refetch is what turns the
    // added row into its connection state.
    onSettled: (_data, _error, input) => {
      setAdding((set) => released(set, input.directoryEntryId));
      return invalidatePlugins(queryClient);
    },
  });
  /*
   * THE KEY VERSION'S OWN ADD, for an entry listed as a sign-in in place of its key. A mutation of its
   * own and a set of its own, so the row's primary button never reads "Adding…" for it.
   */
  const [addingKey, setAddingKey] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const enableKey = useMutation({
    ...addDirectoryAppMutationOptions(queryClient),
    onMutate: (input: DirectoryAppInput) => {
      setError(null);
      setAddingKey((set) => held(set, input.directoryEntryId));
    },
    onError: (thrown: Error) => setError(thrown.message),
    onSettled: (_data, _error, input) => {
      setAddingKey((set) => released(set, input.directoryEntryId));
      return invalidatePlugins(queryClient);
    },
  });
  const request = useMutation({
    ...requestAppMutationOptions(queryClient),
    onMutate: (slug: string) => {
      setError(null);
      setRequesting((set) => held(set, slug));
    },
    onError: (thrown: Error) => setError(thrown.message),
    onSettled: (_data, _error, slug) => {
      setRequesting((set) => released(set, slug));
      return queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });

  const openKeyForm = React.useCallback(
    (serverId: string) =>
      void navigate({
        to: "/connections/$key",
        params: { key: serverId },
        search: { connect: true },
      }),
    [navigate],
  );

  // A sign-in that turned out to want a key: the app's page, with the form open.
  React.useEffect(() => {
    if (!tab.needsKey || !signingInServer.current) return;
    if (mode === "connect") openKeyForm(signingInServer.current);
  }, [tab.needsKey, mode, openKeyForm]);

  /*
   * WATCHED WHILE THE SIGN-IN IS OPEN in the other tab: the connections are read again every two
   * seconds, and whoever draws the rows ends the wait once the app reads connected. Coming back
   * from the tab proves nothing, so the server is what is asked.
   */
  const { waiting } = tab;
  React.useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: connectionsQueryOptions().queryKey,
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting, queryClient]);

  const { stopWaiting } = tab;
  /** The sign-in this press opened has finished: the row reads connected. */
  const signedIn = React.useCallback(() => {
    stopWaiting();
    setSigningIn(null);
  }, [stopWaiting]);

  /** Start this person's own sign-in to an app that is already added. */
  const connect = (entryId: string, serverId: string) => {
    setError(null);
    stopWaiting();
    setSigningIn(entryId);
    signingInServer.current = serverId;
    tab.open(serverId);
  };

  /** One press of an app nobody has added yet. */
  const press = (entry: DirectoryApp) => {
    if (mode === "request") {
      const slug = directorySlug(entry.id);
      if (slug) request.mutate(slug);
      return;
    }
    const how = directoryConnect(entry);
    if (mode === "connect" && how === "sign-in") {
      setError(null);
      stopWaiting();
      setSigningIn(entry.id);
      signingInServer.current = null;
      void tab.openAfter(async () => {
        const serverId = await enable.mutateAsync({
          directoryEntryId: entry.id,
        });
        signingInServer.current = serverId;
        return serverId;
      });
      return;
    }
    if (mode === "connect" && how === "key") {
      enable
        .mutateAsync({ directoryEntryId: entry.id })
        .then(openKeyForm, () => {
          // Said by the mutation's own `onError`.
        });
      return;
    }
    enable.mutate({ directoryEntryId: entry.id });
  };

  /**
   * One press of "with a key instead": add the entry's key version as its own app. In `connect` it
   * goes on to that app's key form, as a key app's Add does; in `add` it only adds. A member asks
   * for apps and adds none, so `request` does nothing.
   */
  const pressKey = (entry: DirectoryApp) => {
    if (mode === "request") return;
    const added = enableKey.mutateAsync({
      directoryEntryId: entry.id,
      connectsWith: "key",
    });
    if (mode === "connect")
      added.then(openKeyForm, () => {
        // Said by the mutation's own `onError`.
      });
    else
      added.catch(() => {
        // Said by the mutation's own `onError`.
      });
  };

  return {
    mode,
    press,
    pressKey,
    connect,
    signedIn,
    /** Entry ids being added. */
    adding,
    /** Entry ids whose key version is being added. */
    addingKey,
    /** Slugs being asked for. */
    requesting,
    signingIn,
    tab,
    /** What the last refused press said, or the sign-in's own refusal for the row waiting on it. */
    error: error ?? (signingIn ? tab.error : null),
  };
}

export type DirectoryPress = ReturnType<typeof useDirectoryPress>;
