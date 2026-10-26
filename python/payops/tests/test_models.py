"""The models and the migrated database must describe the same tables and columns."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from payops.db.models import Base


async def test_every_table_and_column_in_the_database_has_a_model_and_the_reverse(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "select table_name, column_name, is_nullable from information_schema.columns "
                    "where table_schema = 'public' and table_name <> 'alembic_version'"
                )
            )
        ).all()
    in_db: dict[str, dict[str, bool]] = {}
    for table, column, nullable in rows:
        in_db.setdefault(table, {})[column] = nullable == "YES"

    in_models = {t.name: {c.name: c.nullable for c in t.columns} for t in Base.metadata.sorted_tables}
    assert set(in_models) == set(in_db)
    for table, columns in in_db.items():
        assert set(in_models[table]) == set(columns), table
        # A primary key is NOT NULL in the database; everything else must agree on nullability.
        for column, nullable in columns.items():
            assert in_models[table][column] == nullable, f"{table}.{column}"
