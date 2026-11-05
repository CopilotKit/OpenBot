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
type ClientFactory<Actions, Options = undefined> = (
  apiKey: string,
  options: Options,
) => {
  actions: Actions;
  broker: ConnectedAppBroker;
};

/**
 * What Arcade's client is built with beside its key: the address its project's user verifier must
 * name for a consent to come back here, or nothing when this deployment does not know its own
 * origin (see {@link arcadeVerifierAddress}), and whether this install owns that project and so may
 * point the verifier at itself (see {@link ownsBrokerProject}).
 */
export type ArcadeClientOptions = {
  verifierUrl?: string;
  repointVerifier?: boolean;
};

/**
 * WHETHER THIS INSTALL OWNS ITS BROKER PROJECT, which is what lets it change a project-wide setting
 * such as Arcade's user verifier.
 *
 * A single-user install does. It has its own name at the broker (`ensureSingleUserIdentity` gives
 * every one of them one, on the first start with a broker), its one person is its admin, and the
 * personal edition is one of these. A deployment that signs people in does not: its key's project
 * is treated as shared, so a setting there is an admin's to make by hand, and this deployment only
 * checks it.
 */
export function ownsBrokerProject(c: { singleUser?: boolean }): boolean {
  return c.singleUser === true;
}

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
    /** This deployment's public origin, which Arcade's verifier must name. See `config.ts`. */
    publicUrl?: string;
    /** Single-user mode, which is what makes the broker project this install's own. */
    singleUser?: boolean;
  },
  create: {
    composio: ClientFactory<ComposioActions>;
    arcade: ClientFactory<ArcadeActions, ArcadeClientOptions>;
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
    const verifierUrl = arcadeVerifierAddress(c.publicUrl);
    const client = create.arcade(
      requiredKey(provider, c.arcadeApiKey, "ARCADE_API_KEY"),
      verifierUrl ? { verifierUrl, repointVerifier: ownsBrokerProject(c) } : {},
    );
    return {
      provider,
      broker: client.broker,
      install: { composio: null, arcade: client.actions },
    };
  }
  const client = create.composio(
    requiredKey(provider, c.composioApiKey, "COMPOSIO_API_KEY"),
    undefined,
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
 * This deployment's verify address, which its Arcade client points the project's user verifier at
 * before each consent it mints (`pointVerifierHere` in `./arcade-adapter`). Undefined when the
 * deployment does not know its own public origin.
 *
 * Takes the configured public origin (`OPENBOT_PUBLIC_URL`, else `BETTER_AUTH_URL`, already stripped
 * of trailing slashes by config); the strip is repeated here so a caller cannot double the slash.
 */
export function arcadeVerifierAddress(
  publicUrl: string | undefined,
): string | undefined {
  const origin = publicUrl?.trim().replace(/\/+$/, "");
  return origin ? `${origin}${ARCADE_VERIFY_PATH}` : undefined;
}

/**
 * The startup line an Arcade deployment prints about its project's user verifier, and null when
 * there is nothing to say.
 *
 * ARCADE'S VERIFIER IS READ AND SET THROUGH ITS API. `GET` and `PUT
 * /v1/admin/settings/session_verification` read and write the project's `verifier_url` with the same
 * key every other call here uses. It used to say Arcade had no such API, and every deployment not
 * at the address somebody had pasted into the dashboard sent people to a 404 after their consent.
 *
 * AN INSTALL THAT OWNS ITS PROJECT AND KNOWS ITS ORIGIN SAYS NOTHING: it points the verifier at
 * itself before every consent. A deployment that signs people in treats the project as shared and
 * never changes it, so it says once which address an admin sets, because Connect refuses until the
 * project names it. WITHOUT AN ORIGIN neither can be done, and it says which variable to set.
 */
export function arcadeVerifierNotice(
  publicUrl: string | undefined,
  { ownsProject }: { ownsProject: boolean },
): string | null {
  const address = arcadeVerifierAddress(publicUrl);
  if (!address) {
    return `Arcade is the active broker, but OPENBOT_PUBLIC_URL and BETTER_AUTH_URL are both unset, so this deployment does not know its own origin and cannot check that its Arcade project's user verifier names <this deployment's public origin>${ARCADE_VERIFY_PATH}. A consent will come back to whatever address the project names, and anywhere else that is a page that does not exist. Set OPENBOT_PUBLIC_URL; see docs/plugins/arcade.md, "The verifier URL".`;
  }
  if (ownsProject) return null;
  return `Arcade is the active broker and this deployment signs people in, so it treats its Arcade project as shared and never changes the project's user verifier. Connect checks it before every consent and refuses until it names ${address}. Set the custom verifier to that address in Arcade's dashboard (Auth, Settings); see docs/plugins/arcade.md, "The verifier URL".`;
}
