"""Runs Alembic migrations from code, so tests, startup and the CLI share one path."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

from ..settings import sqlalchemy_url

ROOT = Path(__file__).resolve().parents[3]


def _config(url: str) -> Config:
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.attributes["url"] = sqlalchemy_url(url)
    return config


def upgrade(url: str, revision: str = "head") -> None:
    command.upgrade(_config(url), revision)


if __name__ == "__main__":  # `uv run python -m payops.db.migrate`
    from ..settings import get_settings

    upgrade(get_settings().database_url)
    print("database is up to date")
