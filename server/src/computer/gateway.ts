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
import { ComputerUnavailableError, createComputerTransport } from "./client";
import { checkComputerAddress } from "./target";
export {
  ComputerUnavailableError,
  ElementNotFoundError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "./client";
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
  ScreenshotResult,
  ScrollInput,
  SecretRequest,
  SecretResult,
  SnapshotElement,
  SnapshotResult,
  TypeInput,
  RunCommandInput,
  RunCommandResult,
  WriteFileInput,
  WriteFileResult,
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
  takeControl(botId: string, actor: ActionActor): Promise<ControlState>;
  releaseControl(botId: string, actor: ActionActor): Promise<ControlState>;
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
  humanInput(botId: string, input: HumanInput): Promise<HumanInputResult>;
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
  const snapshots = new Map<string, CachedSnapshot>();

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

  async function post<T>(
    botId: string,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return transport.post<T>(await locate(botId), botId, path, payload, signal);
  }

  /** Read-only, so it passes straight through. Nothing has changed and there is nothing to decide. */
  async function screenshot(botId: string): Promise<ScreenshotResult> {
    return get<ScreenshotResult>(botId, "/screenshot");
  }

  async function snapshot(botId: string): Promise<SnapshotResult> {
    const result = await transport.call<SnapshotResult>(
      await locate(botId),
      botId,
      "/snapshot",
      { method: "POST" },
    );
    snapshots.set(botId, {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(
        result.elements.map((element) => [element.ref, element]),
      ),
    });
    return result;
  }

  async function read(botId: string): Promise<ReadResult> {
    return get<ReadResult>(botId, "/read");
  }

  /**
   * Resolve a ref against the snapshot the server holds.
   *
   * Returns undefined for an unknown ref rather than throwing, because the policy still has to run:
   * an action on an element we cannot identify must still receive a policy decision.
   * A deny rule written against a page a Bot has not snapshotted should still refuse it.
   */
  function resolve(
    botId: string,
    ref: string | undefined,
  ): SnapshotElement | undefined {
    if (!ref) return undefined;
    return snapshots.get(botId)?.elements.get(ref);
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
      filePath?: string;
      targetUrl?: string;
      key?: string;
      /** The command a shell call is about to run, so a rule can be written against it. */
      command?: string;
      /** The person's Stop, on its way to the browser. See the acting methods below. */
      signal?: AbortSignal;
    },
    run: () => Promise<T>,
  ): Promise<T> {
    const { ref, filePath } = subject;
    const element = resolve(botId, ref);
    const cached = snapshots.get(botId);
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
      ...(subject.command ? { command: subject.command } : {}),
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
      const state = await post<ControlState>(botId, "/control/take", {});
      await writeControlEvent(auditStore, "computer.control_taken", {
        botId,
        actor,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      return state;
    },

    async releaseControl(botId: string, actor: ActionActor) {
      const state = await post<ControlState>(botId, "/control/release", {});
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
      snapshots.delete(botId);
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
      input: HumanInput,
    ): Promise<HumanInputResult> {
      const { kind, ...payload } = input;
      return post<HumanInputResult>(botId, `/human/${kind}`, payload);
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
        { ref: input.ref, ...(signal ? { signal } : {}) },
        () => post<ActionResult>(botId, "/click", input, signal),
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
        { ref: input.ref, ...(signal ? { signal } : {}) },
        () => post<ActionResult>(botId, "/type", input, signal),
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
        { ref: input.ref, key: input.key, ...(signal ? { signal } : {}) },
        () => post<ActionResult>(botId, "/key", input, signal),
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
        () => post<RunCommandResult>(botId, "/exec", input, caller),
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
      element: entry.element
        ? {
            role: entry.element.role,
            name: entry.element.name,
            ...(entry.element.type ? { type: entry.element.type } : {}),
          }
        : entry.filePath || entry.command
          ? // A file or command action has no element and never will. Those rows leave the element
            // field absent rather than describing a browser snapshot.
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
