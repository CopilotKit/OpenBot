import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { DeploymentConfig } from "../config";
import type { CredentialStatusReader } from "../credentials";
import { entitlementWarning } from "../intelligence-entitlement-check";
import type { ModelCheckOutcome } from "../model-availability-check";
import type { BrokerProvider } from "../plugins/access";
import type { RuntimeEntitlementResponse } from "../self-host-banner";

/**
 * The setup checklist: one row for each thing this deployment depends on, and what it says about it.
 *
 * Onboarding's "Check your setup" step draws it. It answers what an admin is about to ask after a
 * first run, "what is set up, and what still needs doing", from the server's own configuration and
 * state rather than from a list the app keeps.
 *
 * READY MEANS IT WORKS, NOT THAT SOMETHING IS SET. Intelligence is read from its own entitlement
 * answer (the server cannot boot without its address, so "set" would always be true), and the model
 * from the provider's answer for the key in use now (a key that is present can still be refused). A
 * key nobody has asked the provider about says so ("not checked yet") rather than Ready.
 *
 * PRESENCE AND VERDICTS, NEVER A VALUE. Every fact below is a yes, a no or a state word. A key is
 * "set" because the environment or the vault has one, and nothing here reads, masks, measures or
 * echoes what it is. The two outbound reads, Intelligence's entitlement and one `GET /v1/models/<id>`
 * at the provider, are the ones the server already makes at boot; "Check again" repeats them, at
 * most once every {@link RECHECK_INTERVAL_MS}. A plain read repeats them too, under the same limit,
 * once an answer has failed or is older than {@link ANSWER_KEPT_MS}, for the read after it.
 *
 * WHO READS IT DECIDES WHAT IT SAYS. An admin, and somebody trying OpenBot alone on their own
 * machine, is told how to fix each gap: the page to open, or the variable to set. Everybody else is
 * told whether it works and that their admin sets it up, and the response they receive carries no
 * variable name at all. That is the copy rule's line ("Admin is allowed exact names") drawn by the
 * reader rather than by the page: onboarding is a page anybody opens, so the server decides per
 * reader and a member's browser never holds the deployment's configuration vocabulary.
 *
 * Ported from OpenDuet's checklist without its Google rows: OpenBot does not ship a Google app, and
 * a person's own apps are the Connect your apps step's to draw.
 */

/** The guides a fix links to. The repository is where the docs ship from. */
const DOCS = "https://github.com/CopilotKit/openbot/blob/main/docs";
const QUICK_START = "https://github.com/CopilotKit/openbot#quick-start";

/** How long a "Check again" is answered from the last one, so a held button is not a flood. */
export const RECHECK_INTERVAL_MS = 10_000;

/** How long a working answer from another service is served before a read asks again. */
export const ANSWER_KEPT_MS = 5 * 60_000;

/** How long Intelligence has to answer before the row says it could not be reached. */
const INTELLIGENCE_TIMEOUT_MS = 5_000;

export type SetupRowId =
  | "intelligence"
  | "model"
  | "computer"
  | "apps"
  | "chat";

/**
 * How a gap is closed, or null when there is nothing for the reader to do.
 *
 * - `env`: variables to set on the server, by name, and a guide. Only ever sent to an admin.
 * - `page`: a screen in the app that closes it. `path` is in-app, never another origin.
 */
export type SetupFix =
  | {
      kind: "env";
      names: string[];
      docsUrl: string;
      /** A screen that does the same job, where there is one. */
      page?: { label: string; path: string };
    }
  | { kind: "page"; label: string; path: string; docsUrl?: string };

/**
 * What a row says about its dependency.
 *
 * `ready` works, as far as anything here can tell. `needs_setup` does not, and the row says why.
 * `not_checked` is set up, but nobody has asked whether it works: a model key added since the server
 * started, or one behind a custom endpoint the provider's own check cannot reach.
 */
