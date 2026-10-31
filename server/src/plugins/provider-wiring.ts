import { BROKERED_PROFILE, type BrokerProvider } from "./access";
import type { ArcadeActions } from "./arcade";
import {
  type ConnectedAppBroker,
  type ProviderDecision,
  providerDecision,
} from "./broker";
import type { ComposioActions } from "./composio";

/**
 * The entrypoint's provider decision, with the vendor constructors passed in so this file imports
 * no vendor package and a test can answer without booting the server or making a request.
 */
type ClientFactory<Actions> = (apiKey: string) => {
  actions: Actions;
  broker: ConnectedAppBroker;
};

export type ProviderWiring = {
  /** The one active provider, or `null` for a deployment that legitimately has no broker. */
  provider: BrokerProvider | null;
  /** The one broker handed to the store and the routes; `null` exactly when `provider` is. */
  broker: ConnectedAppBroker | null;
  /** Both transport seams, always both: the one that is not active is explicitly `null`. */
  install: { composio: ComposioActions | null; arcade: ArcadeActions | null };
};

/**
 * Chooses ONE provider from configuration and builds only that provider's client.
 *
 * {@link providerDecision} answers one of four kinds, and this function has exactly one outcome for
 * each, which is the point: the three causes of "no provider" were a single `null` before, and
 * every caller that then wrote `?? "composio"` turned the one cause that can hold Arcade rows into
 * "Composio is active".
 *
 * `active` wires that provider. `unconfigured` — no key at all — is the ONLY one wired to nothing:
 * nobody configured a broker, so having none is the answer the configuration asked for.
 *
 * `misnamed` AND `ambiguous` ARE REFUSED RATHER THAN DEGRADED. A named provider whose key is unset
 * or blank is an operator typo. Both keys set with nothing named is an operator half-way through a
 * switch who has not said which vendor is live — not a state anybody wants on purpose, because the
 * deployment comes up holding two vendor keys and brokering nothing, so every brokered feature is
 * dead. Returning null wiring for either would be a failure nobody is told about at boot: the
 * symptom surfaces much later and far away, as features that simply do not work, and sends an
 * operator looking for a broken vendor instead of at their own environment. Both are refused here,
 * naming the variables and never a value.
 *
 * BOTH-KEYS IS COUNTED WITH `credential`, inside {@link providerDecision}, not with
 * `!== undefined`. A deployment holding two BLANK keys has configured no vendor at all, and must be
 * told that rather than that both of its vendors are set.
 *
 * NO BRANCH BELOW REACHES NULL WIRING BY FALLING THROUGH. The one null wiring is returned from the
 * branch that means it, and a selected provider whose key is somehow absent throws rather than
 * quietly becoming the same thing — see the invariant below.
 */
export function selectProviderWiring(
  c: {
    composioApiKey?: string;
    arcadeApiKey?: string;
    brokerProvider?: BrokerProvider;
  },
  create: {
    composio: ClientFactory<ComposioActions>;
    arcade: ClientFactory<ArcadeActions>;
  },
): ProviderWiring {
  const decision = providerDecision(c);
  if (decision.kind === "misnamed") {
    const keyName = BROKERED_PROFILE[decision.named].envVar;
    throw new Error(
      `OPENBOT_BROKER_PROVIDER=${decision.named} names a provider whose ${keyName} is not set to a key. Set ${keyName} to this deployment's key, or change or unset OPENBOT_BROKER_PROVIDER.`,
    );
  }
  if (decision.kind === "ambiguous") {
    throw new Error(
      "COMPOSIO_API_KEY and ARCADE_API_KEY are both set and OPENBOT_BROKER_PROVIDER is unset, so no provider is active and nothing brokered would work. Set OPENBOT_BROKER_PROVIDER to composio or arcade to say which vendor is live, or unset the key of the vendor this deployment is not using.",
    );
  }
  if (decision.kind === "unconfigured") {
    // Neither key set: a deployment that asked for no broker, and gets exactly that.
    return {
      provider: null,
      broker: null,
      install: { composio: null, arcade: null },
    };
  }
  const provider = decision.provider;
  if (provider === "arcade") {
    const client = create.arcade(
      requiredKey(provider, c.arcadeApiKey, "ARCADE_API_KEY"),
    );
    return {
      provider,
      broker: client.broker,
      install: { composio: null, arcade: client.actions },
    };
  }
  const client = create.composio(
    requiredKey(provider, c.composioApiKey, "COMPOSIO_API_KEY"),
  );
  return {
    provider,
    broker: client.broker,
    install: { composio: client.actions, arcade: null },
  };
}

/**
 * The key a selected provider must have, demanded rather than tested.
 *
 * {@link providerDecision} selects a provider only from a key it has seen, so this cannot fire today.
 * It is written as a demand because of what the alternative WAS: the two branches above each
 * carried `&& c.<vendor>ApiKey !== undefined`, which made a selected provider with no key fall
 * through to null wiring — the broker silently unwired, by the very code whose job is to wire it.
 * A narrowing that doubles as a silent exit is the shape this finding is about, so the narrowing is
 * kept and the exit is removed: if the two ever disagree, the deployment says so at boot.
 */
function requiredKey(
  provider: BrokerProvider,
  apiKey: string | undefined,
  keyName: string,
): string {
  if (apiKey !== undefined) return apiKey;
  throw new Error(
    `${provider} was selected as the broker but ${keyName} is not set. This is a bug in provider selection, not a configuration error; no broker was wired.`,
  );
}

