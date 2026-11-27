"""`agent-strands/tests/test_forwarded_props_stay_out.py`, against the harness Bot. See `strands_bot_suite.py`."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from strands_bot_suite import load

globals().update(load("test_forwarded_props_stay_out"))