export type SetupStatus = "ready" | "needs_setup" | "not_checked";

export type SetupRow = {
  id: SetupRowId;
  /** Every row today is the admin's to set up. Kept so a person's own row can join without a shape change. */
  scope: "deployment";
  title: string;
  /** True only where the product cannot answer without it. */
  required: boolean;
  status: SetupStatus;
  /** `status === "ready"`, for a reader that only asks yes or no. */
  ready: boolean;
  /** One sentence: what it gives you when ready, what happens without it when not. */
  detail: string;
  fix: SetupFix | null;
};

export type SetupChecklist = {
  /** `admin` for an admin or a local single-person install; `member` for everybody else. */
  audience: "admin" | "member";
  rows: SetupRow[];
};

/** What Intelligence said about this deployment. See {@link intelligenceFact}. */
export type IntelligenceFact =
  | { state: "ready" }
  /** It answered, and did not confirm the entitlement. `advice` is the admin's next step. */
  | { state: "refused"; advice: string }
  /** It did not answer in time, or the read failed. */
  | { state: "unreachable" };

/**
 * What the model provider said about the key in use now.
 *
 * `not_checked` when nobody has asked about this key (one added since the last check) or the
 * provider did not answer; `cannot_check` when the key sits behind a custom endpoint, which the
 * provider's own model lookup cannot vouch for.
 */
export type ModelVerdict =
  | "available"
  | "refused_key"
  | "refused_model"
  | "not_checked"
  | "cannot_check";

/**
 * Everything the rows are decided from. Booleans, names and state words, never a value: see the
 * module comment.
 */
export type SetupFacts = {
  intelligence: IntelligenceFact;
  model: {
    provider: "openai" | "anthropic";
    /** Where the key the Bots answer with comes from, or null when there is none. */
    source: "plan" | "credential" | "environment" | null;
    verdict: ModelVerdict;
    /** The model the Bots run on, named when the key cannot use it. */
    model: string;
  };
  /** A Bot computer is configured. Absent, its routes are not mounted at all. */
  computer: boolean;
  computerStatus?: SetupStatus;
  /** A broker for apps beyond the ones an admin adds, and which one this deployment would use. */
  apps: { configured: boolean; provider: BrokerProvider };
  /** The OpenTag pairing that carries Slack and Microsoft Teams. */
  chat: boolean;
};

const KEY_NAME = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;
const PROVIDER_NAME = { openai: "OpenAI", anthropic: "Anthropic" } as const;
const BROKER = {
  composio: { key: "COMPOSIO_API_KEY", docs: `${DOCS}/plugins/composio.md` },
  arcade: { key: "ARCADE_API_KEY", docs: `${DOCS}/plugins/arcade.md` },
} as const;

/** What a member is told about a dependency that is set up and was never checked. */
const MEMBER_NOT_CHECKED = "Set up, not checked yet.";

