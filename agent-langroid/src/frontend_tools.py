"""Supply AG-UI tool schemas and returned history to Langroid's public LLM API."""

from copy import deepcopy

from ag_ui.core import RunAgentInput, Tool
from ag_ui_langroid import LangroidAgent
from langroid import ChatAgent, ChatAgentConfig, ChatDocument, ToolMessage
from langroid.language_models.base import LLMFunctionSpec, LLMMessage, OpenAIToolCall, Role


def _tool_message(tool: Tool) -> type[ToolMessage]:
    class FrontendTool(ToolMessage):
        request: str = tool.name
        purpose: str = tool.description
        strict: bool = False

        @classmethod
        def llm_function_schema(cls, request=False, defaults=True):
            return LLMFunctionSpec(
                name=tool.name,
                description=tool.description,
                parameters=deepcopy(tool.parameters),
            )

    return FrontendTool


def _messages(input_data: RunAgentInput, system_message: str) -> list[LLMMessage]:
    messages = [LLMMessage(role=Role.SYSTEM, content=system_message)]
    for message in input_data.messages:
        content = getattr(message, "content", None)
        if isinstance(content, list):
            content = "\n".join(part.text for part in content if part.type == "text")
        calls = getattr(message, "tool_calls", None)
        messages.append(
            LLMMessage(
                role=Role.SYSTEM if message.role == "developer" else Role(message.role),
                content=content,
                tool_call_id=getattr(message, "tool_call_id", None),
                tool_calls=[OpenAIToolCall.from_dict(call.model_dump()) for call in calls]
                if calls
                else None,
            )
        )
    return messages


class _RequestAgent(ChatAgent):
    def __init__(self, config: ChatAgentConfig):
        super().__init__(config)
        self.input_messages: list[LLMMessage] = []
        self.response_ids: list[str] = []

    def _clone_extra_state(self, new_agent):
        new_agent.input_messages = self.input_messages
        new_agent.response_ids = self.response_ids

    def llm_response(self, message=None):
        response = self.llm_response_messages(self.input_messages)
        if response is not None:
            self.response_ids.append(response.id())
        return response


class FrontendToolsAgent(LangroidAgent):
    async def run(self, input_data: RunAgentInput):
        # ag-ui-langroid 0.1.1 forwards only tool names and the latest user text.
        # https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/langroid
        # Keep its event encoding, but use each run's complete history and schemas.
        agent = _RequestAgent(self._agent.config.model_copy(deep=True))
        agent.input_messages = _messages(input_data, agent.config.system_message)
        for tool in input_data.tools:
            agent.enable_message(_tool_message(tool), use=True, handle=False)
        adapter = LangroidAgent(name=self.name, agent=agent)
        try:
            async for event in adapter.run(input_data):
                yield event
        finally:
            for response_id in agent.response_ids:
                ChatDocument.delete_id(response_id)
