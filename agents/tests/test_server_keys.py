"""Which API key is in use, and the move to a second key when the first runs out.

Every key here is a made-up string and every client is a fake. No real call
is made, and no real .env file is read.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from server import config, decisions_client, keys, managed_client, models_client

FIRST = "made-up-first-key-AAAA1111"
SECOND = "made-up-second-key-BBBB2222"


class OutOfCredit(Exception):
    """Shaped like the SDK's error for HTTP 402."""

    code = 402

    def __init__(self) -> None:
        super().__init__("402 PAYMENT_REQUIRED. The prepaid credit for this key has run out.")


@pytest.fixture
def two_keys(tmp_path, monkeypatch):
    """The first key in the environment, the second in a stand-in for the repo's .env."""
    keys.reset()
    monkeypatch.setenv("GEMINI_API_KEY", FIRST)
    repo_env = tmp_path / "repo.env"
    repo_env.write_text(f'# the event key\nOTHER=1\nGEMINI_API_KEY="{SECOND}"\n')
    keys.load([(tmp_path / "missing.env", "agents/.env"), (repo_env, "the repo's .env")])
    said: list[str] = []
    keys.on_notice(said.append)
    yield said
    keys.reset()
    decisions_client._client = models_client._client = None
    decisions_client._made_with = models_client._made_with = 0


@pytest.fixture
def one_key(tmp_path, monkeypatch):
    """Only the environment has a key, so there is nothing to move to."""
    keys.reset()
    monkeypatch.setenv("GEMINI_API_KEY", FIRST)
    keys.load([(tmp_path / "missing.env", "agents/.env"), (tmp_path / "also-missing.env", "the repo's .env")])
    yield
    keys.reset()
    decisions_client._client = models_client._client = None
    decisions_client._made_with = models_client._made_with = 0


def no_key_in(*texts: str) -> None:
    for text in texts:
        for key in (FIRST, SECOND):
            assert key not in text
            assert key[:8] not in text and key[-4:] not in text
            assert str(len(key)) not in text


class FakeGenai:
    """Stands in for the SDK's Client. A client built with a key in `spent` always gets HTTP 402."""

    def __init__(self, spent: set[str]) -> None:
        self.spent = spent
        self.built: list[str] = []     # the key each client was built with
        self.calls: list[str] = []     # the key each call went out on

    def Client(self, api_key: str, **options):  # noqa: N802 - the SDK's own name
        self.built.append(api_key)

        async def create(**request):
            self.calls.append(api_key)
            if api_key in self.spent:
                raise OutOfCredit()
            return SimpleNamespace(
                output_text='{"answer": "yes"}', status="completed", usage=None,
                model_dump=lambda exclude_none=True: {"answers": {"q": "yes"}},
            )

        api = SimpleNamespace(create=create)
        return SimpleNamespace(aio=SimpleNamespace(decisions=api, interactions=api))


# ------------------------------------------------------------ where the key came from

def test_the_start_line_names_the_source_and_never_the_key(two_keys, tmp_path, monkeypatch, capsys):
    assert keys.source() == "the environment" and config.api_key() == FIRST
    assert keys.start_line() == (
        "The API key in use comes from the environment. "
        "If its credit runs out, the server moves to the key from the repo's .env."
    )
    no_key_in(keys.start_line())

    monkeypatch.delenv("GEMINI_API_KEY")
    assert keys.source() == "the repo's .env" and config.api_key() == SECOND
    assert keys.start_line() == "The API key in use comes from the repo's .env."

    agents_env = tmp_path / "agents.env"
    agents_env.write_text(f"export GEMINI_API_KEY={FIRST}\n")
    keys.load([(agents_env, "agents/.env"), (tmp_path / "repo.env", "the repo's .env")])
    assert keys.source() == "agents/.env" and config.api_key() == FIRST
    assert "moves to the key from the repo's .env" in keys.start_line()

    keys.load([(tmp_path / "missing.env", "agents/.env")])
    assert keys.source() == "" and keys.start_line().startswith("No GEMINI_API_KEY found.")

    # The placeholder line from .env.example is not a key, in a file or in the environment.
    agents_env.write_text("GEMINI_API_KEY=your_api_key_here\n")
    keys.load([(agents_env, "agents/.env")])
    monkeypatch.setenv("GEMINI_API_KEY", "<paste your key>")
    assert keys.source() == "" and keys.start_line().startswith("No GEMINI_API_KEY found.")
    monkeypatch.delenv("GEMINI_API_KEY")
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY is not set"):
        config.api_key()
    no_key_in(capsys.readouterr().out)


