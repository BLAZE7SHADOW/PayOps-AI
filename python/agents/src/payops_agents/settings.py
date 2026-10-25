"""Typed configuration, read once from the environment (and a `.env` file when present)."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    #: Shared with the API. Without it every call is refused.
    agent_internal_secret: str = Field(default="", repr=False)
    #: Where the API's `/internal/agent` routes live.
    node_api_url: str = "http://127.0.0.1:4000"
    node_api_timeout_seconds: float = Field(default=60.0, gt=0)
    #: Postgres for LangGraph checkpoints; empty means in memory.
    database_url: str | None = Field(default=None, repr=False)
    checkpointer: Literal["auto", "memory", "postgres"] = "auto"
    checkpoint_pool_max: int = Field(default=3, ge=1, le=20)
    #: Lets a request replace the models with hand-written answers. For evals only.
    agent_allow_fixtures: bool = False
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    @property
    def secret_is_set(self) -> bool:
        return len(self.agent_internal_secret) >= 16


@lru_cache
def get_settings() -> Settings:
    return Settings()