/** The rows for one reader. Pure, so every branch can be pinned without a server. */
export function setupRows(
  facts: SetupFacts,
  options: { productName: string; audience: "admin" | "member" },
): SetupRow[] {
  const { productName: product, audience } = options;
  const admin = audience === "admin";

  /**
   * A row as its reader should see it. A member is told it works, that it is not checked yet, or
   * that their admin sets it up, and is handed no fix: the variable names stay on the server.
   */
  const deployment = (row: {
    id: SetupRowId;
    title: string;
    required: boolean;
    status: SetupStatus;
    readyDetail: string;
    gapDetail: string;
    fix: SetupFix | null;
  }): SetupRow => ({
    id: row.id,
    scope: "deployment",
    title: row.title,
    required: row.required,
    status: row.status,
    ready: row.status === "ready",
    detail:
      row.status === "ready"
        ? row.readyDetail
        : admin
          ? row.gapDetail
          : row.status === "not_checked"
            ? MEMBER_NOT_CHECKED
            : "Your admin sets this up.",
    fix: row.status === "ready" || !admin ? null : row.fix,
  });

  const broker = BROKER[facts.apps.provider];

  return [
    deployment({
      id: "intelligence",
      title: "CopilotKit Intelligence",
      required: true,
      ...intelligenceRow(facts.intelligence, product),
    }),
    deployment({
      id: "model",
      title: "AI model",
      required: true,
      ...modelRow(facts.model, product),
    }),
    deployment({
      id: "computer",
      title: "Bot computer",
      required: false,
      ...computerRow(
        facts.computer
          ? (facts.computerStatus ?? "not_checked")
          : "needs_setup",
      ),
    }),
    deployment({
      id: "apps",
      title: "More apps",
      required: false,
      status: facts.apps.configured ? "ready" : "needs_setup",
      readyDetail: "People can connect more apps than the ones an admin adds.",
      gapDetail: "Without it, people can connect only the apps an admin adds.",
      fix: { kind: "env", names: [broker.key], docsUrl: broker.docs },
    }),
    deployment({
      id: "chat",
      title: "Slack and Teams",
      required: false,
      status: facts.chat ? "ready" : "needs_setup",
      readyDetail: `People can talk to ${product} in Slack and Microsoft Teams.`,
      gapDetail: `Without it, people can talk to ${product} only here.`,
      fix: {
        kind: "env",
        names: ["OPENTAG_SHARED_SECRET", "OPENTAG_URL"],
        docsUrl: `${DOCS}/configuration.md#slack-and-microsoft-teams-opentag-pairing`,
      },
    }),
  ];
}

const INTELLIGENCE_VARIABLES = [
  "INTELLIGENCE_API_URL",
  "INTELLIGENCE_GATEWAY_WS_URL",
  "INTELLIGENCE_API_KEY",
];

/**
 * Intelligence as its own entitlement answer says. Its advice is the admin's sentence the boot log
 * already prints (`entitlementWarning`), which names the licence and where it goes.
 */
function intelligenceRow(fact: IntelligenceFact, product: string) {
  const readyDetail = `Keeps your conversations and what ${product} remembers.`;
  if (fact.state === "ready")
    return {
      status: "ready" as const,
      readyDetail,
      gapDetail: "",
      fix: null,
    };
  if (fact.state === "refused")
    return {
      status: "needs_setup" as const,
      readyDetail,
      gapDetail: fact.advice,
      fix: null,
    };
  return {
    status: "needs_setup" as const,
    readyDetail,
    gapDetail: `${product} couldn't reach Intelligence, so conversations and memory may fail. Check again in a moment, or check its address and key.`,
    fix: {
      kind: "env" as const,
      names: INTELLIGENCE_VARIABLES,
      docsUrl: QUICK_START,
    },
  };
}

/**
 * The Bot computer row. Not checked is the usual state of one that is set up: a computer starts
 * when a Bot first needs one, and until then none is running to ask. Its fix is the page where
 * computers show up, because the variables are already set.
 */
function computerRow(status: SetupStatus) {
  const readyDetail = "Bots can browse the web and work with files.";
  if (status === "not_checked")
    return {
      status,
      readyDetail,
      gapDetail:
        "Set up. No computer is running yet, so there's nothing to check.",
      fix: {
        kind: "page" as const,
        label: "Computers",
        path: "/admin/computers",
      },
    };
  return {
    status,
    readyDetail,
    gapDetail: "Without it, Bots can't browse the web or work with files.",
    fix: {
      kind: "env" as const,
      names: ["AGENT_COMPUTER_URL", "COMPUTER_TOKEN"],
      docsUrl: `${DOCS}/configuration.md#computer-and-supervisor`,
    },
  };
}

