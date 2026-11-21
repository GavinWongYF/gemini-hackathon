"""Start the agent server:  ./.venv/bin/python -m server

Run it from the folder that holds `server/`. See docs/running.md.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def load_env_file(path: Path) -> None:
    """Take our own NPC_ settings from a .env file.

    Anything already set in the environment wins. The file is only read. It
    is never written, and nothing from it is printed. The API key is not
    taken here: server/keys.py finds it, so it knows where each key came from.
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip().removeprefix("export ").strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("\"'")
        if key.startswith("NPC_"):
            os.environ.setdefault(key, value)


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m server", description="The agent server for adaptive NPCs.")
    parser.add_argument("--port", type=int, default=8000, help="the port to serve on (default 8000)")
    parser.add_argument("--host", default="localhost", help="use 0.0.0.0 to let another machine connect")
    parser.add_argument("--record", action="store_true", help="write each match's viewer stream to data/streams/<match_id>.jsonl")
    parser.add_argument("--no-adapt", action="store_true", help="the unchanged baseline: never send a strategy_update")
    parser.add_argument("--fresh-design", action="store_true", help="design each game again, even if a design is stored")
    parser.add_argument("--screen", default=None, help="the folder to serve at /screen (default demo/tennis-screen)")
    args = parser.parse_args()

    # Model choices must be in place before the parts load.
    # The environment comes first, then a .env here, then the one a folder up.
    load_env_file(HERE / ".env")
    load_env_file(HERE.parent / ".env")

    # The key is found the same way. Say where it came from, never what it is.
    from . import keys

    keys.load()
    if not args.no_adapt:
        print(f"[server] {keys.start_line()}", flush=True)

    import uvicorn

    from .app import create_app

    app = create_app(
        adapt=not args.no_adapt,
        record=args.record,
        reuse_designs=not args.fresh_design,
        screen_dir=args.screen,
    )
    print(f"[server] Game socket:   ws://{args.host}:{args.port}/ws")
    print(f"[server] Viewer socket: ws://{args.host}:{args.port}/watch")
    print(f"[server] Second screen: http://{args.host}:{args.port}/screen/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
