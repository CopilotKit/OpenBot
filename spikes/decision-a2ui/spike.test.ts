import assert from "node:assert/strict";
import test from "node:test";
import { A2uiValidationError } from "@a2ui/agent";
import { MessageProcessor } from "@a2ui/web_core/v1_0";
import { acceptMessages, createProcessor, spikeCatalog } from "./sdk.ts";
import { DecisionSession } from "./decision.ts";
import { actionFor, application, cases, mockDecisions } from "./fixtures.ts";
import { collectExpress, expressFixture, expressPrompt } from "./express.ts";

for (const example of cases) {
  test(`decisions: ${example.id}`, async () => {
    const processor = createProcessor(spikeCatalog());
    const api = mockDecisions(example.answers);
    const session = new DecisionSession(processor, api.submit);
    const turn = session.show(example.request, application);
    if (example.error) {
      await assert.rejects(turn, { code: example.error });
      assert.deepEqual(session.state.surfaceIds, []);
    } else {
      const result = await turn;
      const renderer = new MessageProcessor([spikeCatalog()]);
      renderer.processMessages(result.messages);
      const surface = renderer.getSurface("spike")!;
      for (const [id, component] of Object.entries(example.components ?? {})) {
        assert.equal(surface.componentsModel.get(id)?.type, component, id);
      }
    }
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].model, "gemini-decision-1");
    assert.match(String(api.requests[0].input), /request/);
  });
}

test("a renderer action reuses the negotiated state and updates the existing detail", async () => {
  const api = mockDecisions(
    { layout: "results", resultsGroup: "List", detailFrame: "Card" },
    { detailMode: "summary" },
  );
  const session = new DecisionSession(
    createProcessor(spikeCatalog()),
    api.submit,
  );
  await session.show(cases[2].request, application);
  const before = session.state.getSurface("spike")!;
  await assert.rejects(session.follow(actionFor("bad")), { code: "action" });
  const result = await session.follow(actionFor("birch"));
  assert.deepEqual(result.messages, [
    {
      version: "1.0",
      updateDataModel: {
        surfaceId: "spike",
        value: {
          selectedId: "birch",
          detail: "Birch — available",
        },
      },
    },
  ]);
  assert.equal(session.state.getSurface("spike"), before);
  assert.equal(api.requests.length, 2);
  assert.match(String(api.requests[1].input), /selectedId/);
  assert.match(String(api.requests[1].input), /interactionHistory/);
});

test("catalog pruning changes the offered choices and needs no compiler change", async () => {
  const catalog = spikeCatalog(true);
  const api = mockDecisions({ layout: "results", resultsGroup: "Column" });
  const session = new DecisionSession(createProcessor(catalog), api.submit);
  const result = await session.show(cases[3].request, application);
  const renderer = new MessageProcessor([catalog]);
  renderer.processMessages(result.messages);
  assert.equal(
    renderer.getSurface("spike")!.componentsModel.get("results_group")?.type,
    "Column",
  );
  assert.equal(
    renderer.getSurface("spike")!.componentsModel.get("detail_frame"),
    undefined,
  );
  assert.equal(api.requests[0].questions.detailFrame, undefined);
  assert.equal(api.requests[0].questions.resultsGroup, undefined);
});

test("canonical ingress rejects bad topology and rolls back the entire batch", async () => {
  const processor = createProcessor(spikeCatalog());
  const api = mockDecisions({
    layout: "confirmation",
    confirmationFrame: "inline",
  });
  const messages = (
    await new DecisionSession(processor, api.submit).show(
      cases[4].request,
      application,
    )
  ).messages;
  const state = processor.createState();
  assert.throws(
    () =>
      acceptMessages(processor, state, [
        messages[0],
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "spike",
            components: [
              { id: "root", component: "Column", children: ["missing"] },
            ],
          },
        },
      ]),
    A2uiValidationError,
  );
  assert.deepEqual(state.surfaceIds, []);
  assert.throws(
    () =>
      acceptMessages(processor, state, [
        messages[0],
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "spike",
            components: [{ id: "root", component: "MadeUp" }],
          },
        },
      ]),
    A2uiValidationError,
  );
  assert.deepEqual(state.surfaceIds, []);
  assert.doesNotThrow(() => acceptMessages(processor, state, messages));
  assert.throws(
    () =>
      acceptMessages(processor, state, [
        {
          version: "1.0",
          updateDataModel: { surfaceId: "missing", value: {} },
        },
      ]),
    A2uiValidationError,
  );
});

test("offline Express replay uses the real prompt, chunk parser and renderer", async () => {
  const catalog = spikeCatalog();
  const processor = createProcessor(catalog);
  assert.match(expressPrompt(processor), /<a2ui>/);
  for (const family of ["settings", "results", "confirmation"] as const) {
    const state = processor.createState();
    const result = await collectExpress(
      processor,
      state,
      expressFixture(family),
    );
    const renderer = new MessageProcessor([catalog]);
    renderer.processMessages(result.messages);
    assert.ok(renderer.getSurface("spike")?.componentsModel.get("root"));
    assert.notEqual(result.firstRenderableMs, null);
    if (family === "results") {
      const follow = await collectExpress(
        processor,
        state,
        expressFixture("follow"),
      );
      renderer.processMessages(follow.messages);
      assert.equal(
        renderer.getSurface("spike")?.componentsModel.get("detail")?.type,
        "Text",
      );
    }
  }
});

test("the typed path does not call the active format prompt or parser", async (t) => {
  const processor = createProcessor(spikeCatalog());
  const parser = t.mock.getter(processor, "parser", () =>
    assert.fail("Unexpected text parser call"),
  );
  const prompt = t.mock.getter(processor, "promptSnippet", () =>
    assert.fail("Unexpected text prompt call"),
  );
  const mock = mockDecisions(cases[0].answers);
  const session = new DecisionSession(processor, mock.submit);
  assert.equal(
    (await session.show(cases[0].request, application)).messages.length,
    3,
  );
  assert.equal(parser.mock.callCount(), 0);
  assert.equal(prompt.mock.callCount(), 0);
});
