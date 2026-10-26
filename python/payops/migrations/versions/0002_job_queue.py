"""The job queue's tables (Procrastinate), in the same database as everything else.

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op
from procrastinate.schema import SchemaManager

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if conn.execute(sa.text("select to_regclass('public.procrastinate_jobs') is not null")).scalar():
        return
    # Straight to the driver: the schema contains `%` and `:` that a parameterized call would read as placeholders.
    conn.connection.dbapi_connection.cursor().execute(SchemaManager.get_schema())


def downgrade() -> None:
    raise NotImplementedError("Drop the procrastinate_* objects by hand if the queue is retired.")
