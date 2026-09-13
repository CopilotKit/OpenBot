import { randomUUID } from "node:crypto";
import {
  HOST_ACCESS_DESKTOP_LEASE_MS,
  type HostAccessDesktopOperation,
  type HostAccessDesktopPollResponse,
  type HostAccessDesktopResult,
  type HostAccessGrant,
  type HostAccessStatus,
} from "./schema";

export class HostAccessRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostAccessRefusedError";
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

type OperationState = {
  operation: HostAccessDesktopOperation;
  actorId: string;
  botId: string;
  grantId?: string;
  leasedUntil: number | null;
  expiresAt: number | null;
  expiryTimer: TimerHandle | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

type HostAccessBrokerOptions = {
  desktopLeaseMs?: number;
  operationTtlMs?: number;
};

export type HostAccessBroker = ReturnType<typeof createHostAccessBroker>;

export function createHostAccessBroker(
  now: () => number = Date.now,
  options: HostAccessBrokerOptions = {},
) {
  const desktopLeaseMs = options.desktopLeaseMs ?? HOST_ACCESS_DESKTOP_LEASE_MS;
  const operationTtlMs = options.operationTtlMs ?? 120_000;
  const grants = new Map<string, HostAccessGrant>();
  const operations = new Map<string, OperationState>();
  let desktopConnectedUntil: number | null = null;
  let desktopLeaseTimer: TimerHandle | null = null;

  function unrefTimer(timer: TimerHandle) {
    if (typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  function publicGrant(grant: HostAccessGrant): HostAccessGrant {
    return { ...grant };
  }

  function queueCancelFor(state: OperationState) {
    const cancelOperation: HostAccessDesktopOperation = {
      operationId: randomUUID(),
      targetOperationId: state.operation.operationId,
      kind: "cancel",
      botId: state.botId,
      actorId: state.actorId,
      ...(state.grantId ? { grantId: state.grantId } : {}),
    };
    operations.set(cancelOperation.operationId, {
      operation: cancelOperation,
      actorId: state.actorId,
      botId: state.botId,
      grantId: state.grantId,
      leasedUntil: null,
      expiresAt: null,
      expiryTimer: null,
      resolve: () => {},
      reject: () => {},
      settled: false,
    });
  }

  function failOperation(state: OperationState, reason: string) {
    if (state.settled) return;
    state.settled = true;
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    operations.delete(state.operation.operationId);
    if (state.operation.kind !== "cancel" && state.operation.kind !== "stop") {
      queueCancelFor(state);
    }
    state.reject(new HostAccessRefusedError(reason));
  }

  function expireDesktopLeaseIfNeeded() {
    if (desktopConnectedUntil === null || desktopConnectedUntil > now()) return;
    if (desktopLeaseTimer) {
      clearTimeout(desktopLeaseTimer);
      desktopLeaseTimer = null;
    }
    desktopConnectedUntil = null;
    for (const grant of grants.values()) {
      grant.revoked = true;
    }
    const affected = [...operations.values()].filter(
      (state) =>
        state.operation.kind !== "cancel" && state.operation.kind !== "stop",
    );
    for (const state of affected) {
      failOperation(
        state,
        "The native host worker disconnected before the operation finished.",
      );
    }
  }

  function scheduleDesktopLeaseExpiry() {
    if (desktopLeaseTimer) clearTimeout(desktopLeaseTimer);
    desktopLeaseTimer = setTimeout(() => {
      expireDesktopLeaseIfNeeded();
    }, desktopLeaseMs);
    unrefTimer(desktopLeaseTimer);
  }

  function pendingOperations(actorId?: string): HostAccessDesktopOperation[] {
    return [...operations.values()]
      .filter((state) => !state.settled)
      .filter((state) => !actorId || state.actorId === actorId)
      .map((state) => ({ ...state.operation }));
  }

  function enqueue<T>(operation: HostAccessDesktopOperation): Promise<T> {
    const expiresAt =
      operation.kind === "cancel" || operation.kind === "stop"
        ? null
        : now() + operationTtlMs;
    const operationWithExpiry =
      expiresAt === null ? operation : { ...operation, expiresAt };
    return new Promise<T>((resolve, reject) => {
      const state: OperationState = {
        operation: operationWithExpiry,
        actorId: operation.actorId,
        botId: operation.botId,
        grantId: operation.grantId,
        leasedUntil: null,
        expiresAt,
        expiryTimer: null,
        resolve: resolve as (value: unknown) => void,
        reject,
        settled: false,
      };
      if (expiresAt !== null) {
        state.expiryTimer = setTimeout(() => {
          failOperation(
            state,
            "The native host approval expired before the operation finished.",
          );
        }, operationTtlMs);
        unrefTimer(state.expiryTimer);
      }
      operations.set(operation.operationId, state);
    });
  }

  function requireGrant(input: {
    grantId: string;
    botId: string;
    actorId: string;
  }) {
    const grant = grants.get(input.grantId);
    if (!grant || grant.revoked) {
      throw new HostAccessRefusedError(
        "That folder grant is no longer available.",
      );
    }
    if (grant.botId !== input.botId || grant.actorId !== input.actorId) {
      throw new HostAccessRefusedError(
        "That folder was not granted to this Bot and person.",
      );
    }
    return grant;
  }

  return {
    requestFolderGrant(input: {
      botId: string;
      botName: string;
      actorId: string;
      writable?: boolean;
    }): Promise<HostAccessGrant> {
      expireDesktopLeaseIfNeeded();
      return enqueue<HostAccessGrant>({
        operationId: randomUUID(),
        kind: "choose_folder",
        botId: input.botId,
        botName: input.botName,
        actorId: input.actorId,
        writable: input.writable === true,
      });
    },

    rememberGrant(grant: HostAccessGrant) {
      expireDesktopLeaseIfNeeded();
      grants.set(grant.id, publicGrant(grant));
    },

    callHost(input: {
      kind: "list_files" | "read_file" | "write_file" | "run_command";
      botId: string;
      actorId: string;
      grantId: string;
      relativePath?: string;
      content?: string;
      command?: string;
      writable?: boolean;
    }): Promise<unknown> {
      expireDesktopLeaseIfNeeded();
      try {
        requireGrant({
          grantId: input.grantId,
          botId: input.botId,
          actorId: input.actorId,
        });
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue<unknown>({
        operationId: randomUUID(),
        kind: input.kind,
        botId: input.botId,
        actorId: input.actorId,
        grantId: input.grantId,
        ...(input.relativePath ? { relativePath: input.relativePath } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.writable === true ? { writable: true } : {}),
      });
    },

    nextDesktopOperation(): HostAccessDesktopPollResponse | null {
      expireDesktopLeaseIfNeeded();
      const current = now();
      desktopConnectedUntil = current + desktopLeaseMs;
      scheduleDesktopLeaseExpiry();
      const available = [...operations.values()].find(
        (state) =>
          !state.settled &&
          (state.leasedUntil === null || state.leasedUntil <= current),
      );
      if (!available) return null;
      available.leasedUntil = current + desktopLeaseMs;
      return {
        leaseMs: desktopLeaseMs,
        operations: [{ ...available.operation }],
      };
    },

    resolveDesktopOperation(result: HostAccessDesktopResult) {
      expireDesktopLeaseIfNeeded();
      const state = operations.get(result.operationId);
      if (!state || state.settled) return;
      state.settled = true;
      if (state.expiryTimer) clearTimeout(state.expiryTimer);
      operations.delete(result.operationId);
      if (!result.ok) {
        state.reject(
          new HostAccessRefusedError(
            result.error ?? "The native host operation failed.",
          ),
        );
        return;
      }
      if (state.operation.kind === "choose_folder") {
        if (!result.grant) {
          state.reject(
            new HostAccessRefusedError(
              "The native host did not return a folder grant.",
            ),
          );
          return;
        }
        const grant: HostAccessGrant = {
          id: result.grant.grantId,
          botId: state.botId,
          actorId: state.actorId,
          displayName: result.grant.displayName,
          revoked: false,
        };
        grants.set(grant.id, grant);
        state.resolve(publicGrant(grant));
        return;
      }
      state.resolve(result.result ?? {});
    },

    revokeGrant(grantId: string, actorId: string) {
      expireDesktopLeaseIfNeeded();
      const grant = grants.get(grantId);
      if (!grant || grant.actorId !== actorId) {
        throw new HostAccessRefusedError(
          "That folder grant is not available to revoke.",
        );
      }
      grant.revoked = true;
      const affected = [...operations.values()].filter(
        (state) =>
          state.grantId === grantId && state.operation.kind !== "cancel",
      );
      for (const state of affected) {
        failOperation(
          state,
          "That folder grant was revoked before the operation finished.",
        );
      }
    },

    stop(actorId: string) {
      expireDesktopLeaseIfNeeded();
      for (const grant of grants.values()) {
        if (grant.actorId === actorId) grant.revoked = true;
      }
      const affected = [...operations.values()].filter(
        (state) =>
          state.actorId === actorId && state.operation.kind !== "cancel",
      );
      for (const state of affected) {
        failOperation(state, "Host access was stopped.");
      }
      void enqueue({
        operationId: randomUUID(),
        kind: "stop",
        botId: "*",
        actorId,
      });
    },

    statusFor(actorId: string): HostAccessStatus {
      expireDesktopLeaseIfNeeded();
      return {
        grants: [...grants.values()]
          .filter((grant) => grant.actorId === actorId)
          .map(publicGrant),
        pending: pendingOperations(actorId),
        connected:
          desktopConnectedUntil !== null && desktopConnectedUntil > now(),
      };
    },
  };
}
