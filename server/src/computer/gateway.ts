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
 *  3. Write the row, whichever way the decision went, and only then act. An action the person is
 *     asked about first is written when they answer: refused if they deny it, attempted if they
 *     allow it.
 *
 * Step 1 is the one that is easy to skip and fatal to skip. A gateway that decides on a label supplied
 * by the model is theatre: "never click Submit" is evaded by sending `{ref: "e13", name: "Continue"}`.
 * The refs are opaque to the caller precisely so that the server holds the mapping.
 */

import { DECLINED_BY_PERSON } from "@openbot/shared/approval-outcomes";
import type {
  ControlRequestInput,
  RequestHelpInput,
  RequestHelpSource,
} from "@openbot/shared/computer-control";
import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import {
  ApprovalAlreadyAnsweredError,
  type ApprovalGate,
  ApprovalNeedsConversationError,
  ApprovalRefusedError,
  currentApprovalContext,
} from "../approvals/types";
import {
  type AuditEventInput,
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { withUntrustedNotice } from "../untrusted-content";
import {
  ComputerStillStartingError,
  ComputerStoppedError,
  ComputerUnavailableError,
  createComputerTransport,
  StaleSnapshotError,
} from "./client";
import {
  type ComputerKey,
  type ComputerSeat,
  type ComputerSeatResolver,
  computerKeyText,
  personSeat,
  seatText,
} from "./computer-key";
import { computerTokenOf } from "./computer-token";
import { checkComputerAddress } from "./target";

export {
  ActionUnfinishedError,
  ComputerStillStartingError,
  ComputerUnavailableError,
  ElementNotFoundError,
  HandoffRequestError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "./client";

import type { PageFrameStore } from "./page-frames";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
  policyInitiator,
} from "./policy";
import type {
  ComputerProvider,
  ComputerTarget,
  ComputerUpdate,
} from "./provider";
import type {
  ActionResult,
  ClickInput,
  ComputerStatus,
  ControlState,
  DownloadFileInput,
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
  SignInCodeInput,
  SignInCodeResult,
  SignInFillInput,
  SignInFillResult,
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
  /** What started this run; scheduled work must not inherit person initiation. */
  initiator?: AuditInitiator;
};

export type ComputerGatewayOptions = {
  approvalGate?: ApprovalGate;
  provider: ComputerProvider;
  auditStore: AuditStore;
  /** Absent denies everything. See evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
  /** True on a laptop, where browsing private network addresses is required. */
  allowPrivateHosts?: boolean;
  /**
   * The deployment's `COMPUTER_TOKEN`. What a call carries is the token of the computer it goes to,
   * which on a computer of one person's own is derived from this rather than this (computer-token.ts).
   */
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
  /**
   * Which computer a Bot runs on for a person. See computer-key.ts.
   *
   * Absent, every Bot runs on the person's own computer and none is isolated: the safe answer for a
   * gateway with no database to read a Bot's isolation from, because it never puts two people on one
   * computer.
   */
  seats?: ComputerSeatResolver;
  /** Names for the people whose computers the admin screen lists. Absent, it shows their ids. */
  people?: (
    ids: string[],
  ) => Promise<Map<string, { name: string | null; email: string }>>;
  /**
   * Whose OpenBot browser each of these computers is (`person-` ids, browser/person.ts), as user ids. A person's browser
   * is a computer of its own named by a hash, so without this the admin screen cannot say whose it is.
   */
  browserOwners?: (computerIds: string[]) => Promise<Map<string, string>>;
};

/** One computer, or one seat on the shared computer, as the admin screen lists it. */
export type FleetComputer = {
  /** Whose computer, as text: `person:<id>` or `bot:<id>`. What the admin routes address. */
  computer: string;
  kind: ComputerKey["kind"];
  /** The person it belongs to, on a person's computer. */
  personId?: string;
  /** That person's name and address; on a person's own OpenBot browser, whose browser it is. */
  person?: { name: string | null; email: string };
  /** The Bot: an isolated Bot's own computer, or one Bot's seat on the shared computer. */
  botId?: string;
  running: boolean;
  startedAt: string | null;
  egress?: string | null;
  updateAvailable?: boolean;
};

export interface ComputerGateway {
  readonly provider: ComputerProvider;
  /** Whose computer a Bot runs on. The rule lives in computer-key.ts. */
  readonly seats: ComputerSeatResolver;
  /** The seat a Bot takes when it acts for this person. Every call below is made for one. */
  seatFor(botId: string, personId: string): Promise<ComputerSeat>;
  /** What names this seat to the computer, for the live screen's socket. */
  addressOf(seat: ComputerSeat): { botId: string; personId?: string };
  /**
   * The token the computer this seat is on takes, for a call made to it outside the gateway (the live
   * screen's socket, a browser's routes, a policy push). Never the deployment's own token where the
   * computer holds one of its own.
   */
  tokenFor(seat: ComputerSeat): string | undefined;
  locate(seat: ComputerSeat): Promise<string>;
  status(seat: ComputerSeat): Promise<ComputerStatus>;
  screenshot(seat: ComputerSeat): Promise<ScreenshotResult>;
  snapshot(seat: ComputerSeat): Promise<SnapshotResult>;
  read(seat: ComputerSeat): Promise<ReadResult>;
  navigate(
    seat: ComputerSeat,
    actor: ActionActor,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult>;
  click(
    seat: ComputerSeat,
    actor: ActionActor,
    input: ClickInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  type(
    seat: ComputerSeat,
    actor: ActionActor,
    input: TypeInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  key(
    seat: ComputerSeat,
    actor: ActionActor,
    input: KeyInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  scroll(
    seat: ComputerSeat,
    actor: ActionActor,
    input: ScrollInput,
  ): Promise<ActionResult>;
  readFile(
    seat: ComputerSeat,
    actor: ActionActor,
    input: ReadFileInput,
  ): Promise<ReadFileResult>;
  downloadFile(
    seat: ComputerSeat,
    actor: ActionActor,
    input: DownloadFileInput,
    signal?: AbortSignal,
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    bytes: number;
    name: string;
  }>;
  listFiles(
    seat: ComputerSeat,
    actor: ActionActor,
    input: ListFilesInput,
  ): Promise<ListFilesResult>;
  runCommand(
    seat: ComputerSeat,
    actor: ActionActor,
    input: RunCommandInput,
    signal?: AbortSignal,
  ): Promise<RunCommandResult>;
  writeFile(
    seat: ComputerSeat,
    actor: ActionActor,
    input: WriteFileInput,
  ): Promise<WriteFileResult>;
  control(seat: ComputerSeat, requestId?: string): Promise<ControlState>;
  /** `source` is `manual` for a person taking the wheel themselves; the Bot's own requests are `model`. */
  requestHelp(
    seat: ComputerSeat,
    actor: ActionActor,
    reason: string,
    toolCallId?: string,
    source?: RequestHelpSource,
  ): Promise<ControlState>;
  takeControl(
    seat: ComputerSeat,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  releaseControl(
    seat: ComputerSeat,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  cancelControl(
    seat: ComputerSeat,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  requestSecret(
    seat: ComputerSeat,
    actor: ActionActor,
    input: SecretRequest,
  ): Promise<ControlState>;
  supplySecret(
    seat: ComputerSeat,
    actor: ActionActor,
    text: string,
  ): Promise<SecretResult>;
  /** Fill and submit a login form on the Bot's current page. See passwords/service.ts. */
  signIn(
    seat: ComputerSeat,
    input: SignInFillInput,
    signal?: AbortSignal,
  ): Promise<SignInFillResult>;
  /** Type the verification code a site asked for after the password. See passwords/service.ts. */
  signInCode(
    seat: ComputerSeat,
    input: SignInCodeInput,
    signal?: AbortSignal,
  ): Promise<SignInCodeResult>;
  humanInput(seat: ComputerSeat, input: HumanInput): Promise<HumanInputResult>;
  computers(): Promise<{
    isolation: "per-person" | "shared";
    computers: FleetComputer[];
  }>;
  /** Stop a listed computer, or one seat on the shared computer. An administrator's action. */
  stopTarget(
    target: ComputerTarget,
    actor: ActionActor,
  ): Promise<{ wasRunning: boolean }>;
  /** Reset a listed computer, or one seat on the shared computer. An administrator's action. */
  resetTarget(
    target: ComputerTarget,
    actor: ActionActor,
  ): Promise<{ cleared: boolean }>;
  /** Move a listed computer onto the current image. An administrator's action. */
  updateTarget(key: ComputerKey, actor: ActionActor): Promise<ComputerUpdate>;
  stopComputer(
    seat: ComputerSeat,
    actor: ActionActor,
  ): Promise<{ wasRunning: boolean }>;
  resetComputer(
    seat: ComputerSeat,
    actor: ActionActor,
  ): Promise<{ cleared: boolean }>;
  /**
   * A Bot's browser was cleared by the person holding its wheel (browser/bot-browser.ts), its profile already gone on
   * the computer: the row for it, then the snapshot and the screenshots kept of its pages, as `resetComputer` does.
   */
  browserCleared(seat: ComputerSeat, actor: ActionActor): Promise<void>;
  /** Move a computer onto the current image, keeping its files and sign-ins. */
  updateComputer(
    seat: ComputerSeat,
    actor: ActionActor,
  ): Promise<ComputerUpdate>;
}

export function createComputerGateway(
  options: ComputerGatewayOptions,
): ComputerGateway {
  const { provider, auditStore } = options;
  /*
   * No token of its own: every call names its computer's (`at`), because a computer made for one
   * person holds a token of its own and must never be sent the deployment's.
   */
  const transport = createComputerTransport({
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
  const seats: ComputerSeatResolver = options.seats ?? {
    seatFor: async (botId, personId) => personSeat(personId, botId),
  };

  /**
   * What names a seat to the computer.
   *
   * The Bot, always. The person only on the shared computer, which is the one computer that carries
   * more than one person and so the only one where the Bot alone would put two people in one seat.
   * A computer of a person's own carries their Bots under each Bot's id, exactly as before.
   */
  function addressOf(seat: ComputerSeat): { botId: string; personId?: string } {
    return provider.isolation === "shared" && seat.key.kind === "person"
      ? { botId: seat.botId, personId: seat.key.personId }
      : { botId: seat.botId };
  }

  /** The token of the computer this seat is on. See computer-token.ts. */
  function tokenFor(seat: ComputerSeat): string | undefined {
    return computerTokenOf(provider, seat.key, options.token);
  }

  /** The located computer at `url`, with the token it takes. */
  function at(
    seat: ComputerSeat,
    url: string,
  ): { url: string; token?: string } {
    const token = tokenFor(seat);
    return token ? { url, token } : { url };
  }

  /**
   * Whether a seat is its computer's only seat, so acting on the seat is acting on the computer.
   *
   * An isolated Bot's own computer is. A Bot's seat on a person's computer is one of several, and
   * a seat on the shared computer is one of many: there a stop or a reset reaches the computer and
   * asks it about that seat alone.
   */
  function seatIsComputer(seat: ComputerSeat): boolean {
    return provider.isolation === "per-person" && seat.key.kind === "bot";
  }

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
  async function locate(seat: ComputerSeat): Promise<string> {
    const address = await provider.locate(seat);
    const verdict = checkComputerAddress(address);
    if (!verdict.allowed) {
      throw new ComputerUnavailableError(verdict.reason);
    }
    return verdict.url;
  }

  async function get<T>(
    seat: ComputerSeat,
    path: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return transport.call<T>(
      at(seat, await locate(seat)),
      addressOf(seat),
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
    seat: ComputerSeat,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
    address?: string,
  ): Promise<T> {
    return transport.post<T>(
      at(seat, address ?? (await locate(seat))),
      addressOf(seat),
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
   *
   * EXCEPT A COMPUTER THAT IS STILL STARTING, which is carried back rather than forgotten. Forgetting
   * it sent the attempt to `locate` again, and that is a second full cold-start wait stacked on the
   * first: a click on a sleeping computer held its request open twice as long before saying
   * anything. The attempt throws the carried error instead, inside the block that writes the failure
   * row, so the trail still shows a permitted action that was not performed.
   */
  async function locateForAction(
    seat: ComputerSeat,
  ): Promise<{ address?: string; starting?: ComputerStillStartingError }> {
    try {
      return { address: await locate(seat) };
    } catch (error) {
      return error instanceof ComputerStillStartingError
        ? { starting: error }
        : {};
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

  /*
   * A download has no command-like budget of its own. The computer refuses oversized files before
   * streaming, but a large permitted file can still outlive the ordinary request deadline on a slow
   * link. Five minutes is a backstop, not a size limit.
   */
  const DOWNLOAD_BACKSTOP_MS = 300_000;

  /** Read-only, so it passes straight through. Nothing has changed and there is nothing to decide. */
  async function screenshot(seat: ComputerSeat): Promise<ScreenshotResult> {
    return get<ScreenshotResult>(seat, "/screenshot");
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
  async function snapshot(seat: ComputerSeat): Promise<SnapshotResult> {
    const base = await locate(seat);
    /*
     * Which run this is, asked before the page is drawn rather than after it.
     *
     * After `locate`, because on a supervisor that is the `/ensure` that reports it. But before
     * `/snapshot`, because the two answers have to describe the same browser and asking afterwards
     * does not guarantee it: a computer replaced while the snapshot was being taken would have its
     * dead page stamped with the run of the browser that replaced it, so every ref on that page would
     * resolve against the live run and the live run's own snapshots would be refused for being older.
     *
     * Asked first, a replacement in that window leaves a row carrying a run that is already gone.
     * Nothing resolves against it and the next snapshot supersedes it, which is the direction this is
     * allowed to fail in.
     */
    const run = await sessionOf(seat);
    const result = await transport.call<SnapshotResult>(
      at(seat, base),
      addressOf(seat),
      "/snapshot",
      { method: "POST" },
    );
    await snapshots.save(seatText(seat), {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(
        result.elements.map((element) => [element.ref, element]),
      ),
      ...run,
    });
    // Element names and values are whatever the page says they are, so they are marked too.
    return withUntrustedNotice(result, "web page", SNAPSHOT_FIELDS);
  }

  /**
   * Which run of the computer this is, shaped to spread into a snapshot.
   *
   * Absent for a provider that cannot say, and absent if asking fails: a session that cannot be read
   * must not stop a snapshot being recorded, because a snapshot nobody stored is a ref that resolves
   * to nothing and a boundary deciding with no element in front of it.
   */
  async function sessionOf(seat: ComputerSeat): Promise<{ session?: string }> {
    if (!provider.sessionOf) return {};
    try {
      const session = await provider.sessionOf(seat);
      return session ? { session } : {};
    } catch {
      return {};
    }
  }

  async function read(seat: ComputerSeat): Promise<ReadResult> {
    // Page text is outside content: marked here, once, so the headless tools and the browser's
    // routes hand the model the same envelope. See untrusted-content.ts.
    return withUntrustedNotice(
      await get<ReadResult>(seat, "/read"),
      "web page",
      PAGE_FIELDS,
    );
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
     * Undefined means unknown, not mismatched: a provider that could not be asked leaves the
     * generation check exactly as it was, rather than refusing every ref it holds.
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
   * The link this click would follow, when it is one to open rather than click.
   *
   * Read from the snapshot this server holds, never from the caller. Only a lookup: whether the ref
   * is still current for this run of the computer is `govern`'s to decide, and it refuses a stale one
   * on the navigation exactly as it would on the click.
   */
  async function linkToFollow(
    seat: ComputerSeat,
    input: ClickInput,
  ): Promise<{ url: string; element: SnapshotElement } | undefined> {
    const stored = await snapshots.load(seatText(seat));
    if (!stored || stored.snapshotId !== input.snapshotId) return undefined;
    const element = stored.elements.get(input.ref);
    const url = element ? followableLink(element, stored.url) : undefined;
    return element && url ? { url, element } : undefined;
  }

  /**
   * Decide, ask, record, then act.
   *
   * The audit row is written before the action runs, not after it succeeds. An allowed action that
   * later fails is still part of the audit sequence, and a trail that only contains successes cannot
   * show that sequence. It is written after the person is asked, where they are: until they answer,
   * the action has not been attempted.
   */
  async function govern<T>(
    toolName: string,
    seat: ComputerSeat,
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
    const stored = await snapshots.load(seatText(seat));
    /*
     * LOCATE FIRST, THEN ASK WHICH RUN THAT WAS. The order is the check.
     *
     * On the supervisor, `sessionOf` answers with what the last `/ensure` reported, and until this
     * action has made its own, the last one belongs to the action before it. Asking first compared
     * the stored snapshot against the previous action's run, which is the same run on every action
     * but the first one after a replacement — exactly the action the check exists to catch. The
     * click after a replaced container was allowed and the one after that refused, which is a
     * guarantee arriving one action too late. The shared provider has no `/ensure` to read back, so
     * there it is a live `/run` call of its own — one extra round trip per ref-citing action —
     * which asks after `locate` for the same reason even though `locate` there is a string.
     *
     * Only for an action that cites a ref. Nothing else is resolved against a snapshot, so nothing
     * else needs the run, and a scroll or a file read should not have to reach the supervisor before
     * the policy has even seen it. The address that comes back is the one the attempt then uses, so
     * on the supervisor this costs no extra call for the actions that do need it.
     */
    const located = ref ? await locateForAction(seat) : undefined;
    const address = located?.address;
    const { session } = ref ? await sessionOf(seat) : { session: undefined };
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
      bot: { id: seat.botId },
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
      initiator: policyInitiator(actor.initiator),
      // Neutral, like the fields above: this is not an MCP call, but a `deny: mcp.effect == "write"`
      // names `mcp`, and cel-js throws on an unbound identifier — which fails closed and would refuse
      // every browser action the moment an operator wrote a rule about their tools. Empty server and
      // tool and an empty effect match no MCP rule, so a boundary drawn around MCP leaves the browser
      // alone. The MCP context carries the browser fields empty for the mirror of this reason.
      mcp: { server: "", tool: "", effect: "" },
    };

    const decision = evaluateActionPolicy(options.policy(), context);
    /** What every row about this action carries: its subject, and the policy's decision on it. */
    const subjectOf = {
      toolName,
      seat,
      actor,
      element,
      ref,
      ...(subject.key ? { key: subject.key } : {}),
      ...(subject.command ? { command: subject.command } : {}),
      filePath,
      pageUrl,
      decision,
    };
    if (!decision.forward) {
      await write(auditStore, subjectOf);
      throw new ActionRefusedError(decision.reason, decision.matched);
    }

    /*
     * ASK BEFORE RECORDING THE ATTEMPT. The row below says the action was sent to the computer, so it
     * is written only once nothing stands between the action and the computer. It used to be written
     * before the approval gate, and an action the person then denied stayed on the trail as allowed
     * and carried out. Now an action that waits for the person has no row of its own until it is
     * answered: the gate's `approval.evaluated` row says it was asked, a denial writes the refusal
     * the gate was handed below (`declined`), and an approval writes this row when the action runs.
     *
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
     * Either refusal still leaves a row: an action whose ref resolves to nothing is still an action
     * somebody tried to take, and it is on the trail as one that did not happen.
     */
    // The element's label, attached on the way out, so the transcript can say what was acted on
    // instead of quoting a ref. The computer cannot supply this: it knows the ref, and the resolved
    // snapshot lives here. File calls carry their own path already, so there is nothing to add.
    const withElement = (output: T): T =>
      element && output && typeof output === "object"
        ? { ...output, element: { role: element.role, name: element.name } }
        : output;
    let approval: Awaited<ReturnType<ApprovalGate>>;
    try {
      if (located?.starting) throw located.starting;
      if (ref && stored && !element) {
        throw new StaleSnapshotError(
          `${ref} is not on the page this computer is showing, so nothing can be checked against it before acting. Take a fresh snapshot and use the refs it returns.`,
        );
      }
      const continuation = currentApprovalContext();
      approval = await options.approvalGate?.({
        actorId: actor.id,
        botId: seat.botId,
        toolRef: toolName,
        effect: approvalEffectOf(intent),
        scope: approvalScopeOf({
          filePath,
          command: subject.command,
          pageUrl,
        }),
        args: continuation?.args ?? { ...subject, signal: undefined },
        target: {
          pageUrl,
          ...(element ? { element, snapshotId } : {}),
          ...(filePath ? { filePath } : {}),
        },
        continuation,
        declined: auditRow({
          ...subjectOf,
          refusal: { kind: "person_declined", reason: DECLINED_BY_PERSON },
        }),
      });
    } catch (error) {
      // Waiting for the person, or the re-check before an approved action runs: nothing was attempted
      // and nothing was refused, so there is nothing to record yet.
      if (error instanceof HeadlessToolSuspension) throw error;
      if (error instanceof ApprovalRefusedError) {
        /*
         * Turned away at the gate: the person already denied an equivalent action in this
         * conversation, or one is already waiting for them. A refusal like a boundary's, though the
         * policy allowed it. Two answers are not refusals of anything new and leave no row: a call
         * that has to come again through the conversation that can ask, and the same call answered
         * already, whose answer was recorded when it was given.
         */
        if (
          !(error instanceof ApprovalNeedsConversationError) &&
          !(error instanceof ApprovalAlreadyAnsweredError)
        )
          await write(auditStore, {
            ...subjectOf,
            refusal: { kind: "approval", reason: error.message },
          });
        throw error;
      }
      await write(auditStore, {
        ...subjectOf,
        failure: error instanceof Error ? error.message : "The action failed.",
      });
      throw error;
    }
    // Carried out (or done by the person) when it was first answered, and recorded then.
    if (approval && "replay" in approval)
      return withElement(approval.replay as T);

    /*
     * The attempt, written before acting: there is no path that acts without this row. An allowed
     * action that then fails gets a second row saying so, carrying the same `attempt` id, because an
     * allowed action may have partial effects before failing and the trail has to say both that it
     * was sent and that it did not succeed. The audit page shows the pair as the one action it is.
     */
    const attempt = crypto.randomUUID();
    await write(auditStore, { ...subjectOf, attempt });
    let result: T;
    try {
      result = await run(address);
      await approval?.complete(result);
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) throw error;
      /**
       * A permitted action that did not happen gets its own row.
       *
       * Without this the trail lies by omission. The row above says the policy allowed the call, and
       * a reader takes "allowed" to mean "it happened".
       *
       * It carries the same subject the decision row did, and for the same reasons: a shell call
       * that failed part-way is the row somebody most needs to name the command from, and a keypress
       * that failed is still the difference between a submitted form and a typed letter. Leaving
       * them off also chose the wrong element branch below, because "this action never had an
       * element" is decided by the command and the file path — so a failed command claimed a
       * snapshot lookup that never happened.
       */
      await write(auditStore, {
        ...subjectOf,
        attempt,
        failure: error instanceof Error ? error.message : "The action failed.",
        // A person pressing Stop mid-action is not the computer failing. The message still says so;
        // this keeps the row's type a stop, so a count of failed actions does not read every Stop as
        // an outage.
        ...(error instanceof ComputerStoppedError ? { stopped: true } : {}),
      });
      throw error;
    }
    return withElement(result);
  }

  /** A stop of one seat. See `seatIsComputer`. */
  async function stopSeat(
    seat: ComputerSeat,
  ): Promise<{ wasRunning: boolean }> {
    if (seatIsComputer(seat) || provider.isolation === "shared") {
      return provider.stop({ key: seat.key, botId: seat.botId });
    }
    /*
     * One Bot's browser on a person's computer, which carries the person's other Bots too, so the
     * computer is asked to close that one browser rather than being stopped. A computer that is not
     * up has no browser running, and is not woken to say so.
     */
    if ((await provider.status(seat)).state !== "ready") {
      return { wasRunning: false };
    }
    const body = await post<{ wasRunning?: boolean }>(
      seat,
      "/computers/stop",
      {},
    );
    return { wasRunning: body?.wasRunning === true };
  }

  /** A reset of one seat. See `seatIsComputer`. */
  async function resetSeat(seat: ComputerSeat): Promise<{ cleared: boolean }> {
    if (seatIsComputer(seat) || provider.isolation === "shared") {
      return provider.reset({ key: seat.key, botId: seat.botId });
    }
    /*
     * This Bot's profile on a person's computer, and nothing else there. Reaching it starts the
     * computer if it is asleep, which a reset is worth: the profile is on its disk.
     */
    const body = await post<{ reset?: boolean }>(seat, "/computers/reset", {});
    return { cleared: body?.reset === true };
  }

  /**
   * Take the saved state for a seat, or for every seat on a computer, with its profile.
   *
   * The refs the last snapshot handed out describe a page that no longer exists, and a fresh
   * computer counts generations from one again, so the row has to go with the profile. And the
   * pictures: "every login the Bot had is gone" was said while screenshots of the signed-in pages
   * stayed in the database, still readable from the transcript by anybody who could reach that Bot.
   * A reset that leaves those has not reset anything a person would recognise as private.
   */
  async function forget(filedUnder: string): Promise<void> {
    await snapshots.clear(filedUnder);
    await pageFrames?.clear(filedUnder);
  }

  async function update(
    key: ComputerKey,
    actor: ActionActor,
    seat?: ComputerSeat,
  ): Promise<ComputerUpdate> {
    if (!provider.update) {
      throw new ComputerUnavailableError(
        `The ${provider.name} computer provider has no computer image of its own to update.`,
      );
    }
    const result = await provider.update(key);
    await writeControlEvent(auditStore, "computer.updated", {
      seat: seat ?? { key },
      actor,
      reason: !result.updated
        ? "the computer was already on the current image, or had none"
        : result.wasRunning
          ? `the computer is restarting on ${result.to}, keeping its files and sign-ins`
          : `the computer will start on ${result.to} when it is next used`,
    });
    return result;
  }

  return {
    provider,
    seats,
    seatFor: (botId: string, personId: string) =>
      seats.seatFor(botId, personId),
    addressOf,
    tokenFor,
    locate,
    screenshot,
    snapshot,
    read,

    status(seat: ComputerSeat): Promise<ComputerStatus> {
      return provider.status(seat);
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
      seat: ComputerSeat,
      actor: ActionActor,
      reason: string,
      toolCallId?: string,
      source: RequestHelpSource = "model",
    ) {
      const state = await post<ControlState>(seat, "/control/request", {
        reason,
        ...(toolCallId ? { toolCallId } : {}),
        source,
      } satisfies RequestHelpInput);
      await writeControlEvent(auditStore, "computer.help_requested", {
        seat,
        actor,
        reason,
      });
      return state;
    },

    async takeControl(
      seat: ComputerSeat,
      actor: ActionActor,
      requestId: string,
    ) {
      // Who took it, which the computer keeps as `heldBy`: the Bot's browser's bar and Record are that person's alone
      // (shared/bot-browser.ts), so a recording is never filed under someone who was only watching.
      const state = await post<ControlState>(seat, "/control/take", {
        requestId,
        by: actor.id,
      } satisfies ControlRequestInput);
      await writeControlEvent(auditStore, "computer.control_taken", {
        seat,
        actor,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      return state;
    },

    async releaseControl(
      seat: ComputerSeat,
      actor: ActionActor,
      requestId: string,
    ) {
      const state = await post<ControlState>(seat, "/control/release", {
        requestId,
      });
      await writeControlEvent(auditStore, "computer.control_released", {
        seat,
        actor,
      });
      return state;
    },

    async cancelControl(
      seat: ComputerSeat,
      actor: ActionActor,
      requestId: string,
    ) {
      const state = await post<ControlState>(seat, "/control/cancel", {
        requestId,
      });
      await writeControlEvent(auditStore, "computer.help_cancelled", {
        seat,
        actor,
      });
      return state;
    },

    control(seat: ComputerSeat, requestId?: string): Promise<ControlState> {
      return get<ControlState>(
        seat,
        `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
      );
    },

    /**
     * Every computer the configured provider owns, saying whose each one is.
     *
     * A person's computer names the person, with their name where the deployment knows it; an
     * isolated Bot's names the Bot. On the shared computer each entry is one Bot's seat, and names
     * both.
     */
    async computers() {
      const computers = await provider.list();
      const botIdOf = (computer: (typeof computers)[number]) =>
        computer.botId ??
        (computer.key.kind === "bot" ? computer.key.botId : undefined);
      // A person's own OpenBot browser (Teach a Bot's) is listed under its own id, which is no Bot's: say whose it is.
      const browserIds = computers.flatMap((computer) => {
        const id = botIdOf(computer);
        return id && isPersonBrowserId(id) ? [id] : [];
      });
      const owners =
        browserIds.length > 0 && options.browserOwners
          ? await options
              .browserOwners(browserIds)
              .catch(() => new Map<string, string>())
          : new Map<string, string>();
      const personIds = [
        ...new Set([
          ...computers.flatMap((computer) =>
            computer.key.kind === "person" ? [computer.key.personId] : [],
          ),
          ...owners.values(),
        ]),
      ];
      const people =
        personIds.length > 0 && options.people
          ? await options.people(personIds).catch(() => new Map())
          : new Map<string, { name: string | null; email: string }>();
      return {
        isolation: provider.isolation,
        computers: computers.map((computer): FleetComputer => {
          const botId = botIdOf(computer);
          const owner = botId ? owners.get(botId) : undefined;
          const person =
            computer.key.kind === "person"
              ? people.get(computer.key.personId)
              : owner
                ? people.get(owner)
                : undefined;
          return {
            computer: computerKeyText(computer.key),
            kind: computer.key.kind,
            ...(computer.key.kind === "person"
              ? { personId: computer.key.personId }
              : {}),
            ...(person ? { person } : {}),
            ...(botId ? { botId } : {}),
            running: computer.status === "running",
            startedAt: computer.startedAt ?? null,
            egress: computer.egress,
            ...(computer.updateAvailable !== undefined
              ? { updateAvailable: computer.updateAvailable }
              : {}),
          };
        }),
      };
    },

    /**
     * Stop this Bot's browser, keeping what it knows.
     *
     * On a person's computer that is the Bot's own browser: the person's other Bots on it are
     * untouched. On an isolated Bot's computer it is the computer.
     *
     * Audited, unlike the read above, because a person reached in and stopped something. Recorded
     * whether or not a browser was actually running: "she pressed stop and nothing was running" is a
     * fact worth having, and a trail that only records effective actions cannot tell you what somebody
     * tried.
     */
    async stopComputer(seat: ComputerSeat, actor: ActionActor) {
      const result = await stopSeat(seat);
      await writeControlEvent(auditStore, "computer.stopped", {
        seat,
        actor,
        reason: result.wasRunning
          ? "the computer was stopped"
          : "the computer was already stopped",
      });
      return result;
    },

    /**
     * Move a computer onto the image this deployment now runs.
     *
     * Only a provider that can say a computer is out of date offers it. The row is written for a
     * computer that was already current too, so the trail shows the button was pressed. On a
     * person's computer it moves every Bot there, because they share the one image.
     */
    async updateComputer(seat: ComputerSeat, actor: ActionActor) {
      return update(seat.key, actor, seat);
    },

    /**
     * Wipe this Bot's profile.
     *
     * The most destructive button we have. Every login the Bot had is gone and no undo exists, so the
     * row is written whatever happens next. On a person's computer it is this Bot's profile there
     * and nothing else: the person's other Bots keep their logins.
     */
    async resetComputer(seat: ComputerSeat, actor: ActionActor) {
      const result = await resetSeat(seat);
      /*
       * The row goes in HERE, before the two deletes below, because this line is the point of no
       * return: the profile is already gone and nothing after it can put the logins back.
       *
       * Both clears are Postgres deletes, and a connection reset, a failover or a statement timeout
       * in either used to throw before the row was written -- leaving a computer wiped with nothing
       * on the trail to say who wiped it, which is the one outcome the note above rules out. The
       * failure still propagates, so the caller is told the clears did not finish.
       */
      await writeControlEvent(auditStore, "computer.reset", {
        seat,
        actor,
        reason: result.cleared
          ? "the computer and its saved state were deleted"
          : "no saved state was present to delete",
      });
      await forget(seatText(seat));
      // And what was filed under the Bot alone, before computers were per person: pictures of the same signed-in pages.
      await forget(seat.botId);
      return result;
    },

    async browserCleared(seat: ComputerSeat, actor: ActionActor) {
      // Written first, as a reset's is: the profile is gone already, and a failure in the clears below must not leave
      // the wipe with nothing on the trail to say who made it. That failure still reaches the caller.
      await writeControlEvent(auditStore, "computer.browser_cleared", {
        seat,
        actor,
        reason:
          "a person holding control cleared the browser: its cookies, saved passwords, history and site storage",
      });
      // The refs and the pictures of signed-in pages go with the profile, for the reasons `resetComputer` gives: the
      // seat's, and what was filed under the Bot alone before computers were per person.
      await forget(seatText(seat));
      await forget(seat.botId);
    },

    /**
     * An administrator stopping a computer from the list: a whole computer, or one seat on the
     * shared computer. On a person's computer every Bot there stops and keeps its logins.
     */
    async stopTarget(target: ComputerTarget, actor: ActionActor) {
      const result = await provider.stop(target);
      await writeControlEvent(auditStore, "computer.stopped", {
        seat: target,
        actor,
        reason: result.wasRunning
          ? "the computer was stopped"
          : "the computer was already stopped",
      });
      return result;
    },

    /**
     * An administrator resetting a computer from the list. On a person's computer every Bot there
     * is signed out of everything, and every seat's saved state on it goes too.
     */
    async resetTarget(target: ComputerTarget, actor: ActionActor) {
      const result = await provider.reset(target);
      await writeControlEvent(auditStore, "computer.reset", {
        seat: target,
        actor,
        reason: result.cleared
          ? "the computer and its saved state were deleted"
          : "no saved state was present to delete",
      });
      await forget(
        target.botId
          ? seatText({ botId: target.botId, key: target.key })
          : computerKeyText(target.key),
      );
      // A Bot's own, as `resetComputer` does: what was filed under the Bot alone before computers were per person.
      const bot =
        target.botId ?? (target.key.kind === "bot" ? target.key.botId : null);
      if (bot) await forget(bot);
      return result;
    },

    async updateTarget(key: ComputerKey, actor: ActionActor) {
      return update(key, actor);
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
      seat: ComputerSeat,
      actor: ActionActor,
      input: SecretRequest,
    ) {
      const state = await post<ControlState>(seat, "/control/secret", input);
      await writeControlEvent(auditStore, "computer.secret_requested", {
        seat,
        actor,
        reason: `${input.label} (into ${input.ref})`,
      });
      return state;
    },

    /**
     * Typing a person's login into the Bot's browser, from the private sign-in form.
     *
     * The credential arrives from the passwords module and goes straight to the computer. It is not
     * audited here, not returned, and not logged; the passwords module writes the row, without it.
     */
    signIn(seat: ComputerSeat, input: SignInFillInput, signal?: AbortSignal) {
      return post<SignInFillResult>(
        seat,
        "/sign-in/fill",
        input,
        signal,
        SIGN_IN_BACKSTOP_MS,
      );
    },

    /** The code a site asked for once the password was in, on the same path and terms as the login. */
    signInCode(
      seat: ComputerSeat,
      input: SignInCodeInput,
      signal?: AbortSignal,
    ) {
      return post<SignInCodeResult>(
        seat,
        "/sign-in/code",
        input,
        signal,
        SIGN_IN_BACKSTOP_MS,
      );
    },

    async supplySecret(seat: ComputerSeat, actor: ActionActor, text: string) {
      const result = await post<SecretResult>(seat, "/human/secret", { text });
      await writeControlEvent(auditStore, "computer.secret_supplied", {
        seat,
        actor,
        // Length, never content. Enough to show something real was entered.
        reason: `${result.characters} characters`,
      });
      return result;
    },

    async humanInput(
      seat: ComputerSeat,
      input: HumanInput,
    ): Promise<HumanInputResult> {
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
      return post<HumanInputResult>(seat, `/human/${kind}`, payload);
    },

    /**
     * Opening a page, through the gateway so it lands in the audit trail.
     *
     * The transport applies its target guard before it sends a request. This is
     * the minimum rule that applies even when the action policy permits the URL.
     */
    navigate(
      seat: ComputerSeat,
      actor: ActionActor,
      url: string,
      toolCallId?: string,
    ) {
      return govern(
        "computer_navigate",
        seat,
        actor,
        { targetUrl: url },
        async () =>
          transport.navigate(
            at(seat, await locate(seat)),
            addressOf(seat),
            url,
            toolCallId,
          ),
      ).then((result) => withUntrustedNotice(result, "web page", PAGE_FIELDS));
    },

    async click(
      seat: ComputerSeat,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
    ): Promise<ActionResult> {
      /*
       * FOLLOWING A LINK IS OPENING ITS ADDRESS, SO IT IS DONE AS ONE.
       *
       * A click is a change: it can submit a form or run whatever the page attached to it, so it is
       * judged as one, built-in safety requirements included. A link with an address to another page
       * does what typing that address does, which is already a read. Judging the two differently
       * meant a Bot reading an ordering system was handed back to the person for clicking "PO 102" on
       * a page at `/purchase-orders/...`, while typing the same address went straight through.
       *
       * So the address is opened, not clicked: the same navigation, policy, approval and audit as
       * `computer_navigate`, and the page's own scripts never see a click, so a link that only looks
       * like one (`href="#"` with a handler, `javascript:`) is clicked and judged as a click instead.
       * The ref and snapshot go with it, so the element is still resolved, still refused when stale,
       * and still in front of every rule: a deny written about this link's name refuses this too.
       */
      const follow = await linkToFollow(seat, input);
      if (follow) {
        const opened = await govern(
          "computer_navigate",
          seat,
          actor,
          {
            ref: input.ref,
            snapshotId: input.snapshotId,
            targetUrl: follow.url,
            ...(signal ? { signal } : {}),
          },
          // The signal and the citation travel with it: Stop still lands (as it does on a click,
          // including one pressed while the action waits for approval), and the computer checks the
          // ref against the live page as `/click` does, so a link from a snapshot the browser has
          // since left is refused as stale rather than opened.
          async (address) =>
            transport.navigate(
              at(seat, address ?? (await locate(seat))),
              addressOf(seat),
              follow.url,
              undefined,
              {
                ...(signal ? { signal } : {}),
                citation: { ref: input.ref, snapshotId: input.snapshotId },
              },
            ),
        );
        return {
          action: "click",
          ref: input.ref,
          element: { role: follow.element.role, name: follow.element.name },
          opened: follow.url,
          url: opened.url,
          elapsedMs: opened.elapsedMs,
          ...(opened.challenge ? { challenge: opened.challenge } : {}),
        };
      }
      return govern(
        "computer_click",
        seat,
        actor,
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          ...(signal ? { signal } : {}),
        },
        (address) =>
          post<ActionResult>(seat, "/click", input, signal, undefined, address),
      );
    },

    type(
      seat: ComputerSeat,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_type",
        seat,
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
          post<ActionResult>(seat, "/type", input, signal, undefined, address),
      );
    },

    key(
      seat: ComputerSeat,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_key",
        seat,
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
          post<ActionResult>(seat, "/key", input, signal, undefined, address),
      );
    },

    scroll(seat: ComputerSeat, actor: ActionActor, input: ScrollInput) {
      return govern("computer_scroll", seat, actor, {}, () =>
        post<ActionResult>(seat, "/scroll", input),
      );
    },

    /**
     * The file tools, governed like everything else.
     *
     * The read is governed too, unlike reading a page. A page was permitted when it was opened; the
     * workspace accumulates whatever a Bot has saved across every task it has ever run, so which of
     * those files it may read back is a real question for a deployment to be able to answer.
     */
    readFile(seat: ComputerSeat, actor: ActionActor, input: ReadFileInput) {
      return govern(
        "computer_read_file",
        seat,
        actor,
        { filePath: input.path },
        () => post<ReadFileResult>(seat, "/files/read", input),
      ).then((result) =>
        // A workspace file is whatever the Bot downloaded or was sent, so it is outside content.
        withUntrustedNotice(result, "workspace file", ["text"]),
      );
    },

    /**
     * The bytes leave the workspace, which is a different permission from letting a Bot read them.
     *
     * The decision and audit row use `computer_download_file` / `download_file`; a deployment can
     * therefore allow `computer_read_file` while refusing this, or the reverse. The computer returns
     * a stream, so the size limit is enforced there before any bytes are sent.
     */
    downloadFile(
      seat: ComputerSeat,
      actor: ActionActor,
      input: DownloadFileInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_download_file",
        seat,
        actor,
        { filePath: input.path, ...(signal ? { signal } : {}) },
        async () => {
          const download = await transport.download(
            at(seat, await locate(seat)),
            addressOf(seat),
            `/files/download?path=${encodeURIComponent(input.path)}`,
            signal,
            DOWNLOAD_BACKSTOP_MS,
          );
          return {
            ...download,
            name: describeFile(input.path).name || "download",
          };
        },
      );
    },

    /**
     * Listing is governed too, and for the same reason the read is: what a Bot has accumulated over
     * every task it has run is worth being able to restrict. A rule denying a folder hides it from the
     * listing as well as from reads, which is the consistent answer.
     */
    listFiles(seat: ComputerSeat, actor: ActionActor, input: ListFilesInput) {
      return govern(
        "computer_list_files",
        seat,
        actor,
        { filePath: input.path ?? "." },
        () => post<ListFilesResult>(seat, "/files/list", input),
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
      seat: ComputerSeat,
      actor: ActionActor,
      input: RunCommandInput,
      caller?: AbortSignal,
    ) {
      return govern(
        "computer_run_command",
        seat,
        actor,
        { command: input.command, ...(caller ? { signal: caller } : {}) },
        () =>
          post<RunCommandResult>(
            seat,
            "/exec",
            input,
            caller,
            COMMAND_BACKSTOP_MS,
          ),
      ).then((result) =>
        // What a command prints can be anything it fetched, so the output is marked.
        withUntrustedNotice(result, "command output", ["stdout", "stderr"]),
      );
    },

    writeFile(seat: ComputerSeat, actor: ActionActor, input: WriteFileInput) {
      return govern(
        "computer_write_file",
        seat,
        actor,
        { filePath: input.path },
        () => post<WriteFileResult>(seat, "/files/write", input),
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
 *
 * `\n` and `\r` are Enter too. `key` is free text, and Playwright's keyboard layout names both as
 * aliases of Enter, so a press of either submits the form exactly as Enter does.
 */
const ACTIVATING_KEYS = new Set([
  "Enter",
  "NumpadEnter",
  "\n",
  "\r",
  "Space",
  " ",
]);

/**
 * The key a press ends on, without the modifiers held for it.
 *
 * The computer hands the key straight to Playwright's `press`, which reads `Shift+Enter` as Enter with
 * Shift held, and Chromium submits a form and clicks a focused button on Shift+Enter, Shift+NumpadEnter
 * and Shift+Space exactly as it does on the bare key, and Control+Enter is how most web apps send a
 * message. Matched as written, all of them were `type`, and a rule on `intent == "activate"` let them
 * through. Split the way Playwright splits it: on `+`, except that a `+` with nothing before it is the
 * plus key itself (`Shift++`).
 */
function mainKey(key: string): string {
  let building = "";
  let last = "";
  for (const char of key) {
    if (char === "+" && building) {
      last = building;
      building = "";
    } else building += char;
  }
  return building || last;
}

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
      return key && ACTIVATING_KEYS.has(mainKey(key)) ? "activate" : "type";
    case "computer_navigate":
      return "navigate";
    case "computer_read":
    case "computer_snapshot":
    case "computer_screenshot":
    case "computer_scroll":
      return "read";
    case "computer_read_file":
      return "read_file";
    case "computer_download_file":
      return "download_file";
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

/**
 * Whether the approval gate is asked about a computer action as a change or a read: pressing, typing,
 * saving a file and running a command change something; everything else reads.
 */
export function approvalEffectOf(
  intent: PolicyContext["intent"],
): "read" | "write" {
  return ["activate", "type", "write_file", "run_command"].includes(
    intent ?? "",
  )
    ? "write"
    : "read";
}

/**
 * Where an approval rule finds a computer action: the folder a file is in, the workspace for a
 * command, or the page's host.
 */
export function approvalScopeOf(subject: {
  filePath?: string | undefined;
  command?: string | undefined;
  pageUrl: string;
}): string {
  return subject.filePath
    ? subject.filePath.split("/").slice(0, -1).join("/") || "workspace"
    : subject.command
      ? "workspace"
      : hostOf(subject.pageUrl) || "browser";
}

type ActionRow = {
  toolName: string;
  seat: ComputerSeat;
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
  /** Set when that non-success was a person pressing Stop, so the row is typed a stop, not a failure. */
  stopped?: boolean;
  /**
   * Set when the policy allowed the action and it was refused anyway: by the person, who denied it
   * when asked, or by the approval gate (an equivalent action denied earlier, or one already
   * waiting). `reason` is the sentence the Bot was told.
   */
  refusal?: { kind: "person_declined" | "approval"; reason: string };
  /** One id for the attempt row and the failure or stop row that follows it, so the two read as one action. */
  attempt?: string;
};

async function write(auditStore: AuditStore, entry: ActionRow) {
  await recordAuditEvent(auditStore, auditRow(entry));
}

function auditRow(entry: ActionRow): AuditEventInput {
  return {
    // A failure is its own kind of event, not a variant of "allowed": the whole point of the extra row
    // is that a reader can tell an action that happened from one that was permitted and then did not.
    // A stop is a third kind again: the action did not happen, but nothing broke, so it is neither a
    // failure to be counted as an outage nor an action that was carried out.
    eventType: entry.stopped
      ? "computer.action_stopped"
      : entry.failure
        ? "computer.action_failed"
        : entry.refusal || !entry.decision.allowed
          ? "computer.action_refused"
          : "computer.action_allowed",
    targetType: "computer",
    targetId: entry.seat.botId,
    initiator: entry.actor.initiator,
    // Only ever a real users row. The audit table has a foreign key to it, so writing the local
    // development actor's id here makes every action fail on a constraint violation instead of being
    // recorded. Who it was is in the payload either way.
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.seat.botId,
      /*
       * Whose computer it ran on. What the idle culler groups on: every Bot on a person's computer
       * keeps that one computer awake, so its last use is the last use of any of them.
       */
      computer: computerKeyText(entry.seat.key),
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
      ...(entry.attempt ? { attempt: entry.attempt } : {}),
      ...(entry.refusal
        ? { refusal: entry.refusal.kind, reason: entry.refusal.reason }
        : {}),
      /*
       * The policy's decision, as it was made. A refusal by the person or the gate leaves `allowed`
       * as the policy said, which is what a replay of the policy over this row compares against, and
       * `carriedOut` false: it was not.
       */
      decision: {
        allowed: entry.decision.allowed,
        mode: entry.decision.mode,
        source: entry.decision.source,
        rule: entry.decision.matched,
        /**
         * The rule's name from the Boundaries page, where it has one, so the row reads by what the
         * rule is called. Beside `rule`, never instead of it: the replay and the trail match on the
         * expression.
         */
        ...(entry.decision.ruleName
          ? { ruleName: entry.decision.ruleName }
          : {}),
        /** Present so the trail explains a dry-run row that was recorded as refused but still ran. */
        carriedOut: entry.refusal ? false : entry.decision.forward,
      },
    },
  };
}

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
    | "computer.help_cancelled"
    | "computer.control_taken"
    | "computer.control_released"
    | "computer.secret_requested"
    | "computer.secret_supplied"
    | "computer.stopped"
    | "computer.reset"
    | "computer.browser_cleared"
    | "computer.updated",
  entry: {
    /** The seat, or for an administrator's action on a whole computer, just its key. */
    seat: { botId?: string; key: ComputerKey };
    actor: ActionActor;
    reason?: string;
  },
) {
  const computer = computerKeyText(entry.seat.key);
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "computer",
    targetId: entry.seat.botId ?? computer,
    initiator: entry.actor.initiator,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      ...(entry.seat.botId ? { bot: entry.seat.botId } : {}),
      computer,
      actor: entry.actor.id,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });
}

/** The fields of a page read that come from the page itself. */
const PAGE_FIELDS = ["title", "text"] as const;
const SNAPSHOT_FIELDS = ["title", "elements"] as const;

/** A two-step login can take two page loads and a wait for a code field; this outlasts the computer's own waits. */
const SIGN_IN_BACKSTOP_MS = 75_000;

/**
 * The address to open for a click on this element, or undefined to click it.
 *
 * A link, with an `http(s)` address, to a different document from the one it is on. Everything else
 * is clicked: a button, a link with no address, `javascript:` and `mailto:`, and a link to a spot on
 * this same page (`#`, `#details`), which loads nothing and is where a page's own script usually acts.
 */
export function followableLink(
  element: Pick<SnapshotElement, "role" | "url">,
  pageUrl: string,
): string | undefined {
  if (element.role !== "link" || !element.url) return undefined;
  let destination: URL;
  try {
    destination = new URL(element.url);
  } catch {
    return undefined;
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:")
    return undefined;
  try {
    const page = new URL(pageUrl);
    page.hash = "";
    const target = new URL(destination.href);
    target.hash = "";
    if (target.href === page.href) return undefined;
  } catch {
    // A page with no readable address: nothing to be the same document as.
  }
  return destination.href;
}

/**
 * The host a rule can match on, or empty.
 *
 * Empty means "no page", which is the accurate answer before a Bot has snapshotted anything, and it is
 * the only case that occurs in practice: the URL comes from Playwright's own `page.url()` by way of the
 * snapshot cache. Worth stating explicitly because a `page.host == "..."` deny rule would not match an
 * empty host, so a boundary that must not be evadable should also key on the tool, the element or the
 * file rather than on the host alone.
 *
 * Without the root dot. `intranet.example.com.` is the same name to DNS, to Chromium and to the
 * computer's own network filter (agent-computer's `normalizeHost`), and `new URL()` keeps the dot, so
 * a navigation written with one used to slip past `page.host == "intranet.example.com"`. The port
 * stays, as it always has: a rule may name one.
 */
export function hostOf(url: string): string {
  try {
    const { hostname, port } = new URL(url);
    const name = hostname.replace(/\.+$/, "");
    return port ? `${name}:${port}` : name;
  } catch {
    return "";
  }
}
