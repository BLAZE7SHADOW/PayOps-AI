"""Baseline: the schema the TypeScript API built with Drizzle (migrations 0000 to 0012), applied unchanged.

A database that Drizzle already migrated (the hosted one) has the tables, so this revision only records itself there.
A new database gets the 13 SQL files in order, triggers included. New schema changes are new Alembic revisions.

Revision ID: 0001
Revises:
"""

from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parent.parent / "sql"
BREAKPOINT = "--> statement-breakpoint"


def upgrade() -> None:
    conn = op.get_bind()
    if conn.execute(sa.text("select to_regclass('public.cases') is not null")).scalar():
        return
    # Statements go straight to the driver: they contain `%` (trigger messages), which a parameterized call would read
    # as a placeholder.
    cursor = conn.connection.dbapi_connection.cursor()
    for file in sorted(SQL_DIR.glob("0*.sql")):
        for statement in file.read_text(encoding="utf-8").split(BREAKPOINT):
            if statement.strip():
                cursor.execute(statement)


def downgrade() -> None:
    raise NotImplementedError("The baseline cannot be undone; restore from a backup instead.")
