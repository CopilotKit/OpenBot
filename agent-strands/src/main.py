"""AWS Strands as a Bot, through `ag_ui_strands`, which AG-UI maintains."""

import sys
from pathlib import Path

# The files every language in the box reads, and what this Bot shares with the Strands harness
# Bot: one level above this Bot in the repository, and one level above /app/src in the image the
# Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from strands_bot import WithoutForwardedProps, create_app, model_id, serve
from strands_system_prompt import RunSystemPrompt

from ag_ui_strands import StrandsAgent
from strands import Agent
from strands.models.litellm import LiteLLMModel

BOT = "agent-strands"


def _model_id() -> str:
    return model_id(BOT)


class Bot(WithoutForwardedProps, StrandsAgent):
    """The integration's agent, minus a run's forwarded props."""


app = create_app("strands")
serve(
    app,
    Bot(
        name="openbot",
        agent=Agent(model=LiteLLMModel(model_id=_model_id())),
        hooks=[RunSystemPrompt()],
    ),
)
