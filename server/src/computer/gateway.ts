/**
 * The only way an action reaches a Bot's computer.
 *
 * Reading a page is one thing; clicking a button on an external website is
 * another, and the difference is the whole product. The record is not a report written alongside the
 * work, it is the thing the action goes through, so it cannot be missing: an action that was not
 * recorded did not happen, because there is no path that acts without writing the row first.
 *
 * Three jobs, in this order:
 *
 *  1. Resolve the ref the caller sent into the element it actually points at, from the snapshot this
 *     server fetched. Never from what the caller said it was clicking.
 *  2. Ask the policy. Deny beats allow, an absent policy denies, and a broken rule denies.
 *  3. Write the row, whichever way the decision went, and only then act.
 *
 * Step 1 is the one that is easy to skip and fatal to skip. A gateway that decides on a label supplied
 * by the model is theatre: "never click Submit" is evaded by sending `{ref: "e13", name: "Continue"}`.
 * The refs are opaque to the caller precisely so that the server holds the mapping.
 */
import { createHash, randomBytes } from "node:crypto";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  ComputerUnavailableError,
  createComputerTransport,
  StaleSnapshotError,
} from "./client";
import { checkComputerAddress } from "./target";

export {
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "./client";

import type { PageFrameStore } from "./page-frames";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
} from "./policy";
import type { ComputerProvider } from "./provider";
import type {
  ActionResult,
  ClickInput,
  ComputerStatus,
  ControlLeaseState,
  ControlState,
  HumanInput,
  HumanInputResult,
  KeyInput,
  ListFilesInput,
  ListFilesResult,
  NavigateResult,
  ReadFileInput,
  ReadFileResult,
  ReadResult,
  RunCommandInput,
  RunCommandResult,
  ScreenshotResult,
  ScrollInput,
  SecretRequest,
  SecretResult,
  SnapshotElement,
  SnapshotResult,
  TypeInput,
  WriteFileInput,
  WriteFileResult,
} from "./schema";
import {
  createInMemorySnapshotStore,
  type SnapshotStore,
  type StoredSnapshot,
} from "./snapshot-store";

export class ActionRefusedError extends Error {
  /** The rule that refused it, so the surface can show which one and an operator can find it. */
  readonly rule: string | null;

  constructor(reason: string, rule: string | null) {
    super(reason);
    this.name = "ActionRefusedError";
    this.rule = rule;
  }
}

/** Who is asking. The gateway records this; it does not decide it. */
export type ActionActor = {
  /** The signed-in person, or the local actor when authentication is not configured. */
  id: string;
  /** Null unless this is a real row in `users`, because the audit table has a foreign key to it. */
  userId?: string;
};

const ACTOR_FINGERPRINT_LENGTH = 43;

/**
 * Bind an opaque lease to the signed-in actor without keeping replica-local server state.
 *
 * The random suffix is the capability checked by the computer. The actor digest is checked by every
 * OpenBot HTTP and WebSocket entry point. It need not be a signature: changing the digest changes
 * the exact lease and the computer rejects it, while replaying the original from another account is
 * rejected here.
 */
export function mintControlLease(actorId: string): string {
  const actor = createHash("sha256").update(actorId).digest("base64url");
  return `${actor}${randomBytes(32).toString("base64url")}`;
}

export function controlLeaseBelongsTo(lease: string, actorId: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(lease)) return false;
  const expected = createHash("sha256").update(actorId).digest("base64url");
  return lease.slice(0, ACTOR_FINGERPRINT_LENGTH) === expected;
}

export type ComputerGatewayOptions = {
  provider: ComputerProvider;
  auditStore: AuditStore;
  /** Absent denies everything. See evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
  /** True on a laptop, where browsing private network addresses is required. */
  allowPrivateHosts?: boolean;
  /** The secret that agent-computer requires on each request. */
  token?: string;
  /** An injectable fetch implementation for focused gateway tests. */
  fetchImpl?: typeof fetch;
  /**
   * Where the snapshot a ref is resolved against is kept.
   *
   * A deployment passes the database-backed store, because the process that takes a snapshot is
   * rarely the one that resolves a ref from it. Absent, the gateway keeps snapshots in memory, which
   * is correct in one process and is what a unit test wants. See snapshot-store.ts.
   */
  snapshots?: SnapshotStore;
  /**
   * Where the frame a page was opened on is kept, so a reset can take them with the profile.
   *
   * Absent, a reset clears the profile and leaves the pictures, which is the wrong half of a promise
   * this deployment makes in as many words.
   */
  pageFrames?: PageFrameStore;
};