/**
 * WHICH SLICE of `brokered_connections` this deployment's stores read and write, which is a
 * different question from which broker is active, and has an answer where that one has none.
 *
 * CONFIGURATION FIRST, THEN THE ROWS, AND NEVER A VENDOR PICKED OUT OF THE AIR. An active provider
 * is the answer. Where configuration names none — a broker key withdrawn after rows were made —
 * the rows this deployment actually holds name it instead. That is the whole fix: `?? "composio"`
 * answered "Composio" for a deployment whose every connection is an Arcade one, so those rows were
 * filtered out of every read, parsed with the wrong parser, and the live accounts behind them could
 * be neither seen nor revoked. Asking the rows cannot be wrong about them, because they are what is
 * being named.
 *
 * AMBIGUOUS CONFIGURATION NEVER REACHES HERE AT BOOT. {@link selectProviderWiring} refuses both
 * keys set with nothing named before any store is built, so the `ambiguous` arm below is reachable
 * only by a direct caller (a test). What DOES reach here is `unconfigured` — no key at all — where
 * rows can still outlive a withdrawn key and must be read as their own provider's.
 *
 * ROWS AT BOTH VENDORS WITH NOTHING ACTIVE IS REFUSED, which is {@link assertActivatable}'s refusal
 * from the other side: that one stops a deployment activating one provider while the other holds
 * rows, and this one stops a deployment reading one vendor's rows as the other's while NOTHING is
 * active. Neither can be got past from inside the deployment: with rows at both vendors every
 * provider's activation is refused, so the refusal says so and names the manual way out — end one
 * vendor's accounts in its own dashboard and delete those rows — rather than a flow that is not built.
 *
 * AND NO ROWS AT ALL NAMES AN EMPTY SLICE. A `BrokerProvider` has to be spelled, and with no row of
 * either vendor there is no row to misfile: every `eq(provider, …)` selects nothing whichever name
 * is used, and no row can appear while this holds, because writing one needs a live broker and
 * there is none. The name is a label on an empty set, not a claim that Composio is active — what
 * answers that is `providerWiring.broker`, which is `null` here.
 */
export function storedProvider(
  decision: ProviderDecision,
  rowOwners: BrokerProvider[],
): BrokerProvider {
  if (decision.kind === "active") return decision.provider;
  if (decision.kind === "misnamed") {
    // Unreachable: `selectProviderWiring` stops the server on this before any store is built.
    throw new Error(
      `OPENBOT_BROKER_PROVIDER=${decision.named} names a provider whose ${BROKERED_PROFILE[decision.named].envVar} is not set.`,
    );
  }
  const owners = [...new Set(rowOwners)];
  if (owners.length > 1) {
    const counted = owners
      .map((owner) => BROKERED_PROFILE[owner].vendor)
      .join(" and ");
    throw new Error(
      `This deployment holds brokered connections at ${counted}, and nothing names which provider is active: ${
        decision.kind === "ambiguous"
          ? `${decision.configured.map((p) => BROKERED_PROFILE[p].envVar).join(" and ")} are both set and OPENBOT_BROKER_PROVIDER is unset`
          : "no broker API key is set"
      }. Nothing in this deployment can end them while both are held: activating either provider is refused while the other still holds connections. End one vendor's accounts in that vendor's own dashboard and delete its rows from brokered_connections by hand, then set OPENBOT_BROKER_PROVIDER to the other.`,
    );
  }
  const owner = owners[0];
  if (owner !== undefined) return owner;
  // No rows of either vendor. See the last paragraph above: this labels an empty set.
  return "composio";
}

/**
 * Where Arcade's custom user verifier must point: the plugin routes are mounted at `/api/plugins`
 * (`app.ts`) and the verify route is `/arcade/verify` on them (`route-groups/connections.ts`).
 */
export const ARCADE_VERIFY_PATH = "/api/plugins/arcade/verify";

/**
 * The startup warning an Arcade deployment prints about its verifier, because nothing can check it.
 *
 * THE SETTING IS NOT READABLE. Which verifier an Arcade project uses is set by hand in Arcade's
 * dashboard, and neither the SDK this deployment pins (`@arcadeai/arcadejs`, whose admin surface is
 * auth providers, secrets and user connections) nor Arcade's documented API reads it back. So the
 * deployment cannot tell a correctly pointed project from one left at Arcade's built-in verifier,
 * and says so once at startup rather than staying silent about the one step it depends on.
 *
 * LEFT AT THE DEFAULT, THIS DEPLOYMENT'S VERIFY ROUTE IS NEVER CALLED. That route is the return leg
 * that binds a consent to the attempt that started it, records the connection and files its audit
 * entry; with Arcade's own verifier none of that runs, and nothing in this deployment's logs says so.
 *
 * Takes the configured public origin (`OPENBOT_PUBLIC_URL`, else `BETTER_AUTH_URL`, already stripped
 * of trailing slashes by config) and names the exact address to paste, or says which variable is
 * missing when there is none.
 */
export function arcadeVerifierNotice(publicUrl: string | undefined): string {
  const address = publicUrl
    ? `${publicUrl.replace(/\/+$/, "")}${ARCADE_VERIFY_PATH}`
    : `<this deployment's public origin>${ARCADE_VERIFY_PATH} (OPENBOT_PUBLIC_URL and BETTER_AUTH_URL are both unset, so this deployment does not know its own origin; set one)`;
  return `Arcade is the active broker, and this deployment cannot check which user verifier its Arcade project uses: Arcade has no API that reads that setting. Unless the project's verifier is set to custom, pointing at ${address}, this deployment's verify route is never called: no consent is bound to the attempt that started it, and none is recorded or audited when it returns. Set it in the Arcade dashboard; see docs/plugins/arcade.md, "The verifier URL is the one dashboard-only step".`;
}