def test_the_same_key_in_both_places_is_not_a_fallback(tmp_path, monkeypatch):
    keys.reset()
    monkeypatch.setenv("GEMINI_API_KEY", FIRST)
    same = tmp_path / "repo.env"
    same.write_text(f"GEMINI_API_KEY={FIRST}\n")
    keys.load([(same, "the repo's .env")])
    assert keys.start_line() == "The API key in use comes from the environment."
    assert keys.move_to_fallback() is False and keys.generation() == 0
    keys.reset()


# ------------------------------------------------------------ the move on HTTP 402

async def test_a_402_moves_to_the_fallback_and_retries_exactly_once(two_keys, capsys):
    calls: list[str] = []

    async def call() -> str:
        calls.append(config.api_key())
        if config.api_key() == FIRST:
            raise OutOfCredit()
        return "answered"

    assert await keys.with_fallback(call) == "answered"
    assert calls == [FIRST, SECOND]
    assert config.api_key() == SECOND and keys.source() == "the repo's .env" and keys.generation() == 1
    line = "The first key ran out of credit. Moved to the key from the repo's .env."
    assert two_keys == [line]
    printed = capsys.readouterr().out
    assert printed == f"[server] {line}\n"
    no_key_in(printed, *two_keys, keys.start_line())

    # Later calls go straight out on the second key. Nothing more is said.
    assert await keys.with_fallback(call) == "answered"
    assert calls == [FIRST, SECOND, SECOND] and two_keys == [line]


async def test_no_fallback_means_no_move_and_no_retry(one_key, capsys):
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        raise OutOfCredit()

    with pytest.raises(OutOfCredit):
        await keys.with_fallback(call)
    assert calls == 1 and keys.generation() == 0 and config.api_key() == FIRST
    assert capsys.readouterr().out == ""


async def test_a_fallback_that_is_also_spent_fails_after_one_retry(two_keys, capsys):
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        raise OutOfCredit()

    with pytest.raises(OutOfCredit):
        await keys.with_fallback(call)
    assert calls == 2 and len(two_keys) == 1
    with pytest.raises(OutOfCredit):
        await keys.with_fallback(call)   # already on the last key: one try, no more moves
    assert calls == 3 and len(two_keys) == 1 and keys.generation() == 1
    no_key_in(capsys.readouterr().out)


async def test_other_errors_are_left_alone(two_keys):
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        raise ValueError("HTTP 500: 4020 tokens were too many")

    with pytest.raises(ValueError):
        await keys.with_fallback(call)
    assert calls == 1 and keys.generation() == 0 and two_keys == []
    assert keys.out_of_credit(RuntimeError("call failed: ClientError: 402 PAYMENT_REQUIRED"))
    assert keys.out_of_credit(SimpleNamespace(status_code=402))
    assert not keys.out_of_credit(RuntimeError("429 RESOURCE_EXHAUSTED"))


async def test_two_calls_that_fail_together_move_only_once(two_keys):
    gate = asyncio.Event()
    calls: list[str] = []

    async def call() -> str:
        key = config.api_key()
        calls.append(key)
        if key == FIRST:
            await gate.wait()
            raise OutOfCredit()
        return "answered"

    both = asyncio.gather(keys.with_fallback(call), keys.with_fallback(call))
    await asyncio.sleep(0.01)
    gate.set()
    assert await both == ["answered", "answered"]
    assert calls == [FIRST, FIRST, SECOND, SECOND] and len(two_keys) == 1 and keys.generation() == 1


# ------------------------------------------------------------ inside the three clients

async def test_the_decisions_client_answers_on_the_retry(two_keys, monkeypatch, capsys):
    fake = FakeGenai(spent={FIRST})
    monkeypatch.setattr(decisions_client, "genai", fake)
    reply = await decisions_client.ask([{"type": "text", "text": "hello"}], {"q": {"type": "boolean"}})
    assert reply == {"answers": {"q": "yes"}}
    assert fake.built == [FIRST, SECOND] and fake.calls == [FIRST, SECOND]
    await decisions_client.ask([{"type": "text", "text": "again"}], {"q": {"type": "boolean"}})
    assert fake.built == [FIRST, SECOND] and fake.calls == [FIRST, SECOND, SECOND]   # the new client is kept
    assert len(two_keys) == 1
    no_key_in(capsys.readouterr().out, *two_keys)


