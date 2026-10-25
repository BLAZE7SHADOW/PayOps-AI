"""Cassette format for RECORD and REPLAY, shared with the TypeScript service (packages/core cassette.ts).

Both runtimes read the same files in `fixtures/cassettes/`, so a recording made by either one replays in
the other. The key is a hash of the node (or Jev tag), the call's position, and the prompt, which means
every prompt string built by context.py has to match the TypeScript one exactly.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from .jsonutil import _normalize, js_dumps

Kind = Literal["llm", "jev"]


def default_cassette_dir() -> Path:
    override = os.environ.get("CASSETTE_DIR")
    if override:
        return Path(override)
    # python/agents/src/payops_agents/cassette.py -> repo root is four levels up from this directory.
    return Path(__file__).resolve().parents[4] / "fixtures" / "cassettes"


class ReplayMissError(Exception):
    def __init__(self, key: str, kind: Kind) -> None:
        super().__init__(f"REPLAY miss: no recorded {kind} response for cassette key {key}")
        self.key = key
        self.kind = kind


def stable_hash(value: Any) -> str:
    """SHA-256 of the JSON of `value` with object keys sorted at every level."""
    return hashlib.sha256(js_dumps(_normalize(value)).encode("utf-8")).hexdigest()


def cassette_key(node: str, call_index: int, normalized_prompt_hash: str) -> str:
    return hashlib.sha256(f"{node}|{call_index}|{normalized_prompt_hash}".encode()).hexdigest()[:24]


def cassette_path(scenario_key: str, directory: Path | None = None) -> Path:
    return (directory or default_cassette_dir()) / f"{scenario_key}.jsonl"


def replay_cassette_paths(scenario_key: str, directory: Path | None = None) -> list[Path]:
    """Runs without a scenario use 'default'; if no default.jsonl exists they read every cassette."""
    directory = directory or default_cassette_dir()
    own = cassette_path(scenario_key, directory)
    if scenario_key != "default" or own.exists() or not directory.exists():
        return [own]
    return sorted(p for p in directory.iterdir() if p.name.endswith(".jsonl"))


@dataclass
class _Entry:
    key: str
    kind: Kind
    group: str
    index: int
    path: Path
    response: Any
    used: bool = False


@dataclass
class CassetteReader:
    """Reads a scenario's cassette. Same lookup rules as the TypeScript reader: exact key first, then
    the nearest unused recording for the same step in the same file once one call has matched."""

    paths: list[Path]
    exact_hits: int = field(default=0)
    fallback_hits: int = field(default=0)
    _entries: list[_Entry] | None = field(default=None, repr=False)
    _last_hit: _Entry | None = field(default=None, repr=False)

    def _load(self) -> list[_Entry]:
        if self._entries is not None:
            return self._entries
        entries: list[_Entry] = []
        for path in self.paths:
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8").split("\n"):
                if not line.strip():
                    continue
                raw = json.loads(line)
                meta = raw.get("meta") or {}
                group = str(meta.get("node") or meta.get("tag") or "")
                entries.append(_Entry(raw["key"], raw["kind"], group, len(entries), path, raw["response"]))
        self._entries = entries
        return entries

    def read(self, key: str, kind: Kind, group: str | None = None) -> Any:
        entries = self._load()
        exact = next((e for e in entries if not e.used and e.key == key), None)
        if exact:
            exact.used = True
            self._last_hit = exact
            self.exact_hits += 1
            return exact.response
        anchor = self._last_hit
        if anchor and group:
            best: _Entry | None = None
            for e in entries:
                if e.used or e.kind != kind or e.group != group or e.path != anchor.path:
                    continue
                if best is None or abs(e.index - anchor.index) < abs(best.index - anchor.index):
                    best = e
            if best:
                best.used = True
                self.fallback_hits += 1
                return best.response
        raise ReplayMissError(key, kind)


def append_cassette(path: Path, entry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(js_dumps(entry) + "\n")
