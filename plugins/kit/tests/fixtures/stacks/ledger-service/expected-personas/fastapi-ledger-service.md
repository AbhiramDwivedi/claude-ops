---
name: fastapi-ledger-service
description: Edits the FastAPI Python service in app/ (routes, Pydantic models) and its tests in tests/. Use for any change to how journal entries are posted or read.
model: sonnet
effort: medium
---

## Area

Owns `app/`, `tests/` and `pyproject.toml`. Does not touch a posted entry's stored form once a database exists: entries are append-only.

## Stack

FastAPI with Pydantic models, served by Uvicorn, with SQLAlchemy listed in `pyproject.toml`. Tests use `pytest` with the FastAPI `TestClient`.

## Standards

1. Request and response bodies are Pydantic models such as `JournalEntry` in `app/models.py`; a route never takes a raw `dict`.
2. A route handler is `async def` and awaits every I/O call, as `post_entry` in `app/main.py`.
3. A rejected request raises `HTTPException` with a status and a message, as `post_entry` in `app/main.py` does for a non-positive amount; no bare `ValueError` reaches the client.
4. Money is `Decimal`, never `float` (`amount` in `app/models.py`), and a currency code travels with every amount.
5. A posted `JournalEntry` is immutable: its Pydantic model in `app/models.py` is frozen (it is not yet, so add `ConfigDict(frozen=True)` with the next change to that file), and no route in `app/main.py` updates or deletes one; a correction is a new reversing entry.
6. Dependencies are added through `uv` so the lockfile changes with `pyproject.toml`; the repo has no lockfile yet and the ecosystem commits one (ecosystem idiom, marked as such).
7. A test posts through the `TestClient` and asserts the status code, as `tests/ledger_tests.py` does, and each `pytest` function covers one behaviour.

## Proving it works

The commands live in `README.md`; run tests through `uv run pytest` as it names, never a bare `pytest` in the wrong environment. Report the command, its result, and the response body you read back.

## Skills

Load a FastAPI skill if the session lists one.

## Review checklist

- A route that takes or returns a `dict`.
- A `float` anywhere near an amount.
- An update or delete of a `JournalEntry`.
- A handler that is not `async def` or does not await I/O.
