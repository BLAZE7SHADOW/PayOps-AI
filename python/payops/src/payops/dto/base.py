"""Base class for every JSON shape the API sends or receives: snake_case in Python, camelCase on the wire."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def to_json(self) -> dict[str, object]:
        """The camelCase dict the web app reads (nulls kept, as the TypeScript API keeps them)."""
        return self.model_dump(mode="json", by_alias=True)
