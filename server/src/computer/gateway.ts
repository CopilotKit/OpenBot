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
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  fingerprintOf,
  type PendingApproval,
} from "./approvals";
import type { ComputerClient } from "./client";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
} from "./policy";
import type {
  ClickInput,
  KeyInput,
  ListFilesInput,
  ReadFileInput,
  ReadResult,
  ScrollInput,
  SecretRequest,
  SnapshotElement,
  SnapshotResult,
  TypeInput,
  WriteFileInput,
} from "./schema";

export class ActionRefusedError extends Error {
  /** The rule that refused it, so the surface can show which one and an operator can find it. */
  readonly rule: string | null;

  constructor(reason: string, rule: string | null) {
    super(reason);
    this.name = "ActionRefusedError";
    this.rule = rule;
  }
}

/**
 * The boundary wants a person's answer before this happens.
 *
 * Emphatically not an {@link ActionRefusedError}. A refusal is final and the Bot should say so and
 * move on; this one is a pause, and the same Bot presenting the same request again with an approval
 * on it is the intended next step rather than an attempt to get around anything. Collapsing the two
 * would teach a model to give up on exactly the actions a deployment was willing to permit, which is
 * the failure that makes an ask list worse than useless.
 */
export class ActionNeedsApprovalError extends Error {
  /** What the caller presents once somebody has answered. */
  readonly approvalId: string;
  /** The question in the words a person is being shown, so the Bot can say what it is waiting for. */
  readonly question: string;
  /** The rule that asked, so the surface can name the boundary the way a refusal does. */
  readonly rule: string;

  constructor(approval: PendingApproval) {
    super(approval.question);
    this.name = "ActionNeedsApprovalError";
    this.approvalId = approval.id;
    this.question = approval.question;
    this.rule = approval.rule;
  }
}

/** Who is asking. The gateway records this; it does not decide it. */
export type ActionActor = {
  /** The signed-in person, or the local actor when authentication is not configured. */
  id: string;
  /** Null unless this is a real row in `users`, because the audit table has a foreign key to it. */
  userId?: string;
};

export type ComputerGatewayOptions = {
  /**
   * The container supervisor, when each Bot has a computer of its own.
   *
   * Stop and reset prefer it: a computer that is wedged cannot be asked to stop itself, and that is
   * exactly the state where a person reaches for the button. Without a supervisor these stay profile
   * operations performed by the computer itself, which fits the single-computer deployment where
   * nothing else holds the Docker socket.
   */
  supervisor?: {
    stop(botId: string): Promise<void>;
    reset(botId: string): Promise<void>;
    list?(): Promise<{ botId: string; status: string; startedAt?: string }[]>;
  };
  client: ComputerClient;
  auditStore: AuditStore;
  /** Absent denies everything. See evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
  /**
   * Where questions raised by the `ask` list wait for an answer.
   *
   * Handed in rather than owned, because the deployment has exactly one of these and the gateway is
   * not the only thing that asks: the same policy judges a Bot's calls to somebody else's servers,
   * and a person answering should see everything their Bot is waiting on rather than whichever half
   * belongs to the subsystem that happened to serve the page. A gateway built without one keeps its
   * own, which is what the tests do so they can control the clock.
   */
  approvals?: ApprovalRegistry;
};

/**
 * The last snapshot the server took, per computer.
 *
 * In memory. It describes the live contents of a browser window, so it is
 * meaningless the moment the process holding that window restarts. Persisting it would create a cache
 * that can disagree with the page, which is worse than not having one: the refs would resolve to names
 * that are no longer on screen and the policy would decide on fiction.
 */
type CachedSnapshot = {
  snapshotId: number;
  elements: Map<string, SnapshotElement>;
  url: string;
};