/** The model row, from where its key comes from and what the provider last said about that key. */
function modelRow(model: SetupFacts["model"], product: string) {
  const provider = PROVIDER_NAME[model.provider];
  const fix: SetupFix = {
    kind: "env",
    names: [KEY_NAME[model.provider]],
    docsUrl: QUICK_START,
    page: { label: "Credentials", path: "/admin/credentials" },
  };
  const readyDetail = `Lets ${product} answer you.`;
  if (model.source === null)
    return {
      status: "needs_setup" as const,
      readyDetail,
      gapDetail: `Without a model key, ${product} can't answer.`,
      fix,
    };
  // A subscription plan answers without a key of ours, so there is no key to ask about.
  if (model.source === "plan")
    return { status: "ready" as const, readyDetail, gapDetail: "", fix };
  switch (model.verdict) {
    case "available":
      return { status: "ready" as const, readyDetail, gapDetail: "", fix };
    case "refused_key":
      return {
        status: "needs_setup" as const,
        readyDetail,
        gapDetail: `${provider} refused the model key, so ${product} can't answer.`,
        fix,
      };
    case "refused_model":
      return {
        status: "needs_setup" as const,
        readyDetail,
        gapDetail: `The model key can't use ${model.model}, so ${product} can't answer.`,
        fix,
      };
    case "cannot_check":
      return {
        status: "not_checked" as const,
        readyDetail,
        gapDetail: `Key set. It uses a custom endpoint, which ${product} can't check.`,
        fix: null,
      };
    case "not_checked":
      return {
        status: "not_checked" as const,
        readyDetail,
        gapDetail: `Key set, not checked yet. Check again to ask ${provider}.`,
        fix: null,
      };
  }
}

/**
 * What an entitlement answer, or a failed read, means for the Intelligence row. Ready only when
 * Intelligence answered ready and active, which is what `entitlementWarning` returns null for.
 */
export function intelligenceFact(
  answer: RuntimeEntitlementResponse | Error,
): IntelligenceFact {
  if (answer instanceof Error) return { state: "unreachable" };
  const warning = entitlementWarning(answer);
  return warning
    ? { state: "refused", advice: warning.fix }
    : { state: "ready" };
}

/**
 * The provider's answer about the key in use now.
 *
 * A check about another key says nothing about this one: the stamp names the key the check was
 * made with (see {@link modelKeyOf}), and a key added or rotated since is "not checked yet". Only a
 * definite answer counts: a 401 or 403 on the key, a 404 on the model, a 2xx. "Could not ask" is
 * not evidence either way.
 */
export function modelVerdict(
  check: { outcome: ModelCheckOutcome; stamp: string | null } | undefined,
  stamp: string | null,
): ModelVerdict {
  if (!check || stamp === null || check.stamp !== stamp) return "not_checked";
  const { outcome } = check;
  if (outcome.kind === "available") return "available";
  // Skipped with a key in hand means a custom endpoint: the provider's own lookup cannot vouch.
  if (outcome.kind === "skipped") return "cannot_check";
  if (outcome.line.type === "model-credential-rejected") return "refused_key";
  if (outcome.line.type === "model-unavailable") return "refused_model";
  return "not_checked";
}

/**
 * Where the key the built-in Bots answer with comes from, in the order the runtime resolves it, and
 * a stamp naming that one key.
 *
 * The stamp is what tells a check about this key from a check about the one before it: the vault
 * row's id (rotating a key writes a new row), or the source's name for the environment and a plan,
 * which cannot change without a restart. An id, never anything read from the secret.
 */
export async function modelKeyOf(input: {
  plan: boolean;
  provider: "openai" | "anthropic";
  keyId: string;
  credentials: CredentialStatusReader;
  environment: Record<string, string | undefined>;
}): Promise<{
  source: SetupFacts["model"]["source"];
  stamp: string | null;
}> {
  // A subscription plan answers without any key (see `planModelForEnvironment`).
  if (input.plan) return { source: "plan", stamp: "plan" };
  // The vault before the environment, as `resolveModelApiKey` reads them. Statuses only: the list
  // carries no secret, so nothing here could hold one even by mistake.
  const stored = (await input.credentials.list()).find(
    (credential) =>
      credential.kind === "model" &&
      credential.provider === input.provider &&
      credential.keyId === input.keyId &&
      credential.revokedAt === null,
  );
  if (stored) return { source: "credential", stamp: `credential:${stored.id}` };
  return input.environment[KEY_NAME[input.provider]]?.trim()
    ? { source: "environment", stamp: "environment" }
    : { source: null, stamp: null };
}

