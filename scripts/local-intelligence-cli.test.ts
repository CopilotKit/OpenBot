import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localCliEntrypoint,
  runLocalIntelligenceCli,
} from "./local-intelligence-cli";

async function fixture(
  run: (
    root: string,
    install: (path: string, version?: string, code?: string) => Promise<string>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "openbot-cli-discovery-"));
  try {
    await run(
      root,
      async (
        path,
        version = "4.99.0",
        code = 'console.log(JSON.stringify({status:"completed",stacks:[],args:process.argv.slice(2),secret:process.env.INTELLIGENCE_API_KEY ?? null}));',
      ) => {
        await mkdir(path, { recursive: true });
        await writeFile(
          join(path, "package.json"),
          JSON.stringify({
            name: "copilotkit",
            version,
            bin: { copilotkit: "index.js" },
          }),
        );
        const entry = join(path, "index.js");
        await writeFile(entry, code);
        return entry;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const minimalPath = "/usr/bin:/bin:/usr/sbin:/sbin";

test("minimal-PATH child uses an existing npm cache offline without exposing credentials", async () => {
  await fixture(async (root, install) => {
    await install(join(root, ".npm/_npx/cache/node_modules/copilotkit"));
    const environment = {
      PATH: minimalPath,
      HOME: root,
      npm_config_registry: "http://127.0.0.1:1",
      INTELLIGENCE_API_KEY: "private-value",
    };
    const result = await runLocalIntelligenceCli(
      ["local", "list", "--json"],
      root,
      { home: root, globalRoots: [], environment },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "completed",
      stacks: [],
      args: ["local", "list", "--json"],
      secret: null,
    });
  });
});

test("newest available CLI wins even when an older version is installed", async () => {
  await fixture(async (root, install) => {
    await install(join(root, ".npm/_npx/z/node_modules/copilotkit"), "4.9.0");
    await install(
      join(root, ".npm/_npx/pre/node_modules/copilotkit"),
      "4.10.0-beta.1",
    );
    await install(
      join(root, ".npm/_npx/broken/node_modules/copilotkit"),
      "invalid-version",
    );
    const latest = await install(
      join(root, ".npm/_npx/a/node_modules/copilotkit"),
      "4.10.0",
    );
    expect(
      await localCliEntrypoint(root, { PATH: minimalPath }, root, []),
    ).toBe(latest);
    await install(join(root, "node_modules/copilotkit"), "4.8.0");
    expect(
      await localCliEntrypoint(root, { PATH: minimalPath }, root, []),
    ).toBe(latest);
  });
});

test("missing and malformed cache entries are unavailable without a registry invocation", async () => {
  await fixture(async (root) => {
    const cache = join(root, ".npm/_npx/partial/node_modules/copilotkit");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "package.json"), "not json");
    expect(
      await runLocalIntelligenceCli([], root, {
        home: root,
        globalRoots: [],
        environment: { PATH: minimalPath },
      }),
    ).toEqual({ exitCode: 127, stdout: "" });
  });
});

test("runtime failure is retained and stderr is not returned", async () => {
  await fixture(async (root, install) => {
    await install(
      join(root, "node_modules/copilotkit"),
      "4.0.0",
      'console.error("private diagnostic"); process.exit(2);',
    );
    expect(
      await runLocalIntelligenceCli([], root, {
        home: root,
        globalRoots: [],
        environment: { PATH: minimalPath },
      }),
    ).toEqual({ exitCode: 2, stdout: "" });
  });
});

test("cancellation terminates discovery and timeout is a runtime failure", async () => {
  await fixture(async (root, install) => {
    await install(
      join(root, "node_modules/copilotkit"),
      "4.0.0",
      "setInterval(() => {}, 1000);",
    );
    const controller = new AbortController();
    const pending = runLocalIntelligenceCli([], root, {
      home: root,
      globalRoots: [],
      environment: { PATH: minimalPath },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("cancelled")), 50);
    await expect(pending).rejects.toThrow("cancelled");
    expect(
      (
        await runLocalIntelligenceCli([], root, {
          home: root,
          globalRoots: [],
          environment: { PATH: minimalPath },
          timeoutMs: 50,
        })
      ).exitCode,
    ).toBe(1);
  });
});

test.each(["4.11.0", "4.10.0"])(
  "installed CLI wins against cached 4.10.0 when its version is %s",
  async (version) => {
    await fixture(async (root, install) => {
      await install(
        join(root, ".npm/_npx/cache/node_modules/copilotkit"),
        "4.10.0",
      );
      const installed = await install(
        join(root, "node_modules/copilotkit"),
        version,
      );
      expect(
        await localCliEntrypoint(root, { PATH: minimalPath }, root, []),
      ).toBe(installed);
    });
  },
);

test("equal cached versions use a deterministic path tie-breaker", async () => {
  await fixture(async (root, install) => {
    await install(join(root, ".npm/_npx/z/node_modules/copilotkit"), "4.10.0");
    const first = await install(
      join(root, ".npm/_npx/a/node_modules/copilotkit"),
      "4.10.0",
    );
    expect(
      await localCliEntrypoint(root, { PATH: minimalPath }, root, []),
    ).toBe(first);
  });
});

test.each([true, false])(
  "Windows default npm cache uses local app data (configured: %s)",
  async (configured) => {
    await fixture(async (root, install) => {
      const local = configured
        ? join(root, "custom-local")
        : join(root, "AppData/Local");
      const expected = await install(
        join(local, "npm-cache/_npx/cache/node_modules/copilotkit"),
      );
      await install(
        join(root, ".npm/_npx/wrong/node_modules/copilotkit"),
        "99.0.0",
      );
      expect(
        await localCliEntrypoint(
          root,
          { PATH: minimalPath, ...(configured ? { LOCALAPPDATA: local } : {}) },
          root,
          [],
          "win32",
        ),
      ).toBe(expected);
    });
  },
);

test.each(["npm_config_cache", "NPM_CONFIG_CACHE"])(
  "Windows respects explicit %s cache override",
  async (key) => {
    await fixture(async (root, install) => {
      const explicit = join(root, "override");
      const expected = await install(
        join(explicit, "_npx/cache/node_modules/copilotkit"),
      );
      await install(
        join(
          root,
          "AppData/Local/npm-cache/_npx/default/node_modules/copilotkit",
        ),
        "99.0.0",
      );
      expect(
        await localCliEntrypoint(
          root,
          {
            PATH: minimalPath,
            NPM_CONFIG_CACHE: join(root, "unused"),
            [key]: explicit,
          },
          root,
          [],
          "win32",
        ),
      ).toBe(expected);
    });
  },
);

test("a stale global installation cannot shadow a newer cached CLI", async () => {
  await fixture(async (root, install) => {
    const globalRoot = join(root, "global/copilotkit");
    await install(globalRoot, "4.8.0");
    const cached = await install(
      join(root, ".npm/_npx/cache/node_modules/copilotkit"),
      "4.10.0",
    );
    expect(
      await localCliEntrypoint(root, { PATH: minimalPath }, root, [globalRoot]),
    ).toBe(cached);
  });
});

test("newest installed CLI wins across local and global installations", async () => {
  await fixture(async (root, install) => {
    await install(join(root, "node_modules/copilotkit"), "4.8.0");
    const globalRoot = join(root, "global/copilotkit");
    const global = await install(globalRoot, "4.11.0");
    expect(
      await localCliEntrypoint(root, { PATH: minimalPath }, root, [globalRoot]),
    ).toBe(global);
  });
});
