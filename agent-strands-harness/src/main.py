"""The AWS Strands harness as a Bot, through `ag_ui_strands`, which AG-UI maintains.

`agent-strands` is a bare `strands.Agent`: a model and whatever OpenBot grants it. The harness is
the same class with Amazon's agent assembled on it (context management, its own tools, delegation
to subagents, approvals), built by `strands_harness.create_harness`. Everything a Bot on Strands
shares is in `shared/strands_bot.py`; what is here is only what makes this one the harness.

ONE HARNESS PER CONVERSATION. `StrandsHarnessAgent` calls `create_harness` for each thread, where
`StrandsAgent` would copy one agent. A harness does not survive being copied: its context manager
and background tasks stay with the agent they were built on.

WHAT IS OPENBOT'S STAYS OPENBOT'S. The harness would keep memory, skills and sessions of its own,
in files beside it. A Bot's memory and skills arrive with every run and its conversations are
stored by Intelligence, so those three are off. So is the harness's note about the machine it runs
on, which would describe this container, not the Bot's computer.

ITS OWN TOOLS ARE OFF UNLESS ASKED FOR. The harness can run commands and edit files where it runs.
Here that is this container, past the server's gateway: no grant, no policy and no audit row. A
Bot's computer is the one OpenBot gives it, through tools the server checks. `STRANDS_HARNESS_TOOLS`
turns the harness's own on, for a deployment that has decided to; see `harness_options`.
"""

import os
import sys
from pathlib import Path

# The files every language in the box reads, and what this Bot shares with the Strands Bot: one
# level above this Bot in the repository, and one level above /app/src in the image the Dockerfile
# builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from strands_bot import WithoutForwardedProps, create_app, model_id, serve
from strands_system_prompt import RunSystemPrompt

from ag_ui_strands import StrandsAgentConfig, StrandsHarnessAgent
from strands.models.litellm import LiteLLMModel
from strands_harness import HARNESS_CONTRACT

# The model row this Bot runs on is the Strands Bot's: the same framework, the same clients, the
# same models verified against them.
BOT = "agent-strands"


def _model_id() -> str:
    return model_id(BOT)


def _listed(name: str) -> list[str]:
    return [item.strip() for item in (os.environ.get(name) or "").split(",") if item.strip()]


def harness_options() -> dict:
    """What `create_harness` is given for every conversation.

    `STRANDS_HARNESS_MODEL` names a model the harness reaches itself, as `provider/name` or a bare
    Amazon Bedrock model id, with the credentials of this process. That is the AWS route: Claude
    on Bedrock under the task's own role. Without it the model is OpenBot's, through the server's
    gateway on each run's own key, exactly as the Strands Bot's is.

    `STRANDS_HARNESS_TOOLS` is the harness's own tools to switch on, comma-separated: `shell`,
    `read`, `write`, `edit`, `web_fetch`, `web_search`, `programmatic_tool_caller`, `subagent`.
    They act where this process runs and the server does not see them.

    `STRANDS_HARNESS_INTERVENTIONS` gates those tools: `ask`, `smart`, or a policy in plain words.
    The run stops on an approval the person answers in the conversation. Only those tools: what
    OpenBot grants stays OpenBot's to ask about; see where the Bot is built, below.
    """
    return {
        "model": (os.environ.get("STRANDS_HARNESS_MODEL") or "").strip()
        or LiteLLMModel(model_id=_model_id()),
        "builtin_tools": _listed("STRANDS_HARNESS_TOOLS"),
        "interventions": (os.environ.get("STRANDS_HARNESS_INTERVENTIONS") or "").strip() or None,
        "builtin_plugins": [],
        "memory": False,
        "skills": False,
    }


# How long a conversation's harness is kept with nobody talking in it. A harness is a whole agent
# per conversation, and the integration keeps each until told otherwise, so without this the
# process holds every conversation it has ever had. One let go is built again from the messages
# OpenBot sends with the next run. One still waiting on an approval is kept until it is answered.
IDLE_SECONDS = 30 * 60


class Bot(WithoutForwardedProps, StrandsHarnessAgent):
    """The integration's harness agent, minus a run's forwarded props."""


app = create_app("strands-harness")
serve(
    app,
    Bot(
        name="openbot",
        harness=harness_options(),
        config=StrandsAgentConfig(thread_idle_timeout=IDLE_SECONDS),
        # The harness's own contract first, then the role OpenBot sends with each run.
        hooks=[RunSystemPrompt(HARNESS_CONTRACT)],
        # THE HARNESS'S GATE ASKS ABOUT EVERY TOOL THE AGENT HAS, and here most of them are not the
        # harness's: they are the ones OpenBot grants, which reach the agent as tools the client
        # runs. Those are the server's to check, with its own rules, card and audit row. Left to the
        # harness as well, a Bot stopped to ask about `askApproval` itself, the tool that asks, and
        # the person was shown OpenBot's card and the harness's question for one step.
        gate_client_tools=False,
    ),
)
