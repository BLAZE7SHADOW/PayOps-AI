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
    database_pool_max: int | None = Field(default=None, ge=1, le=50)
    jwt_secret: str | None = Field(default=None, min_length=16, repr=False)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    ai_mode: Literal["LIVE", "RECORD", "REPLAY"] = "REPLAY"
    demo_mode: bool = True
    #: Recorded model responses (and the manifest of which scenarios have them). Defaults to the repository's `fixtures/cassettes`.
    cassette_dir: Path | None = None

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
