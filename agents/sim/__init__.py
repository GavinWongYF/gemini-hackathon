"""A stand-in game with no screen.

It plays matches over the socket exactly as the contract says a game should,
with scripted players instead of a person, so the agent side can be built and
measured before the real games are ready. Nothing in this package is about one
game: the game lives in a setup.json and a sim.json.

  sim.game      the socket client (python -m sim)
  sim.headless  the round-playing core with no socket (python -m sim.headless)
  sim.fake_server  a counting stand-in for the agent server, for tests
"""
import sys
from pathlib import Path

# The game-side helper lives in sdk/python. Make it importable when this runs
# from a checkout without the SDK installed.
_SDK = Path(__file__).resolve().parent.parent / "sdk" / "python"
if _SDK.is_dir() and str(_SDK) not in sys.path:
    sys.path.insert(0, str(_SDK))
