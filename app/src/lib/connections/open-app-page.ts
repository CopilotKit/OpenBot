import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  appSetupQueryOptions,
  appsQueryOptions,
  catalogueQueryOptions,
} from "@/lib/apps/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { connectionsQueryOptions } from "@/lib/plugins/queries";

/**
 * The reads an app's page under Connections waits for before it draws anything: the apps, the
 * catalogue, how apps are set up here, the person's own connections, and which edition this is.
 */
export function appPageReads(queryClient: QueryClient): Promise<unknown> {
  /*
   * Asked once each, never retried here: a read that fails is the page's to say and to retry, and
   * the press must not wait out a retry's backoff before it goes there.
   */
  const once = { retry: false } as const;
  // Every read settles first: one that fails fast must not open the page while the rest are out.
  return Promise.allSettled([
    queryClient.ensureQueryData({ ...appsQueryOptions(), ...once }),
    queryClient.ensureQueryData({ ...catalogueQueryOptions(), ...once }),
    queryClient.ensureQueryData({ ...appSetupQueryOptions(), ...once }),
    queryClient.ensureQueryData({ ...connectionsQueryOptions(), ...once }),
    queryClient.ensureQueryData({
      ...deploymentCapabilitiesQueryOptions(),
      ...once,
    }),
  ]);
}

/**
 * OPEN AN APP'S PAGE ONLY ONCE IT HAS SOMETHING TO DRAW. Pressed from a Bot's Apps row or a card in
 * a conversation, Reconnect used to navigate at once to a page that is blank until its reads
 * answer, so the screen the person pressed on vanished for a few seconds. Now the press waits where
 * it was made, with its own pending state, and goes once those reads are in. A read that fails
 * goes anyway: the page says what failed, with its own Retry.
 *
 * `connect` opens the page with the connect started on arrival: the key form for a key app.
 */
export function useOpenAppPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [opening, setOpening] = useState<string | null>(null);

  async function open(key: string, connect: boolean) {
    setOpening(key);
    try {
      await appPageReads(queryClient).catch(() => undefined);
      await navigate({
        to: "/connections/$key",
        params: { key },
        ...(connect ? { search: { connect: true as const } } : {}),
      });
    } finally {
      setOpening(null);
    }
  }

  return { open, opening };
}
