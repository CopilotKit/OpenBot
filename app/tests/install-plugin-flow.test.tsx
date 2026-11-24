import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { InstallPluginDialog } from "@/components/skills/install-plugin";
import {
  MCP_SCHEMA_1_0_0,
  PLUGIN_SCHEMA_1_0_0,
} from "@/lib/agent-plugins/read";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { SKILLS_PATH, skillBody, type TodaySkill } from "./skills-api";

/**
 * The panel end to end, from a picked folder to the rows saying how each part came out, against a
 * server stood in at `fetch`. Its one job here: the review a person pressed Install on is the one
 * they read afterwards, even though the skill list refetches as each skill is saved and then holds
 * the plugin's own skills.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const ORGANIZATION = "/api/v2/organizations/default";

function server() {
  const skills: TodaySkill[] = [{ slug: "standup", ownerUserId: "me" }];
  const calls: string[] = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path === SKILLS_PATH && method === "GET")
        return json({ skills: skills.map(skillBody), nextCursor: null });
      if (path.startsWith(`${SKILLS_PATH}/`) && method === "PUT") {
        const body = JSON.parse(String(init?.body));
        const skill = {
          slug: decodeURIComponent(path.slice(SKILLS_PATH.length + 1)),
          ...body,
          ownerUserId: "me",
        };
        skills.push(skill);
        return json(skillBody(skill));
      }
      if (path === `${ORGANIZATION}/apps` && method === "POST")
        return json(
          {
            id: "tracker",
            signIn: false,
            tools: [{ name: "list_issues", ref: "tracker/list_issues" }],
          },
          201,
        );
      return json({ detail: "Not found." }, 404);
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
}

function file(path: string, text: string): File {
  const made = new File([text], path.split("/").pop() ?? path);
  Object.defineProperty(made, "webkitRelativePath", { value: path });
  return made;
}

test("after Install, the plugin's own new skills read as saved, not as already yours", async () => {
  const calls = server();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "me",
    name: "Maya",
    email: "maya@example.test",
    role: "admin",
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <InstallPluginDialog onClose={() => undefined} open />,
    }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  // Nothing to install until a plugin has been read.
  const before = (await view.findByRole("button", {
    name: "Install",
  })) as HTMLButtonElement;
  expect(before.disabled).toBe(true);

  const input = (await view.findByLabelText(
    "Plugin folder",
  )) as HTMLInputElement;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [
      file(
        "reports/plugin.json",
        JSON.stringify({ $schema: PLUGIN_SCHEMA_1_0_0, name: "reports" }),
      ),
      file(
        "reports/skills/weekly/SKILL.md",
        "---\nname: weekly\ndescription: Write the weekly report.\n---\nRead the closed issues.",
      ),
      file(
        "reports/mcp.json",
        JSON.stringify({
          $schema: MCP_SCHEMA_1_0_0,
          mcpServers: {
            tracker: {
              type: "streamable-http",
              url: "https://mcp.example.com/mcp",
            },
          },
        }),
      ),
    ],
  });
  fireEvent.change(input);

  const install = await view.findByRole("button", { name: "Install" });
  await waitFor(() =>
    expect((install as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(install);
  await view.findByRole("button", { name: "Done" });

  // The list was read again after the save, and holds /weekly now.
  await waitFor(() =>
    expect(
      calls.filter((call) => call === `GET ${SKILLS_PATH}`).length,
    ).toBeGreaterThan(1),
  );
  expect(view.getByText("/weekly")).toBeTruthy();
  expect(view.getByText("Saved")).toBeTruthy();
  expect(view.getByText("Added")).toBeTruthy();
  expect(view.queryByText(/You already have \/weekly/)).toBeNull();
  expect(view.getByText("Installed 1 skill and 1 server.")).toBeTruthy();
  expect(calls).toContain(`PUT ${SKILLS_PATH}/weekly`);
});
