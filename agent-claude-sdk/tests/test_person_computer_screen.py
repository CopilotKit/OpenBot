"""The screen OpenBot Desktop's `person_computer` answers with reaches Claude as an image.

FOUND IN THE PC-CONTROL PROTOTYPE. The screen came back as text, and the server added it as a
picture message after the result, which this harness reads as the person having written: every
action replaced the query with a fresh one, each step was slow, and the Bot repeated its first look
and click over and over.
"""

import json

from ag_ui.core import ToolMessage

from src.adapter import client_tool_output
from src.replay import RESULT_CHARS, _cut_result, _entry_blocks, screen_answer

SCREEN = "aGVsbG8=" * 40_000  # base64, far over RESULT_CHARS, as a real JPEG is


def answer(**screen):
    return json.dumps(
        {
            "ok": True,
            "did": "Clicked at (420, 300).",
            "screen": {"base64": SCREEN, "mimeType": "image/jpeg", "width": 1232, "height": 800, **screen},
        }
    )


def test_a_screen_answer_is_its_text_and_an_image_block():
    text, image = screen_answer(answer())
    assert SCREEN not in text
    assert json.loads(text) == {
        "ok": True,
        "did": "Clicked at (420, 300).",
        "screen": {
            "width": 1232,
            "height": 800,
            "note": "The screen after this action is the image that follows.",
        },
    }
    assert image == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": SCREEN},
    }


def test_anything_else_is_not_a_screen():
    assert screen_answer("Opened the report.") is None
    assert screen_answer(json.dumps({"ok": False, "reason": "The person stopped this."})) is None
    assert screen_answer(json.dumps({"screen": "not an object"})) is None
    assert screen_answer(answer(mimeType="text/html")) is None


def test_the_tool_result_claude_code_gets_carries_the_screen_as_an_image():
    content = answer()
    output = client_tool_output(content, screen_answer(content))
    assert [block["type"] for block in output] == ["text", "image"]
    assert SCREEN not in output[0]["text"]
    assert client_tool_output("Done.") == [{"type": "text", "text": "Done."}]


def test_a_replayed_screen_is_an_image_and_is_never_cut():
    message = ToolMessage(id="t1", role="tool", tool_call_id="c1", content=answer())
    assert len(message.content) > RESULT_CHARS
    assert _cut_result(message, RESULT_CHARS) is message
    blocks = _entry_blocks(message, strict=False)
    assert [block["type"] for block in blocks] == ["text", "image"]
    assert SCREEN not in blocks[0]["text"]
    assert json.loads(blocks[0]["text"])["toolCallId"] == "c1"
