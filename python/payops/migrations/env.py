"""Alembic environment. The database URL arrives through `config.attributes`, set by `payops.db.migrate`."""

from alembic import context
from sqlalchemy import create_engine

config = context.config
url = config.attributes["url"]

if context.is_offline_mode():
    context.configure(url=url, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    engine = create_engine(url)
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()
