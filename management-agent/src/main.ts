#!/usr/bin/env bun
/** The agent's entry point in its container. */
import { ManagementAgent } from "./agent";
import { ManagementClient } from "./client";
import { loadAgent } from "./config";
import { Kube } from "./kube";

const agent = loadAgent();
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    // A promotion cut off here leaves its journal unfinished, which blocks further upgrades until a
    // person looks: the same as any other interruption.
    controller.abort();
    process.exit(0);
  });

const management = new ManagementAgent(
  agent,
  new Kube(),
  new ManagementClient(agent.config.managementUrl, agent.credentials),
);
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    message: "openbot management agent started",
    installId: agent.config.installId,
    managementUrl: agent.config.managementUrl,
    product: agent.config.product,
  }),
);
await management.loop(controller.signal);
