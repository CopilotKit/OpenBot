/**
 * Backups and support bundles run as Jobs the chart defines: the customer reads exactly what runs,
 * under which identity (the cloud's workload identity for a backup), and where its output goes.
 * The agent fills in the operation's id and waits for the verdict.
 */
import { parseAllDocuments } from "yaml";
import type { Kube } from "./kube";

interface Job {
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: { type: string; status: string; message?: string }[];
  };
}

/** A short lowercase id that keeps Job names within Kubernetes' limits. */
export function operationId(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(2, 14);
  return `${stamp}-${crypto.randomUUID().slice(0, 6)}`;
}

export function fillJob(template: string, operation: string) {
  if (!/^[a-z0-9-]{1,40}$/.test(operation))
    throw new Error("Operation ids are short, lowercase and dashed");
  const filled = template.replaceAll("__OPERATION__", operation);
  const documents = parseAllDocuments(filled).map((document) =>
    document.toJSON(),
  );
  const jobs = documents.filter(Boolean);
  if (jobs.length !== 1 || jobs[0]?.kind !== "Job")
    throw new Error("A job template must hold exactly one Job");
  const name = jobs[0].metadata?.name as string | undefined;
  const namespace = jobs[0].metadata?.namespace as string | undefined;
  if (!name?.includes(operation) || !namespace)
    throw new Error(
      "A job template must name its namespace and carry the operation id in its name",
    );
  return { manifest: filled, name, namespace };
}

/** Starts the Job and resolves when it succeeds; rejects when it fails or runs out of time. */
export async function runJob(
  kube: Kube,
  template: string,
  operation: string,
  timeoutSeconds: number,
) {
  const job = fillJob(template, operation);
  await kube.create(job.manifest);
  const deadline = Date.now() + (timeoutSeconds + 60) * 1000;
  while (Date.now() < deadline) {
    const status = (await kube.get<Job>(job.namespace, "job", job.name))
      ?.status;
    if ((status?.succeeded ?? 0) > 0) return job;
    const failed = status?.conditions?.find(
      (condition) => condition.type === "Failed" && condition.status === "True",
    );
    if (failed || (status?.failed ?? 0) > 0)
      throw new Error(
        `Job ${job.name} failed${failed?.message ? `: ${failed.message}` : ""}`,
      );
    await Bun.sleep(5_000);
  }
  throw new Error(`Job ${job.name} did not finish in time`);
}