/** What the route needs: the product's name, the facts, and a way to ask again. */
export type SetupSources = {
  productName: string;
  /** A local install for one person, whose only reader is the person running it. */
  localEvaluation: boolean;
  /**
   * The facts, from the last answers that are all in. Reading them also asks again, in the
   * background, when one of those answers failed or is older than {@link ANSWER_KEPT_MS}.
   */
  facts: () => Promise<SetupFacts>;
  /** Ask Intelligence, the model provider and the computers again. Resolves when all have answered. */
  recheck: () => Promise<void>;
};

/** A promise that gives up after `ms`, as an Error, so a slow service reads as unreachable. */
function withinTime<T>(promise: Promise<T>, ms: number): Promise<T | Error> {
  return Promise.race([
    promise.catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    ),
    new Promise<Error>((resolve) => {
      const timer = setTimeout(
        () => resolve(new Error("Intelligence did not answer.")),
        ms,
      );
      timer.unref?.();
    }),
  ]);
}

/**
 * The facts read from this server's configuration and stores.
 *
 * Built once at boot and asked on every request, so a credential added a moment ago shows up on the
 * next read. The verdicts that need another service, Intelligence's entitlement, the model
 * provider's answer and the computers', are kept from the last time they were asked, and asked
 * again on `recheck` or by a read that finds one failed or old.
 *
 * A read is answered from the last round of answers that is all in, never from one still being
 * asked, so it waits only at boot, before there is any answer to give. A fleet slow to answer a
 * recheck holds up the Check again that asked, and no read.
 */
