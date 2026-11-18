/** The engine's door: health without a token, everything else behind the deployment's. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { conversation, run, TOKEN, withEngine } from "./helpers.ts";

test("/health answers without a token", async () => {
  await withEngine({}, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      harness: "langgraph-ts",
    });
  });
});

test("A run without the deployment's token, or with another, is refused before anything runs", async () => {
  await withEngine({}, async (base) => {
    for (const token of ["", "wrong-token", `${TOKEN}x`]) {
      const response = await fetch(`${base}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-openbot-agent-token": token } : {}),
        },
        body: JSON.stringify(conversation()),
      });
      assert.equal(response.status, 401, `token ${JSON.stringify(token)}`);
    }
  });
});

test("A deployment that set no token refuses every run", async () => {
  await withEngine({ env: { MANAGED_AGENT_TOKEN: "" } }, async (base) => {
    assert.equal((await run(base, conversation(), "")).status, 401);
  });
});

test("A body that is not an AG-UI run is refused, not run", async () => {
  await withEngine({}, async (base) => {
    const response = await fetch(`${base}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOKEN,
      },
      body: JSON.stringify({ messages: "nope" }),
    });
    assert.equal(response.status, 422);
  });
});

test("/models belongs to a ChatGPT plan; without one there is none", async () => {
  await withEngine({}, async (base) => {
    const response = await fetch(`${base}/models`, {
      headers: { "x-openbot-agent-token": TOKEN },
    });
    assert.equal(response.status, 404);
  });
});
