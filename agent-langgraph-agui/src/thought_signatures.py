"""Gemini's thought signature on a tool call, kept from the step that made the call to the next.

GEMINI 3 REFUSES A TURN THAT LOSES ONE. The first function call of each model step carries a
signature, and a request whose current turn (everything after the latest user message with words)
holds a step whose first call lacks the signature Gemini gave it is refused: 400, "Function call
is missing a thought_signature in functionCall parts". Earlier turns are not checked. Natively the
signature is the part's `thoughtSignature`; on Google's OpenAI-compatible endpoint it is
`tool_calls[i].extra_content.google.thought_signature`.

Both model clients lost it here:
- `langchain-openai` reads neither `extra_content` from a response nor writes it on a request, so
  on the OpenAI-compatible endpoint (how OpenBot Desktop reaches Gemini) every turn that made a
  second model step was refused, inside one run or across two. `SignedChatOpenAI` keeps it.
- `langchain-google-genai` keeps it in `AIMessage.additional_kwargs` under `SIGNATURES`, which
  carries it through one run. A call the caller owns ends the run, and the next run rebuilds the
  turn from the thread, where `ag-ui-langgraph` 0.0.45 neither puts the signature on the call nor
  reads it back, so the integration sent Google's skip value in its place.

So a signature leaves on its call the AG-UI way, as a REASONING_ENCRYPTED_VALUE with subtype
"tool-call" and as `encryptedValue` on the call in the snapshot, and comes back from the thread
onto the call. One key, `SIGNATURES`, holds it on a LangChain message for both clients.

ONLY GEMINI IS SENT ONE. AG-UI does not say which provider sealed a call's `encryptedValue`, and no
other provider can read it (see whole_thread.py on reasoning rows), so it goes on a call only when
the model this step asks is Gemini.
"""

import re

from ag_ui.core import EventType, ReasoningEncryptedValueEvent
from langchain_core.messages import AIMessage
from langchain_openai import ChatOpenAI

# Where langchain-google-genai keeps a message's signatures: `{tool_call_id: base64 signature}`.
SIGNATURES = "__gemini_function_call_thought_signatures__"

_GEMINI = re.compile(r"(^|[/:.])gemini-", re.IGNORECASE)


def is_gemini(model) -> bool:
    """Whether this chat model asks Gemini, natively or at an OpenAI-compatible endpoint."""
    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError:
        ChatGoogleGenerativeAI = None
    if ChatGoogleGenerativeAI is not None and isinstance(model, ChatGoogleGenerativeAI):
        return True
    name = getattr(model, "model_name", None) or getattr(model, "model", None)
    return isinstance(model, ChatOpenAI) and isinstance(name, str) and bool(_GEMINI.search(name))


def issued(message) -> dict[str, str]:
    """The signatures a model step gave its calls, by call id."""
    kept = getattr(message, "additional_kwargs", {}).get(SIGNATURES)
    if not isinstance(kept, dict):
        return {}
    calls = {call.get("id") for call in getattr(message, "tool_calls", None) or []}
    return {
        call_id: signature
        for call_id, signature in kept.items()
        if call_id in calls and isinstance(signature, str) and signature
    }


def from_thread(messages) -> dict[str, str]:
    """The `encryptedValue` each call in an AG-UI thread carries, by call id."""
    found = {}
    for message in messages:
        if getattr(message, "role", None) != "assistant":
            continue
        for call in getattr(message, "tool_calls", None) or []:
            sealed = getattr(call, "encrypted_value", None)
            if isinstance(sealed, str) and sealed:
                found[call.id] = sealed
    return found


def signed(messages, signatures: dict[str, str]):
    """The messages, with each call the thread carried a signature for given it back."""
    if not signatures:
        return messages
    result = []
    for message in messages:
        calls = [call.get("id") for call in getattr(message, "tool_calls", None) or []]
        wanted = {call_id: signatures[call_id] for call_id in calls if call_id in signatures}
        if isinstance(message, AIMessage) and wanted:
            # A signature the step itself keeps wins: it is the one Gemini gave in this run.
            kept = {**wanted, **issued(message)}
            message = message.model_copy(
                update={"additional_kwargs": {**message.additional_kwargs, SIGNATURES: kept}}
            )
        result.append(message)
    return result


def sealed_events(message, public_id):
    """REASONING_ENCRYPTED_VALUE for each call of a finished model step that Gemini signed."""
    return [
        ReasoningEncryptedValueEvent(
            type=EventType.REASONING_ENCRYPTED_VALUE,
            subtype="tool-call",
            entity_id=public_id(call_id),
            encrypted_value=signature,
        )
        for call_id, signature in issued(message).items()
    ]


def with_sealed_calls(event, signatures: dict[str, str]):
    """A MESSAGES_SNAPSHOT whose calls carry the signatures known for them, as `encryptedValue`.

    The integration builds the snapshot from LangChain messages, which have no place for it, so
    without this a snapshot gave back the thread with every call's signature gone.
    """
    if not signatures:
        return event
    messages = []
    for message in event.messages:
        calls = getattr(message, "tool_calls", None) or []
        if getattr(message, "role", None) == "assistant" and any(
            call.id in signatures for call in calls
        ):
            message = message.model_copy(
                update={
                    "tool_calls": [
                        call.model_copy(update={"encrypted_value": signatures[call.id]})
                        if call.id in signatures
                        else call
                        for call in calls
                    ]
                }
            )
        messages.append(message)
    return event.model_copy(update={"messages": messages})


def _google_signature(call) -> str | None:
    extra = call.get("extra_content") if isinstance(call, dict) else None
    google = extra.get("google") if isinstance(extra, dict) else None
    signature = google.get("thought_signature") if isinstance(google, dict) else None
    return signature if isinstance(signature, str) and signature else None


class SignedChatOpenAI(ChatOpenAI):
    """`ChatOpenAI` that keeps Gemini's signature at an OpenAI-compatible endpoint.

    Read from a response's `tool_calls[i].extra_content` into `SIGNATURES`, streamed or not, and
    written back onto the same call of the request, only when the model asked is Gemini. Every
    other model's requests are exactly ChatOpenAI's.
    """

    def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info):
        generation = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if generation is None or not isinstance(chunk, dict):
            return generation
        choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices") or []
        delta = (choices[0].get("delta") if choices else None) or {}
        found = {
            call["id"]: _google_signature(call)
            for call in delta.get("tool_calls") or []
            if call.get("id") and _google_signature(call)
        }
        if found:
            generation.message.additional_kwargs[SIGNATURES] = found
        return generation

    def _create_chat_result(self, response, generation_info=None):
        result = super()._create_chat_result(response, generation_info)
        raw = response if isinstance(response, dict) else response.model_dump()
        for generation, choice in zip(result.generations, raw.get("choices") or []):
            found = {
                call["id"]: _google_signature(call)
                for call in (choice.get("message") or {}).get("tool_calls") or []
                if call.get("id") and _google_signature(call)
            }
            if found:
                generation.message.additional_kwargs[SIGNATURES] = found
        return result

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        if "messages" not in payload or not is_gemini(self):
            return payload
        signatures = {}
        for message in self._convert_input(input_).to_messages():
            signatures.update(issued(message))
        for message in payload["messages"]:
            for call in message.get("tool_calls") or []:
                if call.get("id") in signatures:
                    call["extra_content"] = {
                        "google": {"thought_signature": signatures[call["id"]]}
                    }
        return payload