export function createSetupSources(input: {
  productName: string;
  config: Pick<DeploymentConfig, "singleUser">;
  environment: Record<string, string | undefined>;
  model: {
    provider: "openai" | "anthropic";
    keyId: string;
    defaultModel: string;
    plan: boolean;
    /** One read of the provider's model endpoint with the key in use now. Never rejects. */
    check?: () => Promise<ModelCheckOutcome>;
  };
  credentials: CredentialStatusReader;
  /** The answer the boot check got, with the stamp of the key it asked about. */
  modelCheckAtBoot?: Promise<
    { outcome: ModelCheckOutcome; stamp: string | null } | undefined
  >;
  /** Intelligence's entitlement answer for this deployment. Asked at creation and on recheck. */
  entitlements: () => Promise<RuntimeEntitlementResponse>;
  computer: boolean;
  /** Authenticated reachability and policy delivery, with per-operation deadlines and no wake. */
  computerCheck?: () => Promise<SetupStatus>;
  apps: { configured: boolean; provider: BrokerProvider };
  chat: boolean;
}): SetupSources {
  const keyFacts = {
    plan: input.model.plan,
    provider: input.model.provider,
    keyId: input.model.keyId,
    credentials: input.credentials,
    environment: input.environment,
  };
  const askIntelligence = () =>
    withinTime(input.entitlements(), INTELLIGENCE_TIMEOUT_MS).then(
      intelligenceFact,
    );

  const askComputer = async (): Promise<SetupStatus> => {
    if (!input.computer) return "needs_setup";
    if (!input.computerCheck) return "not_checked";
    try {
      // The fleet check owns its operation deadlines; one push's budget cannot cover the fleet.
      return await input.computerCheck();
    } catch {
      return "needs_setup";
    }
  };
  /** One round of asking, and when it started. */
  type Round = {
    at: number;
    intelligence: Promise<IntelligenceFact>;
    modelCheck: Promise<
      { outcome: ModelCheckOutcome; stamp: string | null } | undefined
    >;
    computerStatus: Promise<SetupStatus>;
  };
  // The round a read is answered from: boot's, until a later one is all in.
  let kept: Round = {
    at: Date.now(),
    intelligence: askIntelligence(),
    modelCheck: (input.modelCheckAtBoot ?? Promise.resolve(undefined)).catch(
      () => undefined,
    ),
    computerStatus: askComputer(),
  };
  let lastRecheck: { at: number; done: Promise<void> } | null = null;

  const recheck = () => {
    const now = Date.now();
    if (lastRecheck && now - lastRecheck.at < RECHECK_INTERVAL_MS)
      return lastRecheck.done;
    const check = input.model.check;
    const round: Round = {
      at: now,
      intelligence: askIntelligence(),
      computerStatus: askComputer(),
      modelCheck: check
        ? (async () => {
            const { stamp } = await modelKeyOf(keyFacts);
            return stamp === null
              ? undefined
              : { outcome: await check(), stamp };
          })().catch(() => undefined)
        : kept.modelCheck,
    };
    const done = Promise.all([
      round.intelligence,
      round.modelCheck,
      round.computerStatus,
    ]).then(() => {
      kept = round;
    });
    lastRecheck = { at: now, done };
    return done;
  };

  return {
    productName: input.productName,
    localEvaluation: input.config.singleUser,
    facts: async () => {
      const round = kept;
      const [key, check, intelligence, computerStatus] = await Promise.all([
        modelKeyOf(keyFacts),
        round.modelCheck,
        round.intelligence,
        round.computerStatus,
      ]);
      const facts: SetupFacts = {
        intelligence,
        model: {
          provider: input.model.provider,
          source: key.source,
          verdict: modelVerdict(check, key.stamp),
          model: input.model.defaultModel,
        },
        computer: input.computer,
        computerStatus,
        apps: input.apps,
        chat: input.chat,
      };
      if (Date.now() - round.at >= ANSWER_KEPT_MS || failed(facts)) {
        // For the next read, so this one never waits on it. A round that throws keeps the answers
        // it would have replaced, and Check again reports it.
        recheck().catch(() => {});
      }
      return facts;
    },
    recheck,
  };
}

/**
 * Whether an answer from another service failed in a way asking again could change: Intelligence
 * did not confirm, the provider refused the key in use or has not answered about it, or a set-up
 * computer did not take its policy. A key set to a custom endpoint, no key, and no computer running
 * are not failures, and wait for the answer to grow old.
 */
function failed(facts: SetupFacts): boolean {
  const { model } = facts;
  const keyInHand =
    model.source === "credential" || model.source === "environment";
  return (
    facts.intelligence.state !== "ready" ||
    (keyInHand &&
      model.verdict !== "available" &&
      model.verdict !== "cannot_check") ||
    (facts.computer && facts.computerStatus === "needs_setup")
  );
}

/**
 * `GET /` answers the checklist for whoever is signed in. `POST /check` asks Intelligence, the
 * model provider and the computers again first, then answers the same way.
 */
export function createSetupRoutes(
  sources: SetupSources,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "setup-checklist-route-error",
        error: error.name,
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "Couldn't check your setup. Try again." },
      503,
    );
  });
  const answer = async (context: {
    var: AppVariables;
    json: (body: { checklist: SetupChecklist }) => Response;
  }) => {
    const audience =
      context.var.actor.role === "admin" || sources.localEvaluation
        ? "admin"
        : "member";
    const facts = await sources.facts();
    return context.json({
      checklist: {
        audience,
        rows: setupRows(facts, { productName: sources.productName, audience }),
      },
    });
  };
  routes.get("/", (context) => answer(context));
  routes.post("/check", async (context) => {
    await sources.recheck();
    return answer(context);
  });
  return routes;
}
