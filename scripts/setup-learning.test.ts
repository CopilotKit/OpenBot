import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { ContainerProbe } from "../server/src/learning/auto-assign";
import { setupLearning } from "./setup-learning";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const key = "cpk-synthetic-setup-key";
const container = (action: string, projectId = "12") => ({
  schemaVersion: 1,
  command: `learning containers ${action}`,
  status: "success",
  projectId,
  container: { id: "openbot", projectId: Number(projectId), name: "OpenBot" },
});
const missing = {
  schemaVersion: 1,
  command: "learning containers get",
  status: "error",
  error: { code: "LEARNING_CONTAINER_NOT_FOUND" },
};

/** `copilotkit project list --json` for a signed-in login, as the CLI prints it. */
const listed = (...slugs: string[]) => ({
  exitCode: 0,
  stdout: JSON.stringify({
    organizationId: "org_synthetic",
    selectedProjectId: null,
    search: null,
    projects: slugs.map((slug, index) => ({
      id: String(12 + index),
      slug,
      name: slug,
      organizationId: "org_synthetic",
      createdAt: "2026-10-01T00:00:00.000Z",
      selected: false,
    })),
  }),
});
/** A machine with no CLI login: the CLI says so on stderr and exits non-zero. */
const signedOut = { exitCode: 1, stdout: "" };
/** `copilotkit whoami` for a login whose active organization is this one. */
const signedInTo = (name: string, clerkOrgId = "org_synthetic") => ({
  exitCode: 0,
  stdout: `Email: person@example.test\nUser ID: user_synthetic\nName: Person\nOrganization: ${name}\nClerk Org ID: ${clerkOrgId}\n`,
});

async function fixture(
  extra = "",
  list: { exitCode: number; stdout: string } = signedOut,
  who: { exitCode: number; stdout: string } = list.exitCode === 0
    ? signedInTo("Team")
    : signedOut,
) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-learning-setup-"));
  directories.push(directory);
  await mkdir(join(directory, ".copilotkit"));
  await writeFile(
    join(directory, ".copilotkit/project.json"),
    JSON.stringify({ projectId: "12", projectSlug: "chosen" }),
  );
  const envPath = join(directory, ".env");
  await writeFile(
    envPath,
    `INTELLIGENCE_API_URL=https://api.intelligence.copilotkit.ai\nINTELLIGENCE_API_KEY=\n# Keep my other configuration\nOPENAI_API_KEY=synthetic-model\n${extra}`,
  );
  const calls: string[][] = [];
  const directoriesUsed: string[] = [];
  const runCli = async (args: string[], cwd: string) => {
    calls.push(args);
    directoriesUsed.push(cwd);
    if (args[0] === "project" && args[1] === "list") return list;
    if (args[0] === "whoami") return who;
    if (args[0] === "project") {
      await writeFile(
        envPath,
        `${await readFile(envPath, "utf8")}\nCPK_INTELLIGENCE_API_KEY=${key}\n`,
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "completed",
          project: { id: "12" },
          api_key_provisioned: true,
          environment_file_written: true,
        }),
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(args[2] === "get" ? missing : container("create")),
    };
  };
  return {
    directory,
    envPath,
    calls,
    directoriesUsed,
    runCli,
    options: { directory, environment: {} },
  };
}

test("fresh managed setup creates and verifies the selected project's container before configuring OpenBot", async () => {
  const f = await fixture();
  expect(await setupLearning({ ...f.options, runCli: f.runCli })).toBe(
    "configured",
  );
  expect(f.calls).toEqual([
    ["project", "select", "--project", "12", "--json"],
    ["learning", "containers", "get", "openbot", "--json"],
    [
      "learning",
      "containers",
      "create",
      "--id",
      "openbot",
      "--name",
      "OpenBot",
      "--json",
    ],
  ]);
  const content = await readFile(f.envPath, "utf8");
  expect(content).toContain("# Keep my other configuration");
  expect(parseEnv(content)).toMatchObject({
    CPK_INTELLIGENCE_API_KEY: key,
    INTELLIGENCE_API_KEY: "",
    CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "openbot",
    OPENAI_API_KEY: "synthetic-model",
  });
  const saved = content;
  expect(await setupLearning({ ...f.options, runCli: f.runCli })).toBe(
    "preserved",
  );
  expect(await readFile(f.envPath, "utf8")).toBe(saved);
  expect(f.calls).toHaveLength(3);
});

