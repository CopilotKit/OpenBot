import { createDriver } from "./drivers/create-driver";
import { consoleRunLogger } from "./observability/run-logger";
import { BoundedRunQueue, HostSemaphore } from "./runs/queue";
import { RunService } from "./runs/run-service";
import { serveGateway } from "./server";
import { RunStore } from "./storage/run-store";
import { WorkspaceManager } from "./workspaces/workspace-manager";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

const provider = required("PROVIDER");
const runStorePath = required("RUN_STORE_PATH");
const hostSemaphorePath = required("HOST_SEMAPHORE_PATH");
const store = new RunStore(runStorePath);
const leaseStore =
  hostSemaphorePath === runStorePath ? store : new RunStore(hostSemaphorePath);
const driver = createDriver(provider);
const host = new HostSemaphore({
  limit: positiveInteger("HOST_CONCURRENCY", 1),
  leaseStore,
});
const queue = new BoundedRunQueue({
  provider,
  host,
  concurrency: positiveInteger("PROVIDER_CONCURRENCY", 1),
  pendingLimit: nonNegativeInteger("QUEUE_CAPACITY", 1),
});
const workspaces = new WorkspaceManager({
  provider,
  repository: required("REPOSITORY_URL"),
  baseBranch: required("BASE_BRANCH"),
  jobRoot: required("JOB_ROOT"),
});
const runService = new RunService({
  driver,
  store,
  queue,
  workspaces,
  logger: consoleRunLogger,
});
const server = serveGateway({
  port: positiveInteger("PORT", 4210),
  token: required("GATEWAY_TOKEN"),
  driver,
  runService,
});

function stop(): void {
  server.stop(true);
  store.close();
  if (leaseStore !== store) leaseStore.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
