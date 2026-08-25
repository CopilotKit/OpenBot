# Pydantic AI Bot

A Bot written in [Pydantic AI](https://ai.pydantic.dev), served over AG-UI. It sits beside the
[LangGraph](../langgraph-bot) and [Mastra](../mastra-bot) examples and proves the same point in a
third language: OpenBot knows a Bot only as an AG-UI endpoint URL, so a Python agent arrives exactly
the way a TypeScript one does.

The browser and file tools arrive in each run's `tools` from the surface. Pydantic AI exposes them
to the model as external tools whose calls stream back to OpenBot to run through the governed gateway
— so this process drives a real browser it has no direct access to, and the tool loop stays on the
client, the same as the Bot in the box.

## Run it

Requires Python 3.10+. With [uv](https://docs.astral.sh/uv):

```sh
cd examples/pydantic-ai-bot
uv run --env-file ../../.env src/app.py
```

Or with a plain virtualenv:

```sh
cd examples/pydantic-ai-bot
python -m venv .venv && . .venv/bin/activate
pip install -e .
OPENAI_API_KEY=... python src/app.py
```

It listens on `http://localhost:4600/ag-ui` (`PORT` to change) and answers `GET /health`.

| Variable         | Default   | Meaning                                              |
| ---------------- | --------- | ---------------------------------------------------- |
| `OPENAI_API_KEY` | required  | Read by Pydantic AI's OpenAI provider.               |
| `BOT_MODEL`      | `gpt-5.5` | Model the agent runs. Any tool-calling model.        |
| `PORT`           | `4600`    | Port the AG-UI endpoint listens on.                  |
| `REQUIRE_KEY`    | unset     | When set, `/ag-ui` refuses a run whose `authorization` header does not match. |

`OPENAI_BASE_URL` points the OpenAI provider at a compatible gateway, the same way the rest of the
deployment is configured (see [docs/configuration.md](../../docs/configuration.md)). Note which API
that gateway has to serve: Pydantic AI calls `/responses`, not `/v1/chat/completions`. A gateway
offering only chat completions will not answer this example, and the reverse of the constraint the
two TypeScript Bots carry, which is that they speak chat completions and so cannot use the models
that require Responses.

## Register it

Give a coworker this endpoint, either from `/agents` in the UI or as a `remote-ag-ui` agent in a
tenant package:

```yaml
agents:
  - id: pydantic-analyst
    name: Pydantic Analyst
    title: Research
    role_description: Research on a governed computer, written in Pydantic AI.
    type: remote-ag-ui
    endpoint: ${PYDANTIC_BOT_AG_UI_URL:-http://localhost:4600/ag-ui}
```

## Notes

- Serving is done with `AGUIAdapter.dispatch_request` from `pydantic_ai.ui.ag_ui`, which reads the
  `RunAgentInput`, exposes its `tools` to the model as external (frontend) tools, and returns a
  streaming AG-UI response. Verified against `pydantic-ai` 2.33.0; if yours predates the
  `pydantic_ai.ui.ag_ui` module, upgrade it.
- Only tool-calling models can drive the computer. A model without tool calling will chat but never
  open a page.