export interface ComputerGateway {
  readonly provider: ComputerProvider;
  locate(botId: string): Promise<string>;
  status(botId: string): Promise<ComputerStatus>;
  screenshot(botId: string): Promise<ScreenshotResult>;
  snapshot(botId: string): Promise<SnapshotResult>;
  read(botId: string): Promise<ReadResult>;
  navigate(
    botId: string,
    actor: ActionActor,
    url: string,
  ): Promise<NavigateResult>;
  click(
    botId: string,
    actor: ActionActor,
    input: ClickInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  type(
    botId: string,
    actor: ActionActor,
    input: TypeInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  key(
    botId: string,
    actor: ActionActor,
    input: KeyInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  scroll(
    botId: string,
    actor: ActionActor,
    input: ScrollInput,
  ): Promise<ActionResult>;
  readFile(
    botId: string,
    actor: ActionActor,
    input: ReadFileInput,
  ): Promise<ReadFileResult>;
  listFiles(
    botId: string,
    actor: ActionActor,
    input: ListFilesInput,
  ): Promise<ListFilesResult>;
  runCommand(
    botId: string,
    actor: ActionActor,
    input: RunCommandInput,
    signal?: AbortSignal,
  ): Promise<RunCommandResult>;
  writeFile(
    botId: string,
    actor: ActionActor,
    input: WriteFileInput,
  ): Promise<WriteFileResult>;
  control(botId: string): Promise<ControlState>;
  requestHelp(
    botId: string,
    actor: ActionActor,
    reason: string,
  ): Promise<ControlState>;
  takeControl(botId: string, actor: ActionActor): Promise<ControlLeaseState>;
  renewControl(
    botId: string,
    actor: ActionActor,
    lease: string,
  ): Promise<ControlState>;
  releaseControl(
    botId: string,
    actor: ActionActor,
    lease: string,
  ): Promise<ControlState>;
  requestSecret(
    botId: string,
    actor: ActionActor,
    input: SecretRequest,
  ): Promise<ControlState>;
  supplySecret(
    botId: string,
    actor: ActionActor,
    text: string,
  ): Promise<SecretResult>;
  humanInput(
    botId: string,
    actor: ActionActor,
    input: HumanInput,
    lease: string,
  ): Promise<HumanInputResult>;
  computers(): Promise<{
    isolation: "per-bot" | "shared";
    computers: {
      botId: string;
      running: boolean;
      startedAt: string | null;
      egress?: string | null;
    }[];
  }>;
  stopComputer(
    botId: string,
    actor: ActionActor,
  ): Promise<{ wasRunning: boolean }>;
  resetComputer(
    botId: string,
    actor: ActionActor,
  ): Promise<{ cleared: boolean }>;
}

export function createComputerGateway(
  options: ComputerGatewayOptions,
): ComputerGateway {
  const { provider, auditStore } = options;
  const transport = createComputerTransport({
    ...(options.token ? { token: options.token } : {}),
    ...(options.allowPrivateHosts !== undefined
      ? { allowPrivateHosts: options.allowPrivateHosts }
      : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  /**
   * Where the snapshot a ref is resolved against lives.
   *
   * Not a `Map` in this process. It describes the live contents of a browser window, and the process
   * that took it is rarely the one that resolves a ref from it: OpenBot is several servers behind a
   * load balancer, and consecutive calls on one conversation land on different ones. Kept in memory,
   * the mapping is absent on every replica but the one that snapshotted, so the ref resolves to
   * nothing, the policy decides with no element in front of it, and the audit row cannot name what
   * was touched. The store puts it in Postgres, and the generation carried on every action keeps a
   * ref from a superseded page from resolving to whatever now holds it. See snapshot-store.ts.
   */
  const snapshots = options.snapshots ?? createInMemorySnapshotStore();
  const pageFrames = options.pageFrames;

  // A closed tab stops renewing after at most this long. Long enough for a transient network pause,
  // short enough that an abandoned takeover does not strand the Bot behind an invisible driver.
  const CONTROL_LEASE_TTL_MS = 2 * 60 * 1000;
  const leaseExpiry = () =>
    new Date(Date.now() + CONTROL_LEASE_TTL_MS).toISOString();
  const newControlLease = (actorId: string) => ({
    lease: mintControlLease(actorId),
    expiresAt: leaseExpiry(),
  });

  /**
   * Where this Bot's computer is, checked before anything is sent to it.
   *
   * The provider decides the address, and a provider is a plug: it can be this deployment's own
   * supervisor on loopback or a backend somewhere else answering over its own API. Either way the
   * address goes straight into `fetch` carrying this deployment's computer token, so it is worth
   * confirming it is an address we speak to rather than whatever came back.
   *
   * Not the navigation check. That one refuses private hosts, which is the right answer for where a
   * Bot may browse and the wrong one here, where loopback is the normal case.
   */
  async function locate(botId: string): Promise<string> {
    const address = await provider.locate(botId);
    const verdict = checkComputerAddress(address);
    if (!verdict.allowed) {
      throw new ComputerUnavailableError(verdict.reason);
    }
    return verdict.url;
  }

  async function get<T>(
    botId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return transport.call<T>(
      await locate(botId),
      botId,
      path,
      undefined,
      signal,
    );
  }

  /**
   * `address` is this action's own `/ensure`, when the caller has already made it.
   *
   * Locating twice for one action is two calls to the supervisor to learn the same thing, and worse,
   * they can disagree: the run the action was decided against would not be the run it was sent to.
   * Passing the address through means the check and the send are the same trip.
   */
  async function post<T>(
    botId: string,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
    address?: string,
  ): Promise<T> {
    return transport.post<T>(
      address ?? (await locate(botId)),
      botId,
      path,
      payload,
      signal,
      timeoutMs,
    );
  }

  /**
   * This action's own `/ensure`, or nothing when it cannot be made.
   *
   * A computer that cannot be located is not a verdict this may reach on its own. The action still
   * has to be decided and recorded, and the attempt failing is what writes the failure row beside the
   * decision; throwing here would take the action off the trail entirely. So a failure answers
   * "unknown", which leaves the generation check where it was and leaves the address to the attempt.
   */
  async function locateForAction(botId: string): Promise<string | undefined> {
    try {
      return await locate(botId);
    } catch {
      return undefined;
    }
  }

  /*
   * The transport's deadline for a command, which is a backstop and not the limit.
   *
   * The shell enforces the real one: 120s by default, 600s at most, and it answers with `timedOut`
   * so the person is told the command was stopped rather than that the computer went quiet. This
   * only has to outlast it. Below the shell's maximum, the transport gave up first and the person was
   * told the computer did not respond while the command ran on to completion inside the container.
   */
  const COMMAND_BACKSTOP_MS = 615_000;

  /** Read-only, so it passes straight through. Nothing has changed and there is nothing to decide. */
  async function screenshot(botId: string): Promise<ScreenshotResult> {
    return get<ScreenshotResult>(botId, "/screenshot");
  }

  /**
   * Read-only for the page, but it writes the resolution table the boundary reads.
   *
   * Nothing on the page changes and there is nothing to decide, so the snapshot itself passes
   * straight through. What it does record is the ref-to-element mapping every later action on this
   * computer is resolved against, and it records it where another replica can read it: the click that
   * uses these refs will almost certainly arrive on a different process. The write is awaited before
   * the refs are returned, so the snapshot cannot be resolved against on one server before it exists
   * on the store.
   */
  async function snapshot(botId: string): Promise<SnapshotResult> {
    const result = await transport.call<SnapshotResult>(
      await locate(botId),
      botId,
      "/snapshot",
      { method: "POST" },
    );
    await snapshots.save(botId, {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(
        result.elements.map((element) => [element.ref, element]),
      ),
      // Read after `locate`, which is the `/ensure` that reports it.
      ...(await sessionOf(botId)),
    });
    return result;
  }

  /**
   * Which run of the computer this is, shaped to spread into a snapshot.
   *
   * Absent for a provider that cannot say, and absent if asking fails: a session that cannot be read
   * must not stop a snapshot being recorded, because a snapshot nobody stored is a ref that resolves
   * to nothing and a boundary deciding with no element in front of it.
   */
  async function sessionOf(botId: string): Promise<{ session?: string }> {
    if (!provider.sessionOf) return {};
    try {
      const session = await provider.sessionOf(botId);
      return session ? { session } : {};
    } catch {
      return {};
    }
  }

  async function read(botId: string): Promise<ReadResult> {
    return get<ReadResult>(botId, "/read");
  }

  /**
   * Resolve a ref against the snapshot the server holds, and only against the one it came from.
   *
   * Returns undefined for an unknown ref rather than throwing, because the policy still has to run:
   * an action on an element we cannot identify must still receive a policy decision, and a deny rule
   * written against a page a Bot has not snapshotted should still refuse it.
   *
   * A ref resolves only when its generation matches the stored snapshot's. A ref carrying a
   * superseded generation resolves to nothing rather than to whatever now holds that ref: the policy
   * must never decide on an element the caller has already scrolled off the page. The computer makes
   * the same generation check when the action reaches it; this one keeps the decision and the audit
   * row honest before it gets there, on whichever replica the action landed.
   */
  function resolve(
    stored: StoredSnapshot | undefined,
    ref: string | undefined,
    snapshotId: number | undefined,
    /**
     * The run of the computer the action is reaching, when the provider can say.
     *
     * Undefined means unknown, not mismatched: a provider with no sessions to report, or one that
     * could not be asked, leaves the generation check exactly as it was.
     */
    session?: string,
  ): SnapshotElement | undefined {
    if (!ref || !stored || stored.snapshotId !== snapshotId) return undefined;
    /*
     * A generation is only unique within one run of the computer.
     *
     * A replaced container counts from one again, so a ref the model is still holding from the run
     * before matches a row nothing has overwritten, and the element handed to the policy belongs to
     * a page that no longer exists. `resetComputer` clears the row for that reason and is the only
     * thing that does; the supervisor replacing a computer whose image changed does not, and the
     * server is never told. Comparing the run closes both.
     */
    if (session && stored.session && stored.session !== session) {
      return undefined;
    }
    return stored.elements.get(ref);
  }

  /**
   * Decide, record, then act.
   *
   * The audit row is written before the action runs, not after it succeeds. An allowed action that
   * later fails is still part of the audit sequence, and a trail that only contains successes cannot
   * show that sequence.
   */
  async function govern<T>(
    toolName: string,
    botId: string,
    actor: ActionActor,
    subject: {
      ref?: string;
      /** The generation the ref came from. A ref only resolves against its own snapshot. */
      snapshotId?: number;
      filePath?: string;
      targetUrl?: string;
      key?: string;
      /** The command a shell call is about to run, so a rule can be written against it. */
      command?: string;
      /** The person's Stop, on its way to the browser. See the acting methods below. */
      signal?: AbortSignal;
    },
    run: (address?: string) => Promise<T>,
  ): Promise<T> {
    const { ref, filePath, snapshotId } = subject;
    // Loaded from the store, not this process's memory: the snapshot these refs belong to was very
    // likely taken by another replica, and resolving against a local map would find nothing there.
    const stored = await snapshots.load(botId);
    /*
     * LOCATE FIRST, THEN ASK WHICH RUN THAT WAS. The order is the check.
     *
     * `sessionOf` answers with what the last `/ensure` reported, and until this action has made its
     * own, the last one belongs to the action before it. Asking first compared the stored snapshot
     * against the previous action's run, which is the same run on every action but the first one
     * after a replacement — exactly the action the check exists to catch. The click after a replaced
     * container was allowed and the one after that refused, which is a guarantee arriving one action
     * too late.
     *
     * Only for an action that cites a ref. Nothing else is resolved against a snapshot, so nothing
     * else needs the run, and a scroll or a file read should not have to reach the supervisor before
     * the policy has even seen it. The address that comes back is the one the attempt then uses, so
     * this costs no extra call for the actions that do need it.
     */
    const address = ref ? await locateForAction(botId) : undefined;
    const { session } = ref ? await sessionOf(botId) : { session: undefined };
    const element = resolve(stored, ref, snapshotId, session);
    // For a navigation the relevant page is the one being opened, not the one already loaded. Using
    // the stored URL would mean `page.host == "..."` could never match the destination, which is the
    // only thing a rule about navigation would ever want to say.
    const pageUrl = subject.targetUrl ?? stored?.url ?? "";

    const intent = intentOf(toolName, subject.key);

    /*
     * Every field is bound, present or not.
     *
     * A missing one is not an absent field to CEL, it is an unknown identifier, and cel-js throws on
     * those. A thrown deny rule counts as a match, on purpose, so that a mistyped deny refuses rather
     * than quietly permitting. Together those two correct behaviours produced a wrong one: a rule
     * naming a field this action does not have refused the action.
     *
     * `deny: contains(command, "rm -rf")` is the example the docs give, and while `command` was
     * spread in only for a shell call, that rule threw on every click, keypress, navigation and file
     * read in the deployment and refused all of them. So did any rule naming `key`, `file` or
     * `element` from an action that has none.
     *
     * Neutral rather than absent: `contains("", "rm -rf")` is false, which is the honest answer to
     * "is this click running rm -rf". The audit row below still omits what did not happen, because a
     * trail should not claim a click had a command.
     */
    const context: PolicyContext = {
      tool: { name: toolName },
      bot: { id: botId },
      actor: { id: actor.id },
      page: { url: pageUrl, host: hostOf(pageUrl) },
      ...(intent ? { intent } : {}),
      key: subject.key ?? "",
      element: element
        ? {
            ref: element.ref,
            role: element.role,
            name: element.name,
            type: element.type ?? "",
          }
        : { ref: "", role: "", name: "", type: "" },
      file: filePath
        ? describeFile(filePath)
        : { path: "", name: "", extension: "" },
      command: subject.command ?? "",
      // Neutral, like the fields above: this is not an MCP call, but a `deny: mcp.effect == "write"`
      // names `mcp`, and cel-js throws on an unbound identifier — which fails closed and would refuse
      // every browser action the moment an operator wrote a rule about their tools. Empty server and
      // tool and an empty effect match no MCP rule, so a boundary drawn around MCP leaves the browser
      // alone. The MCP context carries the browser fields empty for the mirror of this reason.
      mcp: { server: "", tool: "", effect: "" },
    };

    const decision = evaluateActionPolicy(options.policy(), context);
    await write(auditStore, {
      toolName,
      botId,
      actor,
      element,
      ref,
      ...(subject.key ? { key: subject.key } : {}),
      ...(subject.command ? { command: subject.command } : {}),
      filePath,
      pageUrl,
      decision,
    });
    if (!decision.forward) {
      throw new ActionRefusedError(decision.reason, decision.matched);
    }

    let result: T;
    try {
      /*
       * A citation that was made and could not be honoured is refused, not carried out.
       *
       * `resolve` answering undefined leaves the element half of the context all-empty, and empty is
       * the honest neutral value for an action that names no element: it is what stops a rule about
       * one action surface throwing on another. It is the wrong answer for an action that named a ref
       * and did not get one. Every element-keyed rule then evaluates against empty strings, so a deny
       * that exists to stop this exact click does not match, the shipped default permits, and the
       * click lands on whatever that ref is now. The rule did not decline to match. It was never
       * shown the element.
       *
       * The computer's own staleness check does not make this safe. It compares the citation against
       * its own counter, so it catches the cases where the two disagree; the case that matters is the
       * one where the computer is content and only this server is out of step, which is what a
       * computer restarting its generation counter under a stored row leaves behind.
       *
       * Only a cited ref, and only against a snapshot this server actually holds. Scroll, a
       * page-level keypress, a shell call and a file read name no element, so they have nothing to
       * have failed to resolve. A computer this server has no snapshot for at all is a different
       * situation: there is no page here to judge the citation against, the computer is the only
       * party that can, and refusing locally would take its answer away, including the one that says
       * a person has taken the wheel. What is refused here is a citation this server can see is stale.
       *
       * Thrown from inside the attempt, after the decision row, on purpose: an action whose ref
       * resolves to nothing is still an action somebody tried to take, and refusing it before the row
       * was written would be a way to act without appearing on the trail. The failure row beside it is
       * what stops the trail claiming a permitted action was carried out when nothing was sent.
       */
      if (ref && stored && !element) {
        throw new StaleSnapshotError(
          `${ref} is not on the page this computer is showing, so nothing can be checked against it before acting. Take a fresh snapshot and use the refs it returns.`,
        );
      }
      result = await run(address);
    } catch (error) {
      /**
       * A permitted action that did not happen gets its own row.
       *
       * Without this the trail lies by omission. The row above says the policy allowed the call, and
       * a reader takes "allowed" to mean "it happened".
       *
       * Writing the decision before acting is still right, because an allowed action may have partial
       * effects before failing. The failure row records the outcome separately from the policy
       * decision.
       *
       * It carries the same subject the decision row did, and for the same reasons: a shell call
       * that failed part-way is the row somebody most needs to name the command from, and a keypress
       * that failed is still the difference between a submitted form and a typed letter. Leaving
       * them off also chose the wrong element branch below, because "this action never had an
       * element" is decided by the command and the file path — so a failed command claimed a
       * snapshot lookup that never happened.
       */
      await write(auditStore, {
        toolName,
        botId,
        actor,
        element,
        ref,
        ...(subject.key ? { key: subject.key } : {}),
        ...(subject.command ? { command: subject.command } : {}),
        filePath,
        pageUrl,
        decision,
        failure: error instanceof Error ? error.message : "The action failed.",
      });
      throw error;
    }
    // The element's label, attached on the way out, so the transcript can say what was acted on
    // instead of quoting a ref. The computer cannot supply this: it knows the ref, and the resolved
    // snapshot lives here. File calls carry their own path already, so there is nothing to add.
    return element && result && typeof result === "object"
      ? { ...result, element: { role: element.role, name: element.name } }
      : result;
  }

  return {
    provider,
    locate,
    screenshot,
    snapshot,
    read,

    status(botId: string): Promise<ComputerStatus> {
      return provider.status(botId);
    },

    /**
     * Handovers, recorded but not policy-gated.
     *
     * The policy constrains what a Bot may do. A person taking the wheel is the escape hatch that
     * makes a governed Bot usable at all, and a rule able to lock somebody out of their own browser
     * halfway through a login would be a worse failure than anything it prevented. So these write the
     * row and do not ask. What IS recorded is the period: who, when, and why the Bot asked, the fact
     * an investigator wants is that a human drove this browser between two times.
     */
    async requestHelp(botId: string, actor: ActionActor, reason: string) {
      const state = await post<ControlState>(botId, "/control/request", {
        reason,
      });
      await writeControlEvent(auditStore, "computer.help_requested", {
        botId,
        actor,
        reason,
      });
      return state;
    },

    async takeControl(botId: string, actor: ActionActor) {
      const capability = newControlLease(actor.id);
      const state = await post<ControlState>(
        botId,
        "/control/take",
        capability,
      );
      await writeControlEvent(auditStore, "computer.control_taken", {
        botId,
        actor,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      return { ...state, lease: capability.lease };
    },

    renewControl(botId: string, actor: ActionActor, lease: string) {
      if (!controlLeaseBelongsTo(lease, actor.id)) {
        throw new Error("This control lease belongs to another session.");
      }
      return post<ControlState>(botId, "/control/renew", {
        lease,
        expiresAt: leaseExpiry(),
      });
    },

    async releaseControl(botId: string, actor: ActionActor, lease: string) {
      if (!controlLeaseBelongsTo(lease, actor.id)) {
        throw new Error("This control lease belongs to another session.");
      }
      const state = await post<ControlState>(botId, "/control/release", {
        lease,
      });
      await writeControlEvent(auditStore, "computer.control_released", {
        botId,
        actor,
      });
      return state;
    },

    control(botId: string): Promise<ControlState> {
      return get<ControlState>(botId, "/control");
    },

    /** Return every computer that the configured provider owns. */
    async computers() {
      const computers = await provider.list();
      return {
        isolation: provider.isolation,
        computers: computers.map((computer) => ({
          botId: computer.botId,
          running: computer.status === "running",
          startedAt: computer.startedAt ?? null,
          egress: computer.egress,
        })),
      };
    },

    /**
     * Stop a computer's browser, keeping what it knows.
     *
     * Audited, unlike the read above, because a person reached in and stopped something. Recorded
     * whether or not a browser was actually running: "she pressed stop and nothing was running" is a
     * fact worth having, and a trail that only records effective actions cannot tell you what somebody
     * tried.
     */
    async stopComputer(botId: string, actor: ActionActor) {
      const result = await provider.stop(botId);
      await writeControlEvent(auditStore, "computer.stopped", {
        botId,
        actor,
        reason: result.wasRunning
          ? "the computer was stopped"
          : "the computer was already stopped",
      });
      return result;
    },

    /**
     * Wipe a computer's profile.
     *
     * The most destructive button we have. Every login the Bot had is gone and no undo exists, so the
     * row is written whatever happens next.
     */
    async resetComputer(botId: string, actor: ActionActor) {
      const result = await provider.reset(botId);
      // The refs the last snapshot handed out describe a page that no longer exists, and a fresh
      // computer counts generations from one again, so the row has to go with the profile.
      await snapshots.clear(botId);
      /*
       * And the pictures, which are the part that made the promise above untrue.
       *
       * "Every login the Bot had is gone" was said while screenshots of the signed-in pages stayed
       * in the database: an inbox, an admin console, a bank statement, still readable from the
       * transcript by anybody who could reach that Bot. A reset that leaves those has not reset
       * anything a person would recognise as private.
       */
      await pageFrames?.clear(botId);
      await writeControlEvent(auditStore, "computer.reset", {
        botId,
        actor,
        reason: result.cleared
          ? "the computer and its saved state were deleted"
          : "no saved state was present to delete",
      });
      return result;
    },

    /**
     * Asking for a secret, and supplying one.
     *
     * Both are audited, and neither records the value. The row says a secret was asked for, what it
     * was called, and which field it went in, the things an investigator needs in order to know a
     * human credential entered this session. The value itself is on one path only, from a person's
     * keyboard to the page, and is not on this one.
     */
    async requestSecret(
      botId: string,
      actor: ActionActor,
      input: SecretRequest,
    ) {
      const state = await post<ControlState>(botId, "/control/secret", input);
      await writeControlEvent(auditStore, "computer.secret_requested", {
        botId,
        actor,
        reason: `${input.label} (into ${input.ref})`,
      });
      return state;
    },

    async supplySecret(botId: string, actor: ActionActor, text: string) {
      const result = await post<SecretResult>(botId, "/human/secret", { text });
      await writeControlEvent(auditStore, "computer.secret_supplied", {
        botId,
        actor,
        // Length, never content. Enough to show something real was entered.
        reason: `${result.characters} characters`,
      });
      return result;
    },

    async humanInput(
      botId: string,
      actor: ActionActor,
      input: HumanInput,
      lease: string,
    ): Promise<HumanInputResult> {
      if (!controlLeaseBelongsTo(lease, actor.id)) {
        throw new Error("This control lease belongs to another session.");
      }
      const { kind, ...payload } = input;
      /*
       * Checked here as well as at the route, because this is where it becomes a path.
       *
       * `kind` is typed as one of four gestures and a type is not a check: the route casts a parsed
       * body to this shape, so whatever arrived is whatever the caller sent. Interpolated into the
       * path below, a value like `../exec` reaches a different endpoint of the computer's API
       * altogether, carrying this deployment's computer token. This method is also the one acting
       * path that writes no audit row, deliberately, so a call that went somewhere else leaves
       * nothing behind that would say so.
       */
      if (!HUMAN_GESTURES.has(kind)) {
        throw new Error(
          `A person's input is one of ${[...HUMAN_GESTURES].join(", ")}, not ${JSON.stringify(kind)}.`,
        );
      }
      return post<HumanInputResult>(botId, `/human/${kind}`, {
        ...payload,
        lease,
      });
    },

    /**
     * Opening a page, through the gateway so it lands in the audit trail.
     *
     * The transport applies its target guard before it sends a request. This is
     * the minimum rule that applies even when the action policy permits the URL.
     */
    navigate(botId: string, actor: ActionActor, url: string) {
      return govern(
        "computer_navigate",
        botId,
        actor,
        { targetUrl: url },
        async () => transport.navigate(await locate(botId), botId, url),
      );
    },

    click(
      botId: string,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_click",
        botId,
        actor,
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          ...(signal ? { signal } : {}),
        },
        (address) =>
          post<ActionResult>(
            botId,
            "/click",
            input,
            signal,
            undefined,
            address,
          ),
      );
    },

    type(
      botId: string,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_type",
        botId,
        actor,
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          /*
           * `submit` presses Enter once the text is in, so this call is a keypress as well as a
           * typing one and the policy has to see both halves. Without the key here, an agent refused
           * on clicking the button and refused on pressing Enter types into the field with
           * `submit: true` instead, and the form goes through against a rule written to stop exactly
           * that. It is what the trail is missing too: a row with no key says a field was filled in,
           * not that the form was sent.
           */
          ...(input.submit ? { key: "Enter" } : {}),
          ...(signal ? { signal } : {}),
        },
        (address) =>
          post<ActionResult>(botId, "/type", input, signal, undefined, address),
      );
    },

    key(
      botId: string,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_key",
        botId,
        actor,
        // The key is part of the subject, so a rule can tell Enter from a letter. Form submission can
        // happen through a keypress as well as a click, so the policy context carries the key.
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          key: input.key,
          ...(signal ? { signal } : {}),
        },
        (address) =>
          post<ActionResult>(botId, "/key", input, signal, undefined, address),
      );
    },

    scroll(botId: string, actor: ActionActor, input: ScrollInput) {
      return govern("computer_scroll", botId, actor, {}, () =>
        post<ActionResult>(botId, "/scroll", input),
      );
    },

    /**
     * The file tools, governed like everything else.
     *
     * The read is governed too, unlike reading a page. A page was permitted when it was opened; the
     * workspace accumulates whatever a Bot has saved across every task it has ever run, so which of
     * those files it may read back is a real question for a deployment to be able to answer.
     */
    readFile(botId: string, actor: ActionActor, input: ReadFileInput) {
      return govern(
        "computer_read_file",
        botId,
        actor,
        { filePath: input.path },
        () => post<ReadFileResult>(botId, "/files/read", input),
      );
    },

    /**
     * Listing is governed too, and for the same reason the read is: what a Bot has accumulated over
     * every task it has run is worth being able to restrict. A rule denying a folder hides it from the
     * listing as well as from reads, which is the consistent answer.
     */
    listFiles(botId: string, actor: ActionActor, input: ListFilesInput) {
      return govern(
        "computer_list_files",
        botId,
        actor,
        { filePath: input.path ?? "." },
        () => post<ListFilesResult>(botId, "/files/list", input),
      );
    },

    /**
     * A command, judged before it runs.
     *
     * The same four steps as a click: resolve, decide, record, act. The policy sees the command
     * text, so a deployment can refuse a shell outright with `intent == "run_command"` or refuse
     * particular commands, and either way the attempt is a row in the trail whether or not it ran.
     */
    runCommand(
      botId: string,
      actor: ActionActor,
      input: RunCommandInput,
      caller?: AbortSignal,
    ) {
      return govern(
        "computer_run_command",
        botId,
        actor,
        { command: input.command, ...(caller ? { signal: caller } : {}) },
        () =>
          post<RunCommandResult>(
            botId,
            "/exec",
            input,
            caller,
            COMMAND_BACKSTOP_MS,
          ),
      );
    },

    writeFile(botId: string, actor: ActionActor, input: WriteFileInput) {
      return govern(
        "computer_write_file",
        botId,
        actor,
        { filePath: input.path },
        () => post<WriteFileResult>(botId, "/files/write", input),
      );
    },
  };
}

/**
 * Split a path into the parts a rule wants to match on.
 *
 * Lower-cased, because a rule forbidding `.env` must also catch `.ENV`; the
 * operator should have anticipated. Same reasoning as the case-insensitive `contains` in policy.ts.
 */
export function describeFile(path: string): {
  path: string;
  name: string;
  extension: string;
} {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    // A leading dot is the whole name of a dotfile, not an extension: `.env` has no extension, and the
    // rule for it is written against `name`.
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}

/**
 * One audit row for one decision.
 *
 * Deliberately absent: the text that was typed. The row says which field was filled and
 * how many characters went into it, and never the value, because a form field is where a password, a
 * card number and a one-time code live. `audit.ts` would redact a key literally called `text`, but
 * relying on that would mean the secret was placed in the payload and caught on the way past; it is
 * simpler and stronger for it never to be put there. `element.name` is a label a page displays, not
 * something a person typed, so it is safe and it is the part an investigator actually needs.
 */
/**
 * What an action does, from what the gateway already knows.
 *
 * Derived here rather than passed in by each call site, so a new acting route cannot arrive
 * without an intent and fall outside every rule written in terms of one.
 *
 * Enter and Space are activations. They press whatever has focus, so a rule about activation must
 * cover keypresses as well as clicks.
 */
const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);

/**
 * What a person's mouse and keyboard produce, and the whole of what `/human/<kind>` may name.
 *
 * A set rather than the union type alone, because the type is erased before the value gets here: the
 * route parses a JSON body and casts it to the input shape, so the check has to exist at runtime on
 * the side that builds the path.
 */
const HUMAN_GESTURES = new Set(["click", "type", "key", "scroll"]);

export function intentOf(
  toolName: string,
  key: string | undefined,
): PolicyContext["intent"] {
  switch (toolName) {
    case "computer_click":
      return "activate";
    case "computer_key":
    // A type carrying `submit` ends in Enter, and the same reasoning applies to it: what the
    // keypress does is press whatever the form activates, whichever tool asked for it.
    case "computer_type":
      return key && ACTIVATING_KEYS.has(key) ? "activate" : "type";
    case "computer_navigate":
      return "navigate";
    case "computer_read":
    case "computer_snapshot":
    case "computer_screenshot":
    case "computer_scroll":
      return "read";
    case "computer_read_file":
      return "read_file";
    case "computer_write_file":
      return "write_file";
    case "computer_run_command":
      return "run_command";
    case "computer_list_files":
      return "list_files";
    default:
      return undefined;
  }
}

async function write(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    botId: string;
    actor: ActionActor;
    element: SnapshotElement | undefined;
    ref: string | undefined;
    /** Which key, for a keypress. Recorded because a keypress can act without naming a button. */
    key?: string | undefined;
    filePath: string | undefined;
    pageUrl: string;
    decision: PolicyDecision;
    /** The command a shell call ran, so the trail says what was run and not merely that something was. */
    command?: string;
    /** Set only when a permitted action was attempted and did not succeed. */
    failure?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    // A failure is its own kind of event, not a variant of "allowed": the whole point of the extra row
    // is that a reader can tell an action that happened from one that was permitted and then did not.
    eventType: entry.failure
      ? "computer.action_failed"
      : entry.decision.allowed
        ? "computer.action_allowed"
        : "computer.action_refused",
    targetType: "computer",
    targetId: entry.botId,
    // Only ever a real users row. The audit table has a foreign key to it, so writing the local
    // development actor's id here makes every action fail on a constraint violation instead of being
    // recorded. Who it was is in the payload either way.
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.botId,
      actor: entry.actor.id,
      page: entry.pageUrl,
      ref: entry.ref ?? null,
      /*
       * The key, where there is one. A keypress can submit a form from inside a text field, so the
       * element it was aimed at is not always the thing it acted on. Without the key, the trail
       * cannot distinguish a form-submitting Enter from typing a letter.
       */
      ...(entry.key ? { key: entry.key } : {}),
      // The path, never the contents. A Bot writes down what it was told, so a file body is exactly as
      // sensitive as text typed into a form field, and for the same reason it is not put here.
      ...(entry.filePath ? { file: entry.filePath } : {}),
      /*
       * The command, in full, and its output never.
       *
       * The opposite call from the file body above, deliberately. A command IS the action, so a
       * trail recording that a Bot "ran something" answers nothing anyone would ask it. Its output
       * is the file body of this pair, and stays out.
       */
      ...(entry.command ? { command: entry.command } : {}),
      /*
       * The element, where the action named one.
       *
       * KEYED ON THE REF, not on the kind of action. An unresolved element is worth recording
       * plainly rather than as an absent field that reads like a logging gap, but that only applies
       * when the Bot pointed at something and the server could not say what: a ref it holds and the
       * snapshot no longer does. Deciding it by elimination instead put "not in the current
       * snapshot" on every navigation, every file read and every command, which is the reverse of
       * the intent. Those actions did not fail to identify an element; they never had one, and a
       * trail that says otherwise sends a reader looking for a snapshot that was never taken.
       */
      element: entry.element
        ? {
            role: entry.element.role,
            name: entry.element.name,
            ...(entry.element.type ? { type: entry.element.type } : {}),
          }
        : entry.ref
          ? "not in the current snapshot"
          : undefined,
      ...(entry.failure ? { failure: entry.failure } : {}),
      decision: {
        allowed: entry.decision.allowed,
        mode: entry.decision.mode,
        source: entry.decision.source,
        rule: entry.decision.matched,
        /** Present so the trail explains a dry-run row that was recorded as refused but still ran. */
        carriedOut: entry.decision.forward,
      },
    },
  });
}

/**
 * The host a rule can match on, or empty.
 *
 * Empty means "no page", which is the accurate answer before a Bot has snapshotted anything, and it is
 * the only case that occurs in practice: the URL comes from Playwright's own `page.url()` by way of the
 * snapshot cache. Worth stating explicitly because a `page.host == "..."` deny rule would not match an
 * empty host, so a boundary that must not be evadable should also key on the tool, the element or the
 * file rather than on the host alone.
 */
/**
 * One row for a handover.
 *
 * Separate from `write` because a handover has no element, no file and no policy decision, forcing it
 * through the same shape would mean inventing a decision that was never asked for, and a row claiming
 * a policy allowed something it never saw is exactly the kind of comfortable fiction this trail exists
 * to avoid.
 */
async function writeControlEvent(
  auditStore: AuditStore,
  eventType:
    | "computer.help_requested"
    | "computer.control_taken"
    | "computer.control_released"
    | "computer.secret_requested"
    | "computer.secret_supplied"
    | "computer.stopped"
    | "computer.reset",
  entry: {
    botId: string;
    actor: ActionActor;
    reason?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "computer",
    targetId: entry.botId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