test("reuses an existing verified container without creating or editing it", async () => {
  const f = await fixture();
  await setupLearning({
    ...f.options,
    runCli: async (args) =>
      args[0] === "project"
        ? f.runCli(args)
        : { exitCode: 0, stdout: JSON.stringify(container("get")) },
  });
  expect(
    parseEnv(await readFile(f.envPath, "utf8"))
      .CPK_INTELLIGENCE_LEARNING_CONTAINER_ID,
  ).toBe("openbot");
  expect(f.calls).toHaveLength(1);
});

test("custom configured targets are preserved before any CLI operation", async () => {
  const f = await fixture(
    "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=custom-work\n",
  );
  const before = await readFile(f.envPath, "utf8");
  expect(await setupLearning({ ...f.options, runCli: f.runCli })).toBe(
    "preserved",
  );
  expect(await readFile(f.envPath, "utf8")).toBe(before);
  expect(f.calls).toHaveLength(0);
});

/** The configured key's view of its own project: whether openbot is there, and which project. */
function keyView(
  answers: ContainerProbe[],
  projectSlug: string | null = "chosen",
) {
  const probes: string[] = [];
  const keys: string[] = [];
  const keyIntelligence = (_apiUrl: string, apiKey: string) => {
    keys.push(apiKey);
    return {
      probe: async (containerId: string) => {
        probes.push(containerId);
        return answers.shift() ?? "absent";
      },
      project: async () =>
        projectSlug === null
          ? undefined
          : {
              organizationSlug: "team",
              projectSlug,
              organizationName: "Team",
              projectName: projectSlug,
            },
    };
  };
  return { probes, keys, keyIntelligence };
}

test("an existing key whose project has openbot is left to the server to assign", async () => {
  const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
  const before = await readFile(f.envPath, "utf8");
  const key = keyView(["present"]);
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: key.keyIntelligence,
    }),
  ).toBe("present");
  expect(key.keys).toEqual(["cpk-manual-key"]);
  expect(key.probes).toEqual(["openbot"]);
  expect(await readFile(f.envPath, "utf8")).toBe(before);
  expect(f.calls).toHaveLength(0);
});

test("an existing key without openbot gets it created in the key's own project, never a new key", async () => {
  const f = await fixture(
    "INTELLIGENCE_API_KEY=cpk-manual-key\n",
    listed("chosen"),
  );
  const before = await readFile(f.envPath, "utf8");
  const key = keyView(["absent", "present"]);
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: key.keyIntelligence,
    }),
  ).toBe("created");
  // The login's organization and project are confirmed as the key's before anything is written.
  expect(f.calls).toEqual([
    ["project", "list", "--json"],
    ["whoami"],
    ["learning", "containers", "get", "openbot", "--json"],
    [
      "learning",
      "containers",
      "create",
      "--id",
      "openbot",
      "--name",
      "OpenBot",
      "--json",
    ],
  ]);
  // Proved by the key itself after creation, and nothing in .env changes.
  expect(key.probes).toEqual(["openbot", "openbot"]);
  expect(await readFile(f.envPath, "utf8")).toBe(before);
});

test("exported runtime keys are used the same way and never trigger project selection", async () => {
  const f = await fixture("", listed("chosen"));
  const key = keyView(["absent", "present"]);
  expect(
    await setupLearning({
      ...f.options,
      environment: { INTELLIGENCE_API_KEY: "cpk-exported-key" },
      runCli: f.runCli,
      keyIntelligence: key.keyIntelligence,
    }),
  ).toBe("created");
  expect(key.keys).toEqual(["cpk-exported-key"]);
  expect(
    f.calls.some((args) => args[0] === "project" && args[1] === "select"),
  ).toBe(false);
});

test("a CLI project that is not the key's project creates nothing", async () => {
  for (const slug of ["someone-else", null]) {
    const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
    await expect(
      setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: keyView(["absent"], slug).keyIntelligence,
      }),
    ).rejects.toThrow("could not be confirmed");
    expect(f.calls).toHaveLength(0);
  }
});

