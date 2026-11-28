# Connect your agent's framework

A Bot you connect from your own AG-UI agent gets two instructions from OpenBot on every run: its
role, and the guidance on the apps and tools it may use. Some frameworks' AG-UI adapters drop them
before they reach the model. The Bot still connects, answers and calls tools, but it doesn't follow
its role. This page gives, for each of those frameworks, the few lines you add to your own agent so
its model is told both, once, on every run.

Each snippet below was tested end to end against OpenBot, on the framework's official AG-UI example
with the snippet added and nothing else: the model was told the role and the tool guidance exactly
once, as instructions, on a new conversation, on every run that carried a turn on after a tool,
a question to the person or an approval, and after the role was changed. The LangGraph and Mastra
setups for `ag-ui-langgraph` 0.1.0 and `@ag-ui/mastra` 2.1.0, the first releases that take run
guidance, follow those receivers' own guides, linked from each.

## What your agent is sent

Every run starts `messages` with two system messages:

1. the Bot's role, id `standing-role:<bot id>`;
2. the guidance on the apps and tools it may use, id `granted-tools:<bot id>`, when it has any.

The conversation follows. OpenBot's tools arrive in `tools`. When your agent calls one, it ends its
run with the call unanswered, OpenBot runs it, and the next run carries the result. Editing the role
changes what the next run sends.

An endpoint can instead declare that it takes both as AG-UI context, with
`custom["openbot.runGuidance"] = { "version": 1 }` in the AG-UI capabilities it serves at
`GET <endpoint>/capabilities`. OpenBot reads that declaration with the Bot's key, if it has one, and
then sends the endpoint the two as context entries, `OpenBot standing role` and
`OpenBot granted tools guidance`, on every request, and no system message for either. An endpoint
that declares nothing gets the system messages above, as it always has. A Mastra server connected
as **Mastra** serves its declaration at `GET <address>/<agent id>/capabilities`, which OpenBot reads
through `@ag-ui/mastra` with the Bot's key.

Every snippet below hands your model the system messages its caller sends, as instructions. Keep
your endpoint for OpenBot alone: set an authorization header on the Bot's **Setup** and have your
server check it.

Names in the snippets that come from each framework's example (`agentic_chat`, `AgenticChatFlow`,
`INSTRUCTIONS`, the model) are yours to replace with your own.

## Give OpenBot a trusted path

The LangGraph and Mastra receivers that take the context entries give the model the role and the
tool guidance as instructions only when they trust the caller. Any other caller gets the role as an
ordinary task and no tool guidance. A receiver trusts OpenBot in one of two ways:

- **A key.** Your server checks a token, and the Bot's **Key** sends the same one
  (`Bearer <token>`).
- **A listener only OpenBot can reach, with trusted ingress turned on.** Your server runs an instance
  that your network rules let only OpenBot's server reach, with `AG_UI_TRUSTED_INGRESS=true`, and the
  Bot connects to that instance's address.

Being on the same machine or a private address doesn't count. A reverse proxy on the same machine
makes public traffic look local too.

To serve the public as well, run two instances of the same app: a public one for everybody, and a
restricted one with trusted ingress turned on, for OpenBot. Keep the restricted one out of every
public proxy route, port mapping and load balancer, and keep each conversation on the instance it
started on. A deployment that only OpenBot uses runs the restricted one alone.

## Frameworks that need nothing

The OpenAI Agents SDK, Microsoft Agent Framework, AG2, LlamaIndex, Cloudflare Agents and Spring AI
pass both system messages to the model as they ship. Connect them as they are.

## LangGraph

In New Bot, under **Connect a custom agent**, choose **LangChain** (`"harness": "langgraph"` when you
create the Bot through the API).

### With `ag-ui-langgraph` 0.1.0 or later