export function createComputerGateway(options: ComputerGatewayOptions) {
  const { client, auditStore, supervisor } = options;
  const snapshots = new Map<string, CachedSnapshot>();
  const approvals = options.approvals ?? createApprovalRegistry();

  /**
   * The computer, addressed as the Bot that is asking.
   *
   * Every call goes through this. The Bot's browser, its logins and the proxy its traffic leaves
   * through are all keyed on this id at the far end, so a call that forgets it lands on the wrong
   * computer, because there is always a computer to answer.
   */
  const as = (botId: string) => client.forBot(botId);

  /** Read-only, so it passes straight through. Nothing has changed and there is nothing to decide. */
  async function snapshot(computerId: string): Promise<SnapshotResult> {
    const result = await as(computerId).snapshot();
    snapshots.set(computerId, {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(
        result.elements.map((element) => [element.ref, element]),
      ),
    });
    return result;
  }

  async function read(botId: string): Promise<ReadResult> {
    return as(botId).read();
  }

  /**
   * Resolve a ref against the snapshot the server holds.
   *
   * Returns undefined for an unknown ref rather than throwing, because the policy still has to run:
   * an action on an element we cannot identify must still receive a policy decision.
   * A deny rule written against a page a Bot has not snapshotted should still refuse it.
   */
  function resolve(
    computerId: string,
    ref: string | undefined,
  ): SnapshotElement | undefined {
    if (!ref) return undefined;
    return snapshots.get(computerId)?.elements.get(ref);
  }

  /**
   * Decide, record, then act.
   *
   * The audit row is written before the action runs, not after it succeeds. An allowed action that
   * later fails is still part of the audit sequence, and a trail that only contains successes cannot
   * show that sequence.
   */
  async function govern<T>(
    computerId: string,
    toolName: string,
    botId: string,
    actor: ActionActor,
    subject: {
      ref?: string;
      filePath?: string;
      targetUrl?: string;
      key?: string;
      /** Whether this call ends by pressing Enter. Only the type tool can, and it says so. */
      submit?: boolean;
      /** The person's Stop, on its way to the browser. See the acting methods below. */
      signal?: AbortSignal;
      /**
       * An answer a person already gave, being presented for the action it was given for.
       *
       * Carried on the request rather than held against the conversation, because the thing being
       * checked is not "has somebody approved something recently" but "was this exact action the one
       * they were shown". The id alone proves nothing; it is the id plus the fingerprint of the call
       * being made that means anything.
       */
      approvalId?: string;
    },
    run: () => Promise<T>,
  ): Promise<T> {
    const { ref, filePath } = subject;
    const element = resolve(computerId, ref);
    const cached = snapshots.get(computerId);
    // For a navigation the relevant page is the one being opened, not the one already loaded. Using
    // the cached URL would mean `page.host == "..."` could never match the destination, which is the
    // only thing a rule about navigation would ever want to say.
    const pageUrl = subject.targetUrl ?? cached?.url ?? "";

    const intent = intentOf(toolName, subject.key);

    const context: PolicyContext = {
      tool: { name: toolName },
      bot: { id: botId },
      actor: { id: actor.id },
      page: { url: pageUrl, host: hostOf(pageUrl) },
      // Always a boolean, unlike `key`, so a rule about form submission needs no guard to stay
      // evaluable on the actions that cannot submit anything. See PolicyContext.submit.
      submit: subject.submit === true,
      ...(intent ? { intent } : {}),
      ...(subject.key ? { key: subject.key } : {}),
      ...(element
        ? {
            element: {
              ref: element.ref,
              role: element.role,
              name: element.name,
              ...(element.type ? { type: element.type } : {}),
            },
          }
        : {}),
      ...(filePath ? { file: describeFile(filePath) } : {}),
    };

    const decision = evaluateActionPolicy(options.policy(), context);

    /**
     * A decision that wants a person, resolved before anything is recorded as having happened.
     *
     * Two outcomes and no third: either an approval already exists for this exact action, in which
     * case the row below says so and names who gave it, or the question is opened and the call stops
     * here. Nothing is written as allowed or refused in the second case, because neither happened:
     * `approval.requested` is the record of where the turn actually got to.
     *
     * Dry-run never reaches this branch, because the policy forwards an ask there for the same
     * reason it forwards a deny: a mode that promises to change nothing must not start interrupting
     * people.
     */
    let approvedBy: string | undefined;
    if (decision.source === "ask" && !decision.forward) {
      const fingerprint = fingerprintOf({
        botId,
        toolName,
        ref,
        key: subject.key,
        submit: subject.submit,
        filePath,
        pageUrl,
      });
      const presented = subject.approvalId
        ? approvals.consume(subject.approvalId, fingerprint)
        : undefined;

      if (presented?.ok && presented.approval.answeredBy) {
        approvedBy = presented.approval.answeredBy;
      } else {
        // Every unsuccessful presentation asks again rather than failing: an expired approval, an id
        // spent already, a person's No being replayed, and an approval granted for a different button
        // all mean the same thing here, which is that nobody has agreed to THIS. Asking twice is
        // annoying and safe; guessing which of those deserves an error is neither.
        //
        // An approval with nobody's name on it lands here too. Nothing can produce one, because an
        // answer always records who gave it and an unanswered approval cannot be spent, and it asks
        // again rather than falling back to the person whose turn raised the question: crediting
        // consent to whoever was driving the Bot is the one thing this record must never do.
        const pending = approvals.request({
          botId,
          actor: actor.id,
          rule: decision.matched ?? "",
          question: decision.reason,
          fingerprint,
          // Where the answer's own row will be filed, decided here where what the question is about
          // is still known. See PendingApproval.target.
          target: { type: "computer", id: computerId },
        });
        await writeApprovalEvent(auditStore, {
          botId,
          actor,
          computerId,
          approval: pending,
          toolName,
          pageUrl,
          filePath,
        });
        throw new ActionNeedsApprovalError(pending);
      }
    }

    // What the boundary settled on, once a person's answer is folded in. The source stays `ask`, so
    // the row reads as "allowed, because somebody was asked and said yes" rather than as an ordinary
    // permission nobody ever questioned.
    const settled: PolicyDecision = approvedBy
      ? {
          ...decision,
          allowed: true,
          forward: true,
          reason: `Allowed by ${approvedBy}, who was asked because of the rule \`${decision.matched}\`.`,
        }
      : decision;

    await write(auditStore, {
      toolName,
      botId,
      actor,
      computerId,
      element,
      ref,
      ...(subject.key ? { key: subject.key } : {}),
      filePath,
      pageUrl,
      decision: settled,
      ...(approvedBy ? { approvedBy } : {}),
    });

    if (!settled.forward) {
      throw new ActionRefusedError(settled.reason, settled.matched);
    }

    let result: T;
    try {
      result = await run();
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
       */
      await write(auditStore, {
        toolName,
        botId,
        actor,
        computerId,
        element,
        ref,
        filePath,
        pageUrl,
        decision: settled,
        ...(approvedBy ? { approvedBy } : {}),
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
    snapshot,
    read,

    /**
     * Handovers, recorded but not policy-gated.
     *
     * The policy constrains what a Bot may do. A person taking the wheel is the escape hatch that
     * makes a governed Bot usable at all, and a rule able to lock somebody out of their own browser
     * halfway through a login would be a worse failure than anything it prevented. So these write the
     * row and do not ask. What IS recorded is the period: who, when, and why the Bot asked, the fact
     * an investigator wants is that a human drove this browser between two times.
     */
    async requestHelp(
      computerId: string,
      botId: string,
      actor: ActionActor,
      reason: string,
    ) {
      const state = await as(botId).requestControl(reason);
      await writeControlEvent(auditStore, "computer.help_requested", {
        botId,
        actor,
        computerId,
        reason,
      });
      return state;
    },

    async takeControl(computerId: string, botId: string, actor: ActionActor) {
      const state = await as(botId).takeControl();
      await writeControlEvent(auditStore, "computer.control_taken", {
        botId,
        actor,
        computerId,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      return state;
    },

    async releaseControl(
      computerId: string,
      botId: string,
      actor: ActionActor,
    ) {
      const state = await as(botId).releaseControl();
      await writeControlEvent(auditStore, "computer.control_released", {
        botId,
        actor,
        computerId,
      });
      return state;
    },

    control(botId: string) {
      return as(botId).control();
    },

    /**
     * The computers, for the admin surface. A read, so no audit row.
     *
     * With a supervisor the list is the containers, because that is what a computer is: one per
     * Bot, each with its own storage, and the page's Stop and Reset act on those. Asking a single
     * computer for its profiles would answer for the one shared browser instead, which is the older
     * arrangement and no longer what an administrator is looking at.
     */
    async computers() {
      if (supervisor?.list) {
        const running = await supervisor.list();
        return {
          // Said, not inferred. Without a supervisor every Bot shares one browser, which looks
          // identical on every screen to each having its own, same cards, same trail, same
          // screenshots. A reader has to be told which deployment they are looking at.
          isolation: "per-bot" as const,
          computers: running.map((computer) => ({
            botId: computer.botId,
            running: computer.status === "running",
            startedAt: computer.startedAt ?? null,
            egress: null,
          })),
        };
      }
      return { isolation: "shared" as const, ...(await client.computers()) };
    },

    /**
     * Stop a computer's browser, keeping what it knows.
     *
     * Audited, unlike the read above, because a person reached in and stopped something. Recorded
     * whether or not a browser was actually running: "she pressed stop and nothing was running" is a
     * fact worth having, and a trail that only records effective actions cannot tell you what somebody
     * tried.
     */
    async stopComputer(computerId: string, botId: string, actor: ActionActor) {
      if (supervisor) {
        await supervisor.stop(botId);
        await writeControlEvent(auditStore, "computer.stopped", {
          botId,
          actor,
          computerId,
          reason: "the container was stopped",
        });
        return { wasRunning: true };
      }
      const result = await as(botId).stopComputer();
      await writeControlEvent(auditStore, "computer.stopped", {
        botId,
        actor,
        computerId,
        reason: result.wasRunning
          ? "browser was running"
          : "no browser was running",
      });
      return result;
    },

    /**
     * Wipe a computer's profile.
     *
     * The most destructive button we have. Every login the Bot had is gone and no undo exists, so the
     * row is written whatever happens next.
     */
    async resetComputer(computerId: string, botId: string, actor: ActionActor) {
      if (supervisor) {
        await supervisor.reset(botId);
        await writeControlEvent(auditStore, "computer.reset", {
          botId,
          actor,
          computerId,
          reason: "the container and its profile were deleted",
        });
        return { cleared: true };
      }
      const result = await as(botId).resetComputer();
      await writeControlEvent(auditStore, "computer.reset", {
        botId,
        actor,
        computerId,
        reason: "every saved login on this computer was deleted",
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
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: SecretRequest,
    ) {
      const state = await as(botId).requestSecret(input);
      await writeControlEvent(auditStore, "computer.secret_requested", {
        botId,
        actor,
        computerId,
        reason: `${input.label} (into ${input.ref})`,
      });
      return state;
    },

    async supplySecret(
      computerId: string,
      botId: string,
      actor: ActionActor,
      text: string,
    ) {
      const result = await as(botId).supplySecret(text);
      await writeControlEvent(auditStore, "computer.secret_supplied", {
        botId,
        actor,
        computerId,
        // Length, never content. Enough to show something real was entered.
        reason: `${result.characters} characters`,
      });
      return result;
    },

    humanInput(
      botId: string,
      input: Parameters<ComputerClient["humanInput"]>[0],
    ) {
      return as(botId).humanInput(input);
    },

    /**
     * Opening a page, through the gateway so it lands in the audit trail.
     *
     * The client still applies its target guard, which is the floor that holds under every policy,
     * including one that permits everything. This adds the record and the per-Bot decision on top: a
     * refusal by either produces a row, so navigation denials are visible in the audit trail.
     */
    navigate(
      computerId: string,
      botId: string,
      actor: ActionActor,
      url: string,
      /**
       * An answer a person gave to this exact call, if one has been given.
       *
       * Last and optional on every acting method, so a caller that knows nothing about approvals
       * behaves exactly as it did and a route that forgets to pass it fails by asking again rather
       * than by acting unasked.
       */
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_navigate",
        botId,
        actor,
        { targetUrl: url, ...(approvalId ? { approvalId } : {}) },
        () => as(botId).navigate(url),
      );
    },

    click(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_click",
        botId,
        actor,
        {
          ref: input.ref,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).click(input, signal),
      );
    },

    type(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_type",
        botId,
        actor,
        {
          ref: input.ref,
          // Whether this call ends by pressing Enter, which is the third way into a form and the one
          // a rule about clicking and a rule about `key` both miss. The computer presses it itself,
          // so it never arrives here as an action of its own to be judged.
          submit: input.submit === true,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).type(input, signal),
      );
    },

    key(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_key",
        botId,
        actor,
        // The key is part of the subject, so a rule can tell Enter from a letter. Form submission can
        // happen through a keypress as well as a click, so the policy context carries the key.
        {
          ref: input.ref,
          key: input.key,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).key(input, signal),
      );
    },

    scroll(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ScrollInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_scroll",
        botId,
        actor,
        { ...(approvalId ? { approvalId } : {}) },
        () => as(botId).scroll(input),
      );
    },

    /**
     * The file tools, governed like everything else.
     *
     * The read is governed too, unlike reading a page. A page was permitted when it was opened; the
     * workspace accumulates whatever a Bot has saved across every task it has ever run, so which of
     * those files it may read back is a real question for a deployment to be able to answer.
     */
    readFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ReadFileInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_read_file",
        botId,
        actor,
        { filePath: input.path, ...(approvalId ? { approvalId } : {}) },
        () => as(botId).readFile(input),
      );
    },

    /**
     * Listing is governed too, and for the same reason the read is: what a Bot has accumulated over
     * every task it has run is worth being able to restrict. A rule denying a folder hides it from the
     * listing as well as from reads, which is the consistent answer.
     */
    listFiles(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ListFilesInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_list_files",
        botId,
        actor,
        {
          filePath: input.path ?? ".",
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).listFiles(input),
      );
    },

    writeFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: WriteFileInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_write_file",
        botId,
        actor,
        { filePath: input.path, ...(approvalId ? { approvalId } : {}) },
        () => as(botId).writeFile(input),
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
function describeFile(path: string): {
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

export type ComputerGateway = ReturnType<typeof createComputerGateway>;

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

function intentOf(
  toolName: string,
  key: string | undefined,
): PolicyContext["intent"] {
  switch (toolName) {
    case "computer_click":
      return "activate";
    case "computer_key":
      return key && ACTIVATING_KEYS.has(key) ? "activate" : "type";
    case "computer_type":
      return "type";
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
    computerId: string;
    element: SnapshotElement | undefined;
    ref: string | undefined;
    /** Which key, for a keypress. Recorded because a keypress can act without naming a button. */
    key?: string | undefined;
    filePath: string | undefined;
    pageUrl: string;
    decision: PolicyDecision;
    /**
     * Who allowed this, when the boundary asked and somebody said yes.
     *
     * On the action row as well as on the approval row, because the two are found by different
     * questions: a reader following one Bot's actions should not have to go and correlate ids to
     * discover that a person stood behind this particular click.
     */
    approvedBy?: string;
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
    targetId: entry.computerId,
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
      element: entry.element
        ? {
            role: entry.element.role,
            name: entry.element.name,
            ...(entry.element.type ? { type: entry.element.type } : {}),
          }
        : entry.filePath
          ? // A file action has no element and never will. File rows leave the element field absent
            // rather than describing a browser snapshot.
            undefined
          : // An action on an element the server cannot identify is worth recording plainly, rather
            // than as an absent field that reads like a logging gap.
            "not in the current snapshot",
      ...(entry.failure ? { failure: entry.failure } : {}),
      decision: {
        allowed: entry.decision.allowed,
        mode: entry.decision.mode,
        source: entry.decision.source,
        rule: entry.decision.matched,
        ...(entry.approvedBy ? { approvedBy: entry.approvedBy } : {}),
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
    computerId: string;
    reason?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });
}

/**
 * The row for a question the boundary stopped to ask.
 *
 * Its own writer rather than a variant of either of the others, because an approval sits between
 * them and fits neither shape. It is not `write`: no decision was reached, the policy said it wanted
 * a person and the turn stopped there, and inventing an allowed-or-refused verdict for that row would
 * be the comfortable fiction the rest of this file is careful to avoid. It is not
 * `writeControlEvent`: a handover is a person taking the browser away from the Bot, whereas this is a
 * question about one specific action, so the row has to name the action or a reader cannot tell what
 * was being agreed to.
 *
 * The answer's row is written where the answer is given, which is not here. All of them carry the
 * approval id: that is what lets a reader join a request to its answer and to the action that
 * finally happened, and it is the only way to see the case that matters most, a question that was
 * asked and never answered.
 */
async function writeApprovalEvent(
  auditStore: AuditStore,
  entry: {
    botId: string;
    actor: ActionActor;
    computerId: string;
    approval: PendingApproval;
    toolName?: string;
    pageUrl?: string;
    filePath?: string | undefined;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: "approval.requested",
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      approval: entry.approval.id,
      rule: entry.approval.rule,
      // The question as a person read it. Element labels are things a page displays rather than
      // things anybody typed, which is why the reason text is safe to keep here; see the note on
      // `write` above.
      reason: entry.approval.question,
      ...(entry.toolName ? { action: entry.toolName } : {}),
      ...(entry.pageUrl ? { page: entry.pageUrl } : {}),
      ...(entry.filePath ? { file: entry.filePath } : {}),
    },
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