test("a CLI login with no project selected creates the container in the key's project, on its own", async () => {
  const f = await fixture(
    "INTELLIGENCE_API_KEY=cpk-manual-key\n",
    listed("chosen", "someone-else"),
  );
  await rm(join(f.directory, ".copilotkit"), { recursive: true });
  const before = await readFile(f.envPath, "utf8");
  const key = keyView(["absent", "present"]);
  // What scripts/start.sh runs: no person, no prompt.
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: key.keyIntelligence,
      nonInteractive: true,
    }),
  ).toBe("created");
  expect(f.calls).toEqual([
    ["project", "list", "--json"],
    ["whoami"],
    ["learning", "containers", "get", "openbot", "--json"],
    [
      "learning",
      "containers",
      "create",
      "--id",
      "openbot",
      "--name",
      "OpenBot",
      "--json",
    ],
  ]);
  // From a scratch directory that is gone afterwards: this checkout's selection is never made.
  const [scratch] = new Set(f.directoriesUsed);
  expect(new Set(f.directoriesUsed).size).toBe(1);
  expect(scratch).not.toBe(f.directory);
  expect(
    await readFile(
      join(scratch as string, ".copilotkit/project.json"),
      "utf8",
    ).catch(() => null),
  ).toBeNull();
  expect(
    await readFile(join(f.directory, ".copilotkit/project.json"), "utf8").catch(
      () => null,
    ),
  ).toBeNull();
  expect(await readFile(f.envPath, "utf8")).toBe(before);
  expect(key.probes).toEqual(["openbot", "openbot"]);
});

test("a CLI login that cannot see the key's project creates nothing", async () => {
  for (const list of [listed("someone-else"), listed()]) {
    const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n", list);
    await rm(join(f.directory, ".copilotkit"), { recursive: true });
    await expect(
      setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: keyView(["absent"]).keyIntelligence,
        nonInteractive: true,
      }),
    ).rejects.toThrow("could be confirmed");
    expect(f.calls).toEqual([["project", "list", "--json"], ["whoami"]]);
  }
});

// The CLI lists only its active organization's projects and names that organization, never by slug,
// so a login sitting in another organization with a same-slug project must be caught before writing.
test("a CLI login in another organization creates nothing, whatever its projects are called", async () => {
  const cases = [
    { why: "another organization", who: signedInTo("Elsewhere") },
    {
      why: "whoami and the list disagree",
      who: signedInTo("Team", "org_other"),
    },
    {
      why: "no organization in whoami",
      who: { exitCode: 0, stdout: "Email: person@example.test\n" },
    },
    { why: "whoami fails", who: signedOut },
  ];
  for (const { who } of cases) {
    for (const selected of [false, true]) {
      const f = await fixture(
        "INTELLIGENCE_API_KEY=cpk-manual-key\n",
        listed("chosen"),
        who,
      );
      if (!selected)
        await rm(join(f.directory, ".copilotkit"), { recursive: true });
      await expect(
        setupLearning({
          ...f.options,
          runCli: f.runCli,
          keyIntelligence: keyView(["absent"]).keyIntelligence,
          nonInteractive: true,
        }),
      ).rejects.toThrow("confirmed");
      expect(f.calls.some((args) => args[0] === "learning")).toBe(false);
    }
  }
});

test("a same-slug project with another name, or a selection outside the login's organization, creates nothing", async () => {
  // Same slug, different name: not the key's project.
  const renamed = {
    exitCode: 0,
    stdout: JSON.stringify({
      organizationId: "org_synthetic",
      projects: [
        {
          id: "12",
          slug: "chosen",
          name: "Somebody else's",
          organizationId: "org_synthetic",
        },
      ],
    }),
  };
  // The selected project (id 12) is not among the login's organization's projects.
  const elsewhere = {
    exitCode: 0,
    stdout: JSON.stringify({
      organizationId: "org_synthetic",
      projects: [
        {
          id: "77",
          slug: "chosen",
          name: "chosen",
          organizationId: "org_synthetic",
        },
      ],
    }),
  };
  for (const list of [renamed, elsewhere]) {
    const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n", list);
    await expect(
      setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: keyView(["absent"]).keyIntelligence,
      }),
    ).rejects.toThrow("could not be confirmed");
    expect(f.calls.some((args) => args[0] === "learning")).toBe(false);
  }
});

