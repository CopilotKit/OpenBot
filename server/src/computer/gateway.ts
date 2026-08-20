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
import type { ComputerClient } from "./client";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
} from "./policy";
import type {
  ClickInput,
  ComputerStatus,
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
      /** The person's Stop, on its way to the browser. See the acting methods below. */
      signal?: AbortSignal;
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
      decision,
    });

    if (!decision.forward) {
      throw new ActionRefusedError(decision.reason, decision.matched);
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
    snapshot,
    read,

    /**
     * Inspect a Bot's computer status without provisioning or waking it.
     *
     * With a supervisor, this reads current inventory from list() and maps the container/sandbox
     * state to a ComputerStatus. Without a supervisor, it delegates to client.status(botId).
     */
    async status(botId: string): Promise<ComputerStatus> {
      if (supervisor?.list) {
        try {
          const list = await supervisor.list();
          const entry = list.find((item) => item.botId === botId);
          if (!entry) {
            return { botId, state: "absent" };
          }
          const rawStatus = entry.status ?? "";
          const status = rawStatus.toLowerCase();
          switch (status) {
            case "running":
            case "started":
              return { botId, state: "ready" };
            case "created":
            case "restarting":
            case "creating":
            case "starting":
            case "restoring":
            case "pulling_snapshot":
            case "resuming":
              return { botId, state: "starting" };
            case "stopped":
            case "paused":
            case "archived":
            case "exited":
            case "destroyed":
            case "removing":
            case "archiving":
            case "pausing":
            case "stopping":
              return { botId, state: "absent" };
            case "error":
            case "build_failed":
              return {
                botId,
                state: "unreachable",
                reason: `The computer reported state "${rawStatus}".`,
              };
            default:
              return {
                botId,
                state: "unreachable",
                reason: `The computer reported unknown state "${rawStatus}".`,
              };
          }
        } catch (error) {
          return {
            botId,
            state: "unreachable",
            reason:
              error instanceof Error && error.message.length > 0
                ? error.message
                : "Unknown failure.",
          };
        }
      }
      return as(botId).status(botId);
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
    ) {
      return govern(
        computerId,
        "computer_navigate",
        botId,
        actor,
        { targetUrl: url },
        () => as(botId).navigate(url),
      );
    },

    click(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
    ) {
      return govern(
        computerId,
        "computer_click",
        botId,
        actor,
        { ref: input.ref, ...(signal ? { signal } : {}) },
        () => as(botId).click(input, signal),
      );
    },

    type(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
    ) {
      return govern(
        computerId,
        "computer_type",
        botId,
        actor,
        { ref: input.ref, ...(signal ? { signal } : {}) },
        () => as(botId).type(input, signal),
      );
    },

    key(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
    ) {
      return govern(
        computerId,
        "computer_key",
        botId,
        actor,
        // The key is part of the subject, so a rule can tell Enter from a letter. Form submission can
        // happen through a keypress as well as a click, so the policy context carries the key.
        { ref: input.ref, key: input.key, ...(signal ? { signal } : {}) },
        () => as(botId).key(input, signal),
      );
    },

    scroll(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ScrollInput,
    ) {
      return govern(computerId, "computer_scroll", botId, actor, {}, () =>
        as(botId).scroll(input),
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
    ) {
      return govern(
        computerId,
        "computer_read_file",
        botId,
        actor,
        { filePath: input.path },
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
    ) {
      return govern(
        computerId,
        "computer_list_files",
        botId,
        actor,
        { filePath: input.path ?? "." },
        () => as(botId).listFiles(input),
      );
    },

    writeFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: WriteFileInput,
    ) {
      return govern(
        computerId,
        "computer_write_file",
        botId,
        actor,
        { filePath: input.path },
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
