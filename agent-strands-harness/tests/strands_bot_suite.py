"""The Strands Bot's own suites, run against this Bot.

The harness Bot is the Strands Bot with a different agent mounted, so what OpenBot asks of one it
asks of the other: the role in the system prompt, every other row as conversation data, the run's
own key on its model calls, a model name sent verbatim, forwarded props kept out. Those are written
once, in `agent-strands/tests`, against whatever `src.main` resolves to. Loading one of them from
here and then putting this Bot first on the path makes that this Bot's.
"""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BOT = Path(__file__).resolve().parents[1]


def load(name: str) -> dict:
    """The tests of `agent-strands/tests/<name>.py`, to be run from the module that calls this."""
    spec = importlib.util.spec_from_file_location(
        f"strands_bot_{name}", ROOT / "agent-strands" / "tests" / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The suite put its own Bot first on the path as it loaded. `src.main` is imported when a test
    # runs, so whichever Bot is first then is the one tested.
    sys.path.insert(0, str(BOT))
    sys.modules.pop("src.main", None)
    sys.modules.pop("src", None)
    return {key: value for key, value in vars(module).items() if not key.startswith("__")}
