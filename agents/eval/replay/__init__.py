"""Replay a recorded match stream against a running agent server.

Run from `agents/`:

    python -m eval.replay data/streams/tennis_x.jsonl --url ws://localhost:8000/ws
    python -m eval.replay data/streams/real_x.jsonl --speed 4 --wrong-labels 0.2
    python -m eval.replay.report out/a.jsonl out/b.jsonl

A replay sends fixed events, so it tests the server's read and reasoning,
not who wins points.
"""