async def test_the_models_client_answers_on_the_retry(two_keys, monkeypatch, capsys):
    fake = FakeGenai(spent={FIRST})
    monkeypatch.setattr(models_client, "genai", fake)
    reply = await models_client.ask_json("some-model", "low", "Say yes.", {"type": "object"})
    assert reply.data == {"answer": "yes"}
    assert fake.built == [FIRST, SECOND] and fake.calls == [FIRST, SECOND]
    assert len(two_keys) == 1
    no_key_in(capsys.readouterr().out, *two_keys)


async def test_the_models_client_fails_as_before_with_nothing_to_move_to(one_key, monkeypatch, capsys):
    fake = FakeGenai(spent={FIRST})
    monkeypatch.setattr(models_client, "genai", fake)
    with pytest.raises(models_client.ModelError, match="402"):
        await models_client.ask_json("some-model", "low", "Say yes.", {"type": "object"})
    assert fake.calls == [FIRST]
    assert capsys.readouterr().out == ""


def fake_http(monkeypatch, spent: set[str]) -> list[str]:
    """Make the managed client talk to a fake server that answers 402 to any key in `spent`."""
    seen: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        key = request.headers["x-goog-api-key"]
        seen.append(key)
        if key in spent:
            return httpx.Response(402, json={"error": {"code": 402}})
        if request.headers.get("accept") == "text/event-stream":
            return httpx.Response(200, text='event: step\nid: 1\ndata: {"n": 1}\n\n')
        return httpx.Response(200, json={"id": "run_1", "status": "in_progress"})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        managed_client.httpx, "AsyncClient",
        lambda **options: real(transport=httpx.MockTransport(answer), **options),
    )
    return seen


async def test_the_managed_client_answers_on_the_retry(two_keys, monkeypatch, capsys):
    seen = fake_http(monkeypatch, spent={FIRST})
    client = managed_client.ManagedClient()
    assert (await client.get("run_1"))["id"] == "run_1"
    assert seen == [FIRST, SECOND]
    assert (await client.get("run_1"))["id"] == "run_1"
    assert seen == [FIRST, SECOND, SECOND] and len(two_keys) == 1
    await client.close()
    no_key_in(capsys.readouterr().out, *two_keys)


async def test_the_managed_client_stream_opens_again_on_the_new_key(two_keys, monkeypatch):
    seen = fake_http(monkeypatch, spent={FIRST})
    client = managed_client.ManagedClient()
    events = [event async for event in client.events("run_1")]
    assert events == [{"event": "step", "id": "1", "data": {"n": 1}}]
    assert seen == [FIRST, SECOND] and len(two_keys) == 1
    await client.close()


async def test_the_managed_client_fails_as_before_with_nothing_to_move_to(one_key, monkeypatch):
    seen = fake_http(monkeypatch, spent={FIRST})
    client = managed_client.ManagedClient()
    with pytest.raises(managed_client.ManagedError) as failure:
        await client.get("run_1")
    assert failure.value.status == 402 and seen == [FIRST] and keys.generation() == 0
    await client.close()


async def test_the_managed_client_fails_as_before_when_the_fallback_is_spent_too(two_keys, monkeypatch):
    seen = fake_http(monkeypatch, spent={FIRST, SECOND})
    client = managed_client.ManagedClient()
    with pytest.raises(managed_client.ManagedError) as failure:
        await client.get("run_1")
    assert failure.value.status == 402 and seen == [FIRST, SECOND] and len(two_keys) == 1
    await client.close()


# ------------------------------------------------------------ on the viewer stream

async def test_viewers_see_the_source_and_the_move_but_never_a_key(two_keys, tmp_path, capsys):
    from fakes import Client, FakeAdapter, FakeDesigner, FakeWatcher, fast_settings, running, tennis_setup

    from server.app import create_app

    # All three parts are given, so nothing real is loaded, but the server still counts as using a key.
    app = create_app(FakeWatcher(), FakeDesigner(), FakeAdapter(), data_dir=tmp_path, settings=fast_settings())
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(tennis_setup())
            await game.until("ready")
            assert keys.move_to_fallback() is True
            seen = await viewer.drain(0.3)
    abouts = [line["message"]["about"] for line in seen if line["dir"] == "trace"]
    assert (
        "The API key in use comes from the environment. "
        "If its credit runs out, the server moves to the key from the repo's .env."
    ) in abouts
    assert "The first key ran out of credit. Moved to the key from the repo's .env." in abouts
    import json

    # Viewer lines carry clock times, so the whole stream is checked for the keys themselves,
    # and the words people read are checked for anything about a key, its length included.
    stream = json.dumps(seen)
    assert FIRST not in stream and SECOND not in stream
    no_key_in(*abouts, capsys.readouterr().out)
