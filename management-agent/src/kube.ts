/**
 * The agent reaches the Kubernetes API only through kubectl with its own ServiceAccount, the way
 * the promotion tool does from a laptop, so both run the same commands. Its Roles are namespaced:
 * its own namespace (Flux objects, its state, its Jobs) and the product's (workloads).
 */
import type { KubeRunner } from "../../shared/kubernetes-promotion";

export class CommandFailed extends Error {
  constructor(
    readonly command: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(
      `${command.slice(0, 4).join(" ")} failed (${code ?? "killed"}): ${stderr.trim().slice(0, 600)}`,
    );
  }
}

export async function execute(
  command: readonly string[],
  options: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd ?? "/tmp",
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  if (options.input !== undefined && child.stdin) {
    child.stdin.write(options.input);
    await child.stdin.end();
  }
  const timer = options.timeoutMs
    ? setTimeout(() => child.kill(), options.timeoutMs)
    : undefined;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new CommandFailed(command, code, stderr);
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The shared promotion steps' runner. */
export const run: KubeRunner = (command, options) => execute(command, options);

export class Kube {
  constructor(private readonly exec = execute) {}

  kubectl(
    args: string[],
    options: { input?: string; timeoutMs?: number } = {},
  ) {
    return this.exec(["kubectl", ...args], {
      timeoutMs: options.timeoutMs ?? 60_000,
      input: options.input,
    });
  }

  async get<T>(namespace: string, resource: string, name: string) {
    try {
      return JSON.parse(
        await this.kubectl([
          "--namespace",
          namespace,
          "get",
          resource,
          name,
          "--output",
          "json",
        ]),
      ) as T;
    } catch (error) {
      if (
        error instanceof CommandFailed &&
        /NotFound|not found/.test(error.stderr)
      )
        return null;
      throw error;
    }
  }

  async list<T>(namespace: string, resource: string, selector?: string) {
    const result = JSON.parse(
      await this.kubectl([
        "--namespace",
        namespace,
        "get",
        resource,
        ...(selector ? ["--selector", selector] : []),
        "--output",
        "json",
      ]),
    ) as { items: T[] };
    return result.items;
  }

  patch(namespace: string, resource: string, name: string, patch: unknown) {
    return this.kubectl([
      "--namespace",
      namespace,
      "patch",
      resource,
      name,
      "--type=merge",
      "--patch",
      JSON.stringify(patch),
    ]);
  }

  /** Creates or replaces an object the agent owns, by server-side apply. */
  apply(manifest: unknown) {
    return this.kubectl(
      [
        "apply",
        "--server-side",
        "--force-conflicts",
        "--field-manager=openbot-agent",
        "--filename",
        "-",
      ],
      { input: JSON.stringify(manifest) },
    );
  }

  create(manifestYaml: string) {
    return this.kubectl(["create", "--filename", "-", "--output", "name"], {
      input: manifestYaml,
    });
  }

  /** Sets one or more `key=value` annotations in a single change. */
  annotate(
    namespace: string,
    resource: string,
    name: string,
    ...values: string[]
  ) {
    return this.kubectl([
      "--namespace",
      namespace,
      "annotate",
      "--overwrite",
      resource,
      name,
      ...values,
    ]);
  }
}
