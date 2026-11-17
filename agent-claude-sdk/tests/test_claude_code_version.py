"""The Claude Code this harness ships is new enough for the Claude models people pick.

FOUND IN A USER'S SERVER LOG: a Bot on this harness, signed in with a Claude plan, got "API Error:
400 Claude Code 2.1.259 does not support this model; version 2.1.290 or newer is required."
Anthropic turns away a Claude Code too old for the model. Measured per model with the CLI itself:
2.1.259 is refused on Opus 5.5 (needs 2.1.280) and Fable 5.2 (needs 2.1.290), 2.1.289 is still
refused on Fable 5.2, and 2.1.290 answers on Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5. The
harness runs the Claude Code bundled in the claude-agent-sdk package, so the package pin decides it.

This asks the CLI the harness actually starts (found the way the SDK finds it) for its version.
"""

import os
import re
import subprocess

from claude_agent_sdk import ClaudeAgentOptions
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

# The oldest Claude Code Anthropic accepts on every current model (Fable 5.2 sets it), in its own
# error message.
MINIMUM = (2, 1, 290)


def test_bundled_claude_code_is_new_enough_for_current_models(tmp_path):
    # The adapter never sets cli_path, so the SDK picks the CLI exactly like this.
    cli = SubprocessCLITransport(prompt="", options=ClaudeAgentOptions())._find_cli()
    assert "_bundled" in cli, f"expected the CLI bundled with claude-agent-sdk, found {cli}"

    out = subprocess.run(
        [cli, "--version"],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
        env={**os.environ, "HOME": str(tmp_path)},
    ).stdout
    found = re.search(r"(\d+)\.(\d+)\.(\d+)", out)
    assert found, f"no version in {out!r}"
    version = tuple(int(part) for part in found.groups())

    assert version >= MINIMUM, (
        f"Claude Code {'.'.join(map(str, version))} is bundled; Anthropic requires "
        f"{'.'.join(map(str, MINIMUM))} or newer for Fable 5.2 (and 2.1.280 for Opus 5.5)"
    )
