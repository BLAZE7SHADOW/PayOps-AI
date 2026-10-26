"""Where LangGraph keeps its checkpoints. Read from the environment (and a `.env` file when present)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    #: Postgres for LangGraph checkpoints; empty means in memory.
    database_url: str | None = Field(default=None, repr=False)
    checkpointer: Literal["auto", "memory", "postgres"] = "auto"
    checkpoint_pool_max: int = Field(default=3, ge=1, le=20)