Install [`ag-ui-langgraph` 0.1.0](https://pypi.org/project/ag-ui-langgraph/0.1.0/) or later. The
chat factory `create_langgraph_agent`, served with `add_langgraph_fastapi_endpoint`, takes the role
and the tool guidance from the run's context and declares that it does at
`<endpoint>/capabilities`. You add no prompt code
([ag-ui-langgraph: serve a LangChain chat agent](https://github.com/ag-ui-protocol/ag-ui/blob/96caee88f5e441d4901d626b5d199a3e9de7c667/integrations/langgraph/python/README.md#serve-a-langchain-chat-agent-with-fastapi)).
A graph you already serve with `LangGraphAgent` keeps its current prompt handling until you add
`RunGuidanceMiddleware` and `RunGuidanceAgentMixin`
([run guidance for existing graphs](https://github.com/ag-ui-protocol/ag-ui/blob/96caee88f5e441d4901d626b5d199a3e9de7c667/integrations/langgraph/python/README.md#run-guidance-for-existing-graphs)).

Then [give OpenBot a trusted path](#give-openbot-a-trusted-path). The stock FastAPI chat reads two
settings:

- `AG_UI_GUIDANCE_TOKEN`: the token it checks. Put `Bearer <token>` in the Bot's **Key**.
- `AG_UI_TRUSTED_INGRESS=true`: on an instance only OpenBot can reach. Leave the Key empty.

For a public instance beside OpenBot's restricted one, run the same app twice, one listener each:

```sh
# Public, behind your public reverse proxy.
AG_UI_GUIDANCE_TOKEN='' AG_UI_TRUSTED_INGRESS=false \
  uv run --frozen uvicorn agents.dojo:app --host 127.0.0.1 --port 8000 --workers 1
```

```sh
# For OpenBot only. Restrict who can reach port 8001 before you start it.
AG_UI_GUIDANCE_TOKEN='' AG_UI_TRUSTED_INGRESS=true \
  uv run --frozen uvicorn agents.dojo:app --host 127.0.0.1 --port 8001 --workers 1
```

Give the Bot the restricted instance's address, here `http://127.0.0.1:8001/agent/agentic_chat`
([public and restricted keyless listeners](https://github.com/ag-ui-protocol/ag-ui/blob/96caee88f5e441d4901d626b5d199a3e9de7c667/integrations/langgraph/python/examples/README.md#public-and-restricted-keyless-listeners)).

### With an earlier release

`ag-ui-langgraph` drops the first system message of every run, which is the role, and keeps the
second. A Bot connected as **LangChain** is also sent the role as the AG-UI context entry
`OpenBot standing role`, which `ag-ui-langgraph` hands your graph in `state["ag-ui"]["context"]`.

**Built with CopilotKit's `CopilotKitMiddleware`?** Add nothing. The middleware writes the AG-UI
context into your model's system prompt as "App Context", so your model is told the role from there,
once. Adding the lines below as well would tell it twice.

**Without that middleware**, add these lines to your graph:

```python
from typing import Annotated, TypedDict

from langchain_core.messages import SystemMessage
from langgraph.graph.message import add_messages

# ag-ui-langgraph hands the graph the run's AG-UI context in state["ag-ui"]["context"].
# LangGraph keeps only the keys a state declares, so the state declares that one.
State = TypedDict(
    "State",
    {"messages": Annotated[list, add_messages], "ag-ui": dict},
    total=False,
)


def openbot_role(state: State) -> list[SystemMessage]:
    """The Bot's role OpenBot sent with this run, unless the thread already says it."""
    said = {m.content for m in state["messages"] if isinstance(m, SystemMessage)}
    for entry in (state.get("ag-ui") or {}).get("context") or []:
        if isinstance(entry, dict):
            description, value = entry.get("description"), entry.get("value")
        else:
            description, value = entry.description, entry.value
        if description == "OpenBot standing role" and value and value not in said:
            return [SystemMessage(content=value)]
    return []
```

Then build your graph's state on `State` (`class AgentState(State): ...`, in place of
`MessagesState`), so it keeps the context, and put `openbot_role(state)` ahead of the messages you
send your model:

```python
reply = model.invoke([*openbot_role(state), *state["messages"]])
```

## Pydantic AI

Pydantic AI's AG-UI adapter removes every system message its client sends unless you pass
`manage_system_prompt="client"`
([Pydantic AI: AG-UI](https://pydantic.dev/docs/ai/integrations/ui/ag-ui/)). Set it on the route
that serves your agent:

```python
async def run_agentic_chat(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(
        request,
        agent=agentic_chat.agent,
        # OpenBot sends the Bot's role and its tool guidance as system messages.
        # Let them through to the model (Pydantic AI strips them by default).
        manage_system_prompt="client",
    )
```

Your agent's own `instructions` are still sent. In `"client"` mode the adapter doesn't add your
agent's `system_prompt`, so keep your agent's own text in `instructions`. Choose **Pydantic AI** in
New Bot.

## Mastra

### With `@ag-ui/mastra` 2.1.0 or later

Install [`@ag-ui/mastra` 2.1.0](https://www.npmjs.com/package/@ag-ui/mastra/v/2.1.0) or later. It
reads the two context entries itself and declares that it does
([@ag-ui/mastra: per-run guidance](https://github.com/ag-ui-protocol/ag-ui/blob/96caee88f5e441d4901d626b5d199a3e9de7c667/integrations/mastra/typescript/README.md#per-run-guidance)).
Then [give OpenBot a trusted path](#give-openbot-a-trusted-path).

**A Mastra server, connected as Mastra.** Add `mastraRunGuidanceProcessor` to the agent's
`inputProcessors`, run each request through `withMastraRunGuidanceAuthority` once your server has
authenticated it, and mount `registerMastraRunGuidanceCapabilities(agentId)` behind the same
authentication as its run routes, all from `@ag-ui/mastra/run-guidance`. OpenBot reads that
declaration through `@ag-ui/mastra` with the Bot's key, and then sends the role and the tool
guidance as the two context entries, with no system message for either. The native example reads
the same two settings as LangGraph's:

- `AG_UI_GUIDANCE_TOKEN`: the token it checks. Put `Bearer <token>` in the Bot's **Key**.
- `AG_UI_TRUSTED_INGRESS=true`: on an instance only OpenBot can reach. Leave the Key empty.

For a public instance beside OpenBot's restricted one, run it twice, each from its own folder so
each keeps its own memory. `$mastra_entry` is the built example's `.mastra/output/index.mjs`:

```sh
# Public, behind your public reverse proxy.
MASTRA_HOST=127.0.0.1 PORT=4111 AG_UI_GUIDANCE_TOKEN= \
  AG_UI_TRUSTED_INGRESS=false AG_UI_RUN_GUIDANCE=true node "$mastra_entry"
```

```sh
# For OpenBot only. Restrict who can reach port 4112 before you start it.
MASTRA_HOST=127.0.0.1 PORT=4112 AG_UI_GUIDANCE_TOKEN= \
  AG_UI_TRUSTED_INGRESS=true AG_UI_RUN_GUIDANCE=true node "$mastra_entry"
```

Choose **Mastra** in New Bot and give the restricted instance's base address, here
`http://127.0.0.1:4112`
([public and keyless private instances](https://github.com/ag-ui-protocol/ag-ui/blob/96caee88f5e441d4901d626b5d199a3e9de7c667/integrations/mastra/typescript/README.md#public-and-keyless-private-instances)).

**Your own server, serving a `MastraAgent` over AG-UI.** Pass `runGuidance: { trusted }` to the
`MastraAgent`, with `trusted` true only when your server checked the caller's key or the request
came in on the restricted listener. Serve the bridge's `getCapabilities()` JSON at
`GET <endpoint>/capabilities` behind the same authentication as the run. Choose
**An agent you already run** in New Bot.

### With an earlier release

`@ag-ui/mastra` passes the user, assistant, tool and developer messages of a run to Mastra and skips
system messages. It does pass developer messages to the model as instructions on every run, so hand
OpenBot's system messages to your agent as developer messages where your server starts the run,
with `agent` your `MastraAgent` and `input` the run's `RunAgentInput`:

```ts
  // OpenBot sends the Bot's role and its tool guidance as system messages.
  // @ag-ui/mastra passes developer messages to the model as instructions,
  // on every run, so hand each system message to the agent as one.
  const messages = input.messages.map((message) =>
    message.role === "system"
      ? { ...message, role: "developer" as const }
      : message,
  );
  const run = agent.clone().run({ ...input, messages });
```

Choose **An agent you already run** in New Bot and give your AG-UI endpoint's address.

## CrewAI

`ag-ui-crewai` drops a run's first message when it is a system message, and that message is the
role. The endpoint has no option for it, so mount it on a FastAPI router whose route puts an empty
system message in front for the adapter to drop
([FastAPI: custom Request and APIRoute class](https://fastapi.tiangolo.com/how-to/custom-request-and-route/)).
This replaces your `add_crewai_flow_fastapi_endpoint(app=app, ...)` call:

```python
import json

from ag_ui_crewai.endpoint import add_crewai_flow_fastapi_endpoint
from fastapi import APIRouter, Request
from fastapi.routing import APIRoute


class KeepTheBotsRole(APIRoute):
    """ag-ui-crewai drops a run's first message when it is a system message, and that is where
    OpenBot sends the Bot's role. Put an empty system message in front for it to drop instead."""

    def get_route_handler(self):
        handle = super().get_route_handler()

        async def handler(request: Request):
            run = json.loads(await request.body())
            run["messages"].insert(0, {"id": "dropped", "role": "system", "content": ""})
            request._body = json.dumps(run).encode()
            return await handle(request)

        return handler


router = APIRouter(route_class=KeepTheBotsRole)
add_crewai_flow_fastapi_endpoint(app=router, flow=AgenticChatFlow(), path="/agentic_chat")
app.include_router(router)
```

Your flow then reads the role and the guidance in `self.state.messages`. Choose **CrewAI** in New Bot.

## Claude Agent SDK

`ag-ui-claude-sdk` sends Claude only the last message of a run, so the system messages never reach
it. Save this file beside your server, and write `SystemMessagesAdapter(` where your code says
`ClaudeAgentAdapter(`. Your options, your own `system_prompt` and `add_claude_fastapi_endpoint` stay
as they are.

```python
from ag_ui_claude_sdk import ClaudeAgentAdapter


class SystemMessagesAdapter(ClaudeAgentAdapter):
    """ClaudeAgentAdapter that gives Claude the run's system messages as its system prompt.

    The adapter sends Claude only the last message of a run, so the system messages a
    client sends never reach it. This puts them ahead of your own system_prompt on every
    run, and sets snapshot to False so a resumed conversation is told this run's
    instructions rather than the ones its first request recorded.
    """

    def build_options(self, input_data=None, **kwargs):
        options = super().build_options(input_data, **kwargs)
        messages = input_data.messages if input_data else []
        system = dict.fromkeys(m.content for m in messages if m.role == "system")
        prompt = "\n\n".join(p for p in [*system, options.system_prompt] if p)
        options.system_prompt = {"type": "custom", "prompt": prompt, "snapshot": False}
        return options
```

It puts the run's system messages ahead of your own `system_prompt`, on every run. Claude Code
records a session's system prompt on its first request and sends it again when the session is
resumed, so `"snapshot": False` is what lets a changed role reach a conversation that already
started ([Claude Agent SDK: modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)).
Choose **Claude Agent SDK** in New Bot.

## Agno

Agno's AG-UI interface hands your agent only the newest user message and any tool results after it.
Keep the run's system messages from the request with an HTTP middleware, and add them to your agent's
instructions, which Agno accepts as a function
([Agno: instructions via a function](https://docs.agno.com/context/agent/instructions-via-function),
[AgentOS: custom middleware](https://docs.agno.com/agent-os/middleware/custom)). Add this after
`app = agent_os.get_app()`:

```python
# Agno's AG-UI interface hands the agent only the newest user message, so the system messages a
# client sends (in OpenBot, the Bot's role and its guidance on its tools) never reach the model.
# Keep them for the request, and make them part of the agent's instructions.
from contextvars import ContextVar

from fastapi import Request

client_instructions: ContextVar[list[str]] = ContextVar("client_instructions", default=[])


@app.middleware("http")
async def keep_client_instructions(request: Request, call_next):
    if request.method == "POST" and request.url.path.endswith("/agui"):
        messages = (await request.json()).get("messages") or []
        client_instructions.set([m["content"] for m in messages if m.get("role") == "system"])
    return await call_next(request)


own_instructions = agent.instructions
agent.instructions = lambda: [own_instructions, *client_instructions.get()]
```

Choose **Agno** in New Bot.

## CopilotKit's built-in agent

CopilotKit's `BuiltInAgent` passes a client's system messages to the model only when
`forwardSystemMessages` is on, and it is off by default
([CopilotKit: message forwarding](https://docs.copilotkit.ai/advanced-configuration#message-forwarding)):

```ts
const builtInAgent = new BuiltInAgent({
  model: "openai:gpt-6-luna",
  // OpenBot sends the Bot's role and its tool guidance as system messages: hand them to the model.
  forwardSystemMessages: true,
});
```

Choose **An agent you already run** in New Bot.

## AWS Strands

`ag-ui-strands` doesn't pass the client's system messages to the model. Hand each run's system
messages to a Strands hook with `invocation_state_provider`, and have the hook add them to the
agent's system prompt when the run begins
([ag-ui-strands](https://pypi.org/project/ag-ui-strands/),
[Strands hooks](https://strandsagents.com/docs/api/python/strands.hooks.events/)). `ag-ui-strands`
keeps one agent per conversation, so the hook rebuilds the prompt from your own on every run, and a
changed role replaces the old one:

```python
from ag_ui_strands import StrandsAgent, create_strands_app
from strands.hooks import BeforeInvocationEvent, HookProvider


# OpenBot sends the Bot's role and its tool guidance as system messages, which
# ag-ui-strands does not pass to the model. Hand each run's to the hook below.
def system_messages(request, input_data):
    return {"system_messages": [m.content for m in input_data.messages if m.role == "system"]}


class SystemMessagesInSystemPrompt(HookProvider):
    """Puts the run's system messages after the agent's own system prompt."""

    def __init__(self, base_prompt):
        self.base_prompt = base_prompt

    def register_hooks(self, registry, **kwargs):
        registry.add_callback(BeforeInvocationEvent, self.before_invocation)

    def before_invocation(self, event):
        sent = event.invocation_state.get("system_messages")
        if sent:  # A run that sends none keeps the conversation's last ones.
            event.agent.system_prompt = "\n\n".join(filter(None, [self.base_prompt, *sent]))


agui_agent = StrandsAgent(
    agent=strands_agent,
    name="agentic_chat",
    description="Conversational Strands agent with AG-UI streaming",
    hooks=[SystemMessagesInSystemPrompt(strands_agent.system_prompt)],
)
agent_app = create_strands_app(
    agui_agent, "/", origins=cors_origins(), invocation_state_provider=system_messages
)
```

`strands_agent` is your Strands `Agent`, and the other arguments are your own. Choose **AWS Strands**
in New Bot.

## A2A agents through the AG-UI A2A middleware

`@ag-ui/a2a-middleware` puts its own prompt in place of a run's first system message, and its
orchestrator then reads that one system message only. Add the run's system messages to the
middleware's `instructions` on a clone made for the run, and take them out of its messages. Do this
where your server starts the run, with `agent` your `A2AMiddlewareAgent` and `INSTRUCTIONS` the
instructions you built it with:

```ts
  // The A2A middleware replaces a run's first system message with its own prompt, so the
  // client's system messages (the Bot's role, its tool guidance) go into its instructions.
  const middleware = agent.clone();
  const system = input.messages.flatMap((message) =>
    message.role === "system" ? [message.content] : [],
  );
  middleware.instructions = [INSTRUCTIONS, ...system].join("\n\n");
  input.messages = input.messages.filter(
    (message) => message.role !== "system",
  );
  const run = middleware.run(input);
```

The orchestrator's model is then told the role and the tool guidance with the middleware's own
instructions. Choose **An agent you already run** in New Bot.
