/**
 * This computer's own identity, asked of the local SPIRE agent.
 *
 * No identity is baked in. There is no key in the image and no secret in the environment: the computer
 * asks the agent over a unix socket, and the agent decides what it is by inspecting the container the
 * request came from and matching the label the supervisor set when it created it. So a computer
 * cannot claim to be a Bot it is not, and an unregistered container is issued nothing, which is
 * the property that makes this worth more than a name in a header.
 *
 * The `spiffe` package rather than a hand-rolled gRPC client: it is the maintained Node client for
 * the Workload API and gets the streaming semantics right.
 *
 * A deployment without SPIRE gets `null` and carries on. Identity is available where the deployment
 * supports it, not a condition of the computer running.
 */

const SOCKET = process.env.SPIFFE_ENDPOINT_SOCKET;

export type Identity = {
  spiffeId: string;
  /** How many identities this workload was issued, so an over-broad entry is visible rather than silent. */
  issued: number;
};

let cached: Identity | null = null;
let attempted = false;

/**
 * The Workload API is a stream that stays open for rotation. The first batch is the answer, so this
 * takes it and lets go rather than holding a subscription open for the life of the process.
 */
function firstSvid(
  socket: string,
  timeoutMs: number,
): Promise<Identity | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Identity | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    void (async () => {
      try {
        const { createClient } = (await import("spiffe")) as {
          createClient: (address: string) => {
            fetchX509SVID(request: Record<string, never>): {
              responses: {
                onMessage(
                  handler: (response: {
                    svids: { spiffeId: string }[];
                  }) => void,
                ): void;
                onError(handler: (error: unknown) => void): void;
              };
            };
          };
        };

        const client = createClient(`unix://${socket}`);
        const call = client.fetchX509SVID({});

        call.responses.onMessage((response) => {
          clearTimeout(timer);
          const first = response.svids?.[0];
          finish(
            first
              ? { spiffeId: first.spiffeId, issued: response.svids.length }
              : null,
          );
        });
        call.responses.onError(() => {
          clearTimeout(timer);
          finish(null);
        });
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    })();
  });
}

export async function identity(): Promise<Identity | null> {
  if (!SOCKET) return null;
  if (cached || attempted) return cached;
  attempted = true;

  cached = await firstSvid(SOCKET, 5_000);
  if (!cached) {
    // Once, not on every health check: worth knowing, not worth drowning the log.
    console.warn(
      "This computer has a SPIRE socket but was issued no identity. Either no entry matches its labels, or the agent is not answering.",
    );
  }
  return cached;
}
