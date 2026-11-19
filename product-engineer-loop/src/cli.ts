#!/usr/bin/env node
/**
 * Product Engineer delivery loop CLI.
 *
 *   pe-loop start DES-123 [--repo url ...]
 *   pe-loop resume DES-123 --feedback "..." | --feedback-file path
 *   pe-loop status DES-123
 *   pe-loop approve DES-123
 *
 * This package is the coding factory. PlugiQ AgentForce remains the employee
 * UI / governance surface and does not execute this loop inside OpenBot.
 */
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { fetchLinearIssue } from "./linear.js";
import { loadRun } from "./store.js";
import { markApproved, resumeWithFeedback, startImplement } from "./agent.js";

function usage(): never {
  console.error(`Usage:
  pe-loop start <LINEAR_ID> [--repo <github-url>]...
  pe-loop resume <LINEAR_ID> --feedback <text>
  pe-loop resume <LINEAR_ID> --feedback-file <path>
  pe-loop status <LINEAR_ID>
  pe-loop approve <LINEAR_ID>

Environment: see .env.example (CURSOR_API_KEY, LINEAR_API_KEY, PE_REPOS).`);
  process.exit(2);
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  args.splice(i, 2);
  return value;
}

function takeAllFlags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeFlag(args, name);
    if (!value) break;
    values.push(value);
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command) usage();

  if (command === "start") {
    const ticketId = args.shift();
    if (!ticketId || ticketId.startsWith("--")) usage();
    const repos = takeAllFlags(args, "--repo");
    if (args.length) usage();

    const config = loadConfig(repos.length ? { repos } : undefined);
    console.log(`Fetching Linear ${ticketId}…`);
    const issue = await fetchLinearIssue(config.linearApiKey, ticketId);
    console.log(`Issue: ${issue.identifier} — ${issue.title} (${issue.state})`);

    const existing = await loadRun(config.runsDir, issue.identifier);
    if (
      existing &&
      existing.status !== "failed" &&
      existing.status !== "approved"
    ) {
      console.error(
        `A run already exists for ${issue.identifier} (status=${existing.status}, agentId=${existing.agentId}).`,
      );
      console.error(
        `Use: pe-loop resume ${issue.identifier} --feedback "…"   or pe-loop status ${issue.identifier}`,
      );
      process.exit(1);
    }

    console.log(
      `Starting Product Engineer on: ${config.repos.map((r) => r.url).join(", ")}`,
    );
    const run = await startImplement(config, issue);
    printRun(run);
    console.log(
      "\nNext: review the PR, then either:\n" +
        `  pe-loop resume ${run.ticketId} --feedback "…"\n` +
        `  pe-loop approve ${run.ticketId}`,
    );
    return;
  }

  if (command === "resume") {
    const ticketId = args.shift();
    if (!ticketId || ticketId.startsWith("--")) usage();
    const feedbackInline = takeFlag(args, "--feedback");
    const feedbackFile = takeFlag(args, "--feedback-file");
    if (args.length) usage();
    if (!feedbackInline && !feedbackFile) {
      console.error("resume requires --feedback or --feedback-file");
      process.exit(2);
    }
    const feedback =
      feedbackInline ?? (await readFile(feedbackFile as string, "utf8"));

    const config = loadConfig();
    const existing = await loadRun(config.runsDir, ticketId);
    if (!existing) {
      throw new Error(
        `No run state for ${ticketId}. Start first: pe-loop start ${ticketId}`,
      );
    }
    if (existing.status === "approved") {
      throw new Error(
        `${ticketId} is already approved. Start a new ticket or clear .runs/${ticketId.toUpperCase()}.json`,
      );
    }

    const run = await resumeWithFeedback(config, existing, feedback);
    printRun(run);
    return;
  }

  if (command === "status") {
    const ticketId = args.shift();
    if (!ticketId || args.length) usage();
    const config = loadConfig();
    const existing = await loadRun(config.runsDir, ticketId);
    if (!existing) {
      console.log(`No run for ${ticketId}`);
      process.exit(1);
    }
    printRun(existing);
    return;
  }

  if (command === "approve") {
    const ticketId = args.shift();
    if (!ticketId || args.length) usage();
    const config = loadConfig();
    const existing = await loadRun(config.runsDir, ticketId);
    if (!existing) {
      throw new Error(`No run for ${ticketId}`);
    }
    const run = await markApproved(config, existing);
    printRun(run);
    console.log(
      "\nHuman certified. Merge the PR yourself in GitHub — this loop never merges.",
    );
    return;
  }

  usage();
}

function printRun(run: {
  ticketId: string;
  title: string;
  status: string;
  agentId: string;
  lastRunId: string | null;
  prUrl: string | null;
  linearUrl: string;
  repos: string[];
}): void {
  console.log(
    JSON.stringify(
      {
        ticketId: run.ticketId,
        title: run.title,
        status: run.status,
        agentId: run.agentId,
        lastRunId: run.lastRunId,
        prUrl: run.prUrl,
        linearUrl: run.linearUrl,
        repos: run.repos,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
