"""The two model ports (docs/02 §3): `LlmPort` for Gemini and `DecisionPort` for Jev.

Everything model-shaped goes through here, in REPLAY (cassettes), RECORD (live call plus cassette write)
or LIVE. The graph never imports a provider. Ported from packages/core/src/adapters.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generic, Protocol, TypeVar, cast

import httpx
from pydantic import BaseModel

from .cassette import (
    CassetteReader,
    append_cassette,
    cassette_key,
    cassette_path,
    replay_cassette_paths,
    stable_hash,
)
from .retry import ProviderHttpError, RetryNotice, RetrySink, with_provider_retry

M = TypeVar("M", bound=BaseModel)

JEV_URL = "https://api.typesafe.ai/v1/systemone"


@dataclass(frozen=True)
class LlmCallMeta:
    node: str
    call_index: int
    scenario_key: str | None = None


@dataclass(frozen=True)
class LlmResult(Generic[M]):
    data: M
    input_tokens: int
    output_tokens: int


class LlmPort(Protocol):
    async def invoke_structured(self, schema: type[M], messages: list[dict[str, str]], meta: LlmCallMeta) -> LlmResult[M]: ...


class DecisionPort(Protocol):
    async def ask(self, tag: str, state: Any, questions: dict[str, Any]) -> dict[str, Any]: ...


# ── LLM adapters ─────────────────────────────────────────────────────────────


class ReplayLlm:
    def __init__(self, scenario_key: str, directory: Path | None = None) -> None:
        self.reader = CassetteReader(replay_cassette_paths(scenario_key, directory))

    async def invoke_structured(self, schema: type[M], messages: list[dict[str, str]], meta: LlmCallMeta) -> LlmResult[M]:
        key = cassette_key(meta.node, meta.call_index, stable_hash(messages))
        recorded = self.reader.read(key, "llm", meta.node)
        usage = recorded.get("usage") or {}
        return LlmResult(
            schema.model_validate(recorded["data"]),
            int(usage.get("inputTokens", 0)),
            int(usage.get("outputTokens", 0)),
        )


class GeminiLlm:
    """LIVE: LangChain's Gemini chat model with structured output, temperature 0."""

    def __init__(self, api_key: str, model: str, on_retry: RetrySink | None = None) -> None:
        from langchain_google_genai import ChatGoogleGenerativeAI

        self._model = ChatGoogleGenerativeAI(model=model, google_api_key=api_key, temperature=0, max_retries=0)
        self._on_retry = on_retry

    async def invoke_structured(self, schema: type[M], messages: list[dict[str, str]], meta: LlmCallMeta) -> LlmResult[M]:
        structured = self._model.with_structured_output(schema, include_raw=True)
        pairs = [(m["role"], m["content"]) for m in messages]
        out = cast(
            dict[str, Any],
            await with_provider_retry("Gemini", lambda: structured.ainvoke(pairs), self._on_retry, step=meta.node),
        )
        parsed = out["parsed"]
        if parsed is None:
            raise ValueError(f"Gemini output did not match the {schema.__name__} schema: {out.get('parsing_error')}")
        usage = getattr(out["raw"], "usage_metadata", None) or {}
        return LlmResult(schema.model_validate(parsed), int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0)))


class RecordingLlm:
    def __init__(self, inner: LlmPort, scenario_key: str, directory: Path | None = None) -> None:
        self._inner = inner
        self._scenario_key = scenario_key
        self._directory = directory

    async def invoke_structured(self, schema: type[M], messages: list[dict[str, str]], meta: LlmCallMeta) -> LlmResult[M]:
        result = await self._inner.invoke_structured(schema, messages, meta)
        key = cassette_key(meta.node, meta.call_index, stable_hash(messages))
        append_cassette(
            cassette_path(self._scenario_key, self._directory),
            {
                "key": key,
                "kind": "llm",
                "meta": {"node": meta.node, "callIndex": meta.call_index},
                "response": {
                    "data": result.data.model_dump(mode="json"),
                    "usage": {"inputTokens": result.input_tokens, "outputTokens": result.output_tokens},
                },
            },
        )
        return result


# ── Jev adapters ─────────────────────────────────────────────────────────────