test("a container the key still cannot see after creation is reported, not assigned", async () => {
  const f = await fixture(
    "INTELLIGENCE_API_KEY=cpk-manual-key\n",
    listed("chosen"),
  );
  await expect(
    setupLearning({
      ...f.options,
      runCli: f.runCli,
      keyIntelligence: keyView(["absent", "absent"]).keyIntelligence,
    }),
  ).rejects.toThrow("another project");
  expect(f.calls).toHaveLength(4);
});

test("plan and connection failures create nothing", async () => {
  for (const [answer, message] of [
    ["not_entitled", "does not include Learning"],
    ["unavailable", "could not be asked"],
  ] as const) {
    const f = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
    await expect(
      setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: keyView([answer]).keyIntelligence,
      }),
    ).rejects.toThrow(message);
    expect(f.calls).toHaveLength(0);
  }
});

test("non-interactive runs never sign in, prompt or provision a key", async () => {
  // No key: fresh setup would provision one, which is for a person to run.
  const fresh = await fixture();
  const before = await readFile(fresh.envPath, "utf8");
  expect(
    await setupLearning({
      ...fresh.options,
      runCli: fresh.runCli,
      nonInteractive: true,
    }),
  ).toBe("skipped");
  expect(fresh.calls).toHaveLength(0);
  expect(await readFile(fresh.envPath, "utf8")).toBe(before);

  // A key, no CLI project selected here, and no CLI login: asked once, nothing to create with.
  const unselected = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
  await rm(join(unselected.directory, ".copilotkit"), { recursive: true });
  expect(
    await setupLearning({
      ...unselected.options,
      runCli: unselected.runCli,
      keyIntelligence: keyView(["absent"]).keyIntelligence,
      nonInteractive: true,
    }),
  ).toBe("skipped");
  expect(unselected.calls).toEqual([["project", "list", "--json"]]);
  // With no login on the machine at all, the CLI is not even downloaded.
  const noLogin = await fixture("INTELLIGENCE_API_KEY=cpk-manual-key\n");
  await rm(join(noLogin.directory, ".copilotkit"), { recursive: true });
  expect(
    await setupLearning({
      ...noLogin.options,
      runCli: noLogin.runCli,
      keyIntelligence: keyView(["absent"]).keyIntelligence,
      nonInteractive: true,
      cliLogin: false,
    }),
  ).toBe("skipped");
  expect(noLogin.calls).toHaveLength(0);
  // Interactively, the same state explains what to do.
  await expect(
    setupLearning({
      ...unselected.options,
      runCli: unselected.runCli,
      keyIntelligence: keyView(["absent"]).keyIntelligence,
    }),
  ).rejects.toThrow('ID "openbot"');

  // Self-hosted creation needs a browser sign-in.
  const selfHosted = await fixture(
    "INTELLIGENCE_API_URL=https://customer.example\nINTELLIGENCE_API_KEY=cpk-manual-key\n",
  );
  let signIns = 0;
  expect(
    await setupLearning({
      ...selfHosted.options,
      keyIntelligence: keyView(["absent"]).keyIntelligence,
      setupSelfHosted: async () => {
        signIns++;
        throw new Error("No browser in a start script");
      },
      nonInteractive: true,
    }),
  ).toBe("skipped");
  expect(signIns).toBe(0);
});

test("self-hosted keys gain the container through sign-in and keep their key", async () => {
  const f = await fixture(
    "INTELLIGENCE_API_URL=https://customer.example\nINTELLIGENCE_API_KEY=cpk-manual-key\n",
  );
  const before = await readFile(f.envPath, "utf8");
  const seen: (string | undefined)[] = [];
  expect(
    await setupLearning({
      ...f.options,
      keyIntelligence: keyView(["absent", "present"]).keyIntelligence,
      setupSelfHosted: async (apiUrl, existingKey) => {
        seen.push(existingKey);
        return {
          apiUrl,
          apiKey: existingKey ?? "cpk-minted",
          learningContainerId: "openbot",
        };
      },
    }),
  ).toBe("created");
  expect(seen).toEqual(["cpk-manual-key"]);
  expect(await readFile(f.envPath, "utf8")).toBe(before);
});

