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

It listens on `http://localhost:4202/ag-ui` (`PORT` to change) and answers `GET /health`.

| Variable         | Default   | Meaning                                              |
| ---------------- | --------- | ---------------------------------------------------- |
| `OPENAI_API_KEY` | required  | Read by Pydantic AI's OpenAI provider.               |
| `BOT_MODEL`      | `gpt-4.1` | Model the agent runs. Any tool-calling model.        |
| `PORT`           | `4202`    | Port the AG-UI endpoint listens on.                  |

`OPENAI_BASE_URL` points the OpenAI provider at a compatible gateway, the same way the rest of the
deployment is configured (see [docs/configuration.md](../../docs/configuration.md)).

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
    endpoint: ${PYDANTIC_BOT_AG_UI_URL:-http://localhost:4202/ag-ui}
```

## Notes

- The AG-UI helpers live at `pydantic_ai.ui.ag_ui` in current releases and `pydantic_ai.ag_ui` in
  earlier ones; `src/app.py` imports whichever is present. If your `pydantic-ai` predates AG-UI
  support, upgrade it.
- Only tool-calling models can drive the computer. A model without tool calling will chat but never
  open a page.