class ReplayDecision:
    def __init__(self, scenario_key: str, directory: Path | None = None) -> None:
        self.reader = CassetteReader(replay_cassette_paths(scenario_key, directory))
        self._call_index = 0

    async def ask(self, tag: str, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        index = self._call_index
        self._call_index += 1
        key = cassette_key(tag, index, stable_hash({"state": state, "questions": questions}))
        return self.reader.read(key, "jev", tag)  # type: ignore[no-any-return]


class JevDecision:
    """LIVE: Jev (TypeSafe System One) over its HTTP API. There is no Python SDK, so the request is the
    one the TypeScript SDK sends: POST /v1/systemone with `{state, questions, model}`, a Bearer key and a
    10 second timeout. SDK-level retries are off here too; `with_provider_retry` bounds and reports them."""

    def __init__(self, api_key: str, model: str, on_retry: RetrySink | None = None) -> None:
        self._api_key = api_key
        self._model = model
        self._on_retry = on_retry

    async def ask(self, tag: str, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        async def call() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    JEV_URL,
                    json={"state": state, "questions": questions, "model": self._model},
                    headers={"Authorization": f"Bearer {self._api_key}", "Accept": "application/json"},
                )
            if res.status_code >= 400:
                retry_after = res.headers.get("retry-after")
                retry_ms = int(float(retry_after) * 1000) if retry_after else None
                raise ProviderHttpError(res.status_code, res.text, retry_ms)
            return res.json()  # type: ignore[no-any-return]

        return await with_provider_retry("Jev", call, self._on_retry, step=tag)


class RecordingDecision:
    def __init__(self, inner: DecisionPort, scenario_key: str, directory: Path | None = None) -> None:
        self._inner = inner
        self._scenario_key = scenario_key
        self._directory = directory
        self._call_index = 0

    async def ask(self, tag: str, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        result = await self._inner.ask(tag, state, questions)
        index = self._call_index
        self._call_index += 1
        key = cassette_key(tag, index, stable_hash({"state": state, "questions": questions}))
        append_cassette(
            cassette_path(self._scenario_key, self._directory),
            {"key": key, "kind": "jev", "meta": {"tag": tag, "callIndex": index}, "response": result},
        )
        return result


# ── eval fixtures (D085) ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class FixtureOptions:
    """Deterministic Jev answers for the eval goldens that have no recording (packages/evals fixtures.ts)."""

    root_cause: str
    consistent: float = 0.99
    replan_strategy: str = "escalate_to_human"


def fixture_decision(opts: FixtureOptions) -> DecisionPort:
    class _Fixture:
        async def ask(self, tag: str, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
            if tag == "J5_REPLAN":
                return {
                    "answers": {"strategy": {"type": "choice", "choice": opts.replan_strategy, "confidence": 0.9}},
                    "usage": {"input_tokens": 10, "output_tokens": 3},
                }
            return {
                "answers": {
                    "root_cause": {"type": "choice", "choice": opts.root_cause, "confidence": 0.99},
                    "evidence_consistent": {"type": "noul", "noul": opts.consistent, "confidence": 0.99},
                    "needs_human": {"type": "noul", "noul": 0, "confidence": 0.99},
                },
                "usage": {"input_tokens": 10, "output_tokens": 3},
            }

    return _Fixture()


class NoLlm:
    """A fixture scenario that reaches the full path fails loudly instead of returning junk."""

    async def invoke_structured(self, schema: type[M], messages: list[dict[str, str]], meta: LlmCallMeta) -> LlmResult[M]:
        raise RuntimeError("Eval fixture: unexpected LLM call. This scenario is fast-path only.")


# ── factories ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ModelEnv:
    ai_mode: str
    ai_model: str = "gemini-3.6-flash"
    gemini_api_key: str | None = None
    jev_model: str = "jev-1.13.0"
    jev_api_key: str | None = None

    @staticmethod
    def from_environ(ai_mode: str) -> ModelEnv:
        jev_model = os.environ.get("JEV_MODEL") or "jev-1.13.0"
        return ModelEnv(
            ai_mode=ai_mode,
            ai_model=os.environ.get("AI_MODEL") or "gemini-3.6-flash",
            gemini_api_key=os.environ.get("GEMINI_API_KEY") or None,
            jev_model="jev-1.13.0" if jev_model == "jev-1.13" else jev_model,
            jev_api_key=os.environ.get("TYPESAFE_JEV_API_KEY") or None,
        )


def create_llm_port(env: ModelEnv, scenario_key: str | None, on_retry: RetrySink | None = None) -> LlmPort:
    key = scenario_key or "default"
    if env.ai_mode == "REPLAY":
        return ReplayLlm(key)
    if not env.gemini_api_key:
        raise RuntimeError(f"GEMINI_API_KEY is required for AI_MODE={env.ai_mode}")
    live = GeminiLlm(env.gemini_api_key, env.ai_model, on_retry)
    return RecordingLlm(live, key) if env.ai_mode == "RECORD" else live


def create_decision_port(env: ModelEnv, scenario_key: str | None, on_retry: RetrySink | None = None) -> DecisionPort:
    key = scenario_key or "default"
    if env.ai_mode == "REPLAY":
        return ReplayDecision(key)
    if not env.jev_api_key:
        raise RuntimeError(f"TYPESAFE_JEV_API_KEY is required for AI_MODE={env.ai_mode}")
    live = JevDecision(env.jev_api_key, env.jev_model, on_retry)
    return RecordingDecision(live, key) if env.ai_mode == "RECORD" else live


__all__ = [
    "DecisionPort",
    "FixtureOptions",
    "GeminiLlm",
    "JevDecision",
    "LlmCallMeta",
    "LlmPort",
    "LlmResult",
    "ModelEnv",
    "RecordingDecision",
    "RecordingLlm",
    "ReplayDecision",
    "ReplayLlm",
    "NoLlm",
    "RetryNotice",
    "fixture_decision",
    "create_decision_port",
    "create_llm_port",
]
