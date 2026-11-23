import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  AdminComponentPreview,
  ComponentPreview,
} from "@/components/component-preview";
import { GALLERY as TABLES } from "@/components/gallery/table";
import * as gallery from "@/lib/copilot/gallery-registry";
import {
  PLAYGROUND_KIND,
  type PlaygroundRecord,
} from "@/lib/components/queries";
import { COMPONENTS_PATH, componentsResponse } from "./components-api";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  fetcher = createFetchSpy();
});
afterEach(cleanup);
afterAll(async () => {
  renderer.mockRestore();
  fetcher.mockRestore();
  compiled.mockRestore();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

// The SDK owns iframe execution; this test checks which source reaches that boundary.
const renderer = spyOn(ReactCoreV2, "OpenGenerativeUIActivityRenderer");
function createFetchSpy() {
  return spyOn(globalThis, "fetch");
}
let fetcher: ReturnType<typeof createFetchSpy>;
const compiled = spyOn(gallery, "galleryComponent");
beforeEach(() => {
  renderer.mockClear();
  renderer.mockImplementation(() => <div data-testid="sandbox-renderer" />);
  fetcher.mockClear();
  fetcher.mockResolvedValue(
    componentsResponse([
      {
        name: PUBLISHED.name,
        title: PUBLISHED.title,
        kind: PLAYGROUND_KIND,
        draftDescription: PUBLISHED.draftDescription,
        hasUnpublishedChanges: PUBLISHED.hasUnpublishedChanges,
        draftSource: {
          html: PUBLISHED.draftHtml,
          css: PUBLISHED.draftCss,
          jsFunctions: PUBLISHED.draftJsFunctions,
          argumentSchema: PUBLISHED.draftArgumentSchema,
          sampleArguments: PUBLISHED.sampleArguments,
        },
        source: {
          html: PUBLISHED.publishedHtml ?? "",
          css: PUBLISHED.publishedCss ?? "",
          jsFunctions: PUBLISHED.publishedJsFunctions ?? "",
          argumentSchema: PUBLISHED.publishedArgumentSchema ?? {},
          revision: PUBLISHED.revision,
        },
      },
    ]),
  );
  compiled.mockReturnValue(undefined);
});

const PUBLISHED: PlaygroundRecord = {
  name: "custom_preview_test",
  title: "Preview test",
  draftDescription: "An administrator-authored component",
  draftHtml: "<p>Do not run this draft</p>",
  draftCss: ".draft-only {}",
  draftJsFunctions: 'throw new Error("Draft must not execute")',
  draftArgumentSchema: {},
  publishedHtml: '<p id="title">Published</p>',
  publishedCss: "p { color: blue; }",
  publishedJsFunctions:
    'document.getElementById("title").textContent = window.__args.title;',
  publishedArgumentSchema: {
    type: "object",
    properties: { title: { type: "string" } },
  },
  sampleArguments: { title: "Sample title" },
  revision: 2,
  published: true,
  publishedAt: "2026-09-12T00:00:00Z",
  hasUnpublishedChanges: true,
};

test("admin previews asynchronously loaded published source with saved samples in the SDK sandbox", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const observe = spyOn(ResizeObserver.prototype, "observe");
  try {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AdminComponentPreview kind={PLAYGROUND_KIND} name={PUBLISHED.name} />
      </QueryClientProvider>,
    );
    expect(view.queryByTestId("sandbox-renderer")).toBeNull();
    const sandbox = await view.findByTestId("sandbox-renderer");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `${COMPONENTS_PATH}?limit=100&kind=${PLAYGROUND_KIND}`,
    );
    expect(renderer.mock.calls.at(-1)?.[0]).toMatchObject({
      activityType: "open-generative-ui",
      agent: null,
      message: null,
      content: {
        html: [PUBLISHED.publishedHtml],
        css: PUBLISHED.publishedCss,
        jsFunctions: `window.__args = {"title":"Sample title"};\n${PUBLISHED.publishedJsFunctions}`,
        generating: false,
      },
    });
    expect(sandbox.closest("[inert]")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    // The sizing observer must mount after the source arrives, even though the first render was empty.
    expect(observe.mock.calls).toHaveLength(2);
    expect(view.queryByText("This build cannot draw this.")).toBeNull();
  } finally {
    observe.mockRestore();
    queryClient.clear();
  }
});

test("unpublished or never-published source does not reach the renderer", () => {
  const view = render(
    <ComponentPreview
      kind={PLAYGROUND_KIND}
      name={PUBLISHED.name}
      sandboxed={{ ...PUBLISHED, published: false }}
    />,
  );
  expect(
    view.getByText("Publish in the playground to see a preview."),
  ).toBeTruthy();
  view.rerender(
    <ComponentPreview
      kind={PLAYGROUND_KIND}
      name={PUBLISHED.name}
      sandboxed={{ ...PUBLISHED, publishedHtml: null }}
    />,
  );
  expect(renderer).not.toHaveBeenCalled();
});

test("read-only galleries identify playground components without fetching administrator drafts", () => {
  const view = render(
    <ComponentPreview kind={PLAYGROUND_KIND} name={PUBLISHED.name} />,
  );
  expect(view.getByText("Published in the playground.")).toBeTruthy();
  expect(view.queryByText("This build cannot draw this.")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(renderer).not.toHaveBeenCalled();
});

test("compiled previews retain their real component and do not fetch Playground source", () => {
  compiled.mockReturnValue(TABLES[0]);
  const queryClient = new QueryClient();
  try {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AdminComponentPreview kind="card" name="showTable" />
      </QueryClientProvider>,
    );
    expect(view.getByText("Team capacity")).toBeTruthy();
    expect(
      view.container.querySelector("table")?.closest("[inert]"),
    ).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
  } finally {
    queryClient.clear();
  }
});
