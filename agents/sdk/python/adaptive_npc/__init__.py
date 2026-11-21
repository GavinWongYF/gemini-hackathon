"""Game-side helpers for plugging a game into the agent server."""
from .pick import holds, pick

try:
    from .client import Client
except ImportError:  # `websockets` isn't installed. `pick` still works on its own.
    Client = None  # type: ignore[assignment,misc]

__all__ = ["pick", "holds", "Client"]