test("fresh self-hosted endpoints use browser setup and save its verified connection", async () => {
  const f = await fixture("INTELLIGENCE_API_URL=https://customer.example\n");
  expect(
    await setupLearning({
      ...f.options,
      runCli: f.runCli,
      setupSelfHosted: async (apiUrl) => ({
        apiUrl,
        apiKey: key,
        learningContainerId: "openbot",
      }),
    }),
  ).toBe("configured");
  expect(parseEnv(await readFile(f.envPath, "utf8"))).toMatchObject({
    INTELLIGENCE_API_URL: "https://customer.example",
    INTELLIGENCE_API_KEY: key,
    CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "openbot",
  });
  expect(f.calls).toHaveLength(0);
});

test("self-hosted setup failure or concurrent env edits do not save credentials", async () => {
  const f = await fixture("INTELLIGENCE_API_URL=https://customer.example\n");
  const original = await readFile(f.envPath, "utf8");
  await expect(
    setupLearning({
      ...f.options,
      setupSelfHosted: async () => {
        throw new Error("Sign-in cancelled");
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(await readFile(f.envPath, "utf8")).toBe(original);
  await expect(
    setupLearning({
      ...f.options,
      setupSelfHosted: async (apiUrl) => {
        await writeFile(f.envPath, `${original}\n# Operator edit\n`);
        return { apiUrl, apiKey: key, learningContainerId: "openbot" };
      },
    }),
  ).rejects.toThrow("configuration changed");
  expect(parseEnv(await readFile(f.envPath, "utf8")).INTELLIGENCE_API_KEY).toBe(
    "",
  );
});

test.each(["", "INTELLIGENCE_API_KEY=cpk-old-project-key\n"])(
  "a CLI key is used without reprovisioning or rewriting configuration: %s",
  async (legacy) => {
    const f = await fixture(`${legacy}CPK_INTELLIGENCE_API_KEY=cpk-cli-key\n`);
    const before = await readFile(f.envPath, "utf8");
    const view = keyView(["present"]);
    expect(
      await setupLearning({
        ...f.options,
        runCli: f.runCli,
        keyIntelligence: view.keyIntelligence,
      }),
    ).toBe("present");
    expect(view.keys).toEqual(["cpk-cli-key"]);
    expect(f.calls).toHaveLength(0);
    expect(await readFile(f.envPath, "utf8")).toBe(before);
  },
);

test("a partial key provision does not create a container", async () => {
  const f = await fixture();
  const before = await readFile(f.envPath, "utf8");
  await expect(
    setupLearning({
      ...f.options,
      runCli: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          type: "partial",
          project: { id: "12" },
          api_key_provisioned: false,
        }),
      }),
    }),
  ).rejects.toThrow("did not finish provisioning");
  expect(await readFile(f.envPath, "utf8")).toBe(before);
});

test("wrong-project or failed container results leave OpenBot unassigned", async () => {
  for (const response of [
    container("create", "99"),
    { status: "error", error: { code: "FORBIDDEN" } },
  ]) {
    const f = await fixture();
    await expect(
      setupLearning({
        ...f.options,
        runCli: async (args) =>
          args[2] === "create"
            ? { exitCode: 0, stdout: JSON.stringify(response) }
            : f.runCli(args),
      }),
    ).rejects.toThrow("could not be verified");
    const values = parseEnv(await readFile(f.envPath, "utf8"));
    expect(values.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID).toBeUndefined();
    expect(values.INTELLIGENCE_API_KEY).toBe("");
  }
});

test("read authorization errors do not trigger container creation", async () => {
  const f = await fixture();
  const calls: string[][] = [];
  await expect(
    setupLearning({
      ...f.options,
      runCli: async (args) => {
        calls.push(args);
        return args[0] === "project"
          ? f.runCli(args)
          : {
              exitCode: 1,
              stdout: JSON.stringify({
                schemaVersion: 1,
                command: "learning containers get",
                status: "error",
                error: { code: "FORBIDDEN" },
              }),
            };
      },
    }),
  ).rejects.toThrow("could not be verified");
  expect(calls).toHaveLength(2);
});
