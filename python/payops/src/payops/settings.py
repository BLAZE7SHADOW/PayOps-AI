"""Typed configuration, read once from the environment (and a `.env` file when present).

Names match the TypeScript API's variables, so one `.env` and one Render dashboard serve both while they coexist.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    node_env: Literal["development", "test", "production"] = "development"
    port: int = 4000
    web_origin: str = "http://localhost:5173"
    #: `postgres://` or `postgresql://`; converted for SQLAlchemy by `sqlalchemy_url`.
    database_url: str = Field(default="postgres://postgres:postgres@127.0.0.1:54329/postgres", repr=False)
    #: Connections kept for reading the gateway's tables. They are a separate pool on purpose: a request holds one application connection while it asks the
    #: gateway, so sharing one pool lets a burst of requests each wait for a second connection the others hold (a deadlock). A pool of leaf reads cannot.
    gateway_pool_max: int = Field(default=5, ge=1, le=20)
    database_pool_max: int | None = Field(default=None, ge=1, le=50)
    jwt_secret: str | None = Field(default=None, min_length=16, repr=False)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    ai_mode: Literal["LIVE", "RECORD", "REPLAY"] = "REPLAY"
    demo_mode: bool = True
    #: Where LangGraph keeps run checkpoints: Postgres in production, memory for local runs and tests (`auto`: Postgres, except for the local PGlite database).
    checkpointer: Literal["auto", "memory", "postgres"] = "auto"
    checkpoint_pool_max: int = Field(default=3, ge=1, le=20)
    #: Apply database migrations, seed the demo users and seal old audit rows when the API starts (the hosted demo does; tests build their database first).
    migrate_on_start: bool = True
    #: How often the reconcile sweep runs, in ms. 0 turns it off (the hosted demo does: the database bills egress).
    reconcile_sweep_ms: int = Field(default=60_000, ge=0)
    #: `worker` runs a job worker in this process; `inline` runs each job at once in the background (tests, and running without a queue).
    jobs: Literal["worker", "inline"] | None = None
    #: How long a Procrastinate worker waits between looks for delayed jobs. NOTIFY wakes it for new ones, so this only affects retries.
    job_poll_seconds: float = Field(default=30, ge=1)
    #: Recorded model responses (and the manifest of which scenarios have them). Defaults to the repository's `fixtures/cassettes`.
    cassette_dir: Path | None = None

    @property
    def jobs_mode(self) -> Literal["worker", "inline"]:
        return self.jobs or ("inline" if self.node_env == "test" else "worker")

    @property
    def cassettes(self) -> Path:
        return self.cassette_dir or Path(__file__).resolve().parents[4] / "fixtures" / "cassettes"

    @property
    def sqlalchemy_url(self) -> str:
        return sqlalchemy_url(self.database_url)

    @property
    def pool_size(self) -> int:
        """PGlite serves one connection (local development); a real Postgres gets a normal pool."""
        if self.database_pool_max:
            return self.database_pool_max
        return 1 if ":54329/" in self.database_url else 10


def sqlalchemy_url(url: str) -> str:
    """Turns the `postgres://` form the rest of the project uses into SQLAlchemy's psycopg 3 driver form."""
    for prefix in ("postgresql+psycopg://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.node_env == "production" and not settings.jwt_secret:
        raise RuntimeError("JWT_SECRET is required in production")
    return settings
