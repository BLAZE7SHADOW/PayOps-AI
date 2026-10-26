"""Base class for every JSON shape the API sends or receives: snake_case in Python, camelCase on the wire."""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict, model_serializer
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """`null` fields are sent as null. A field named in `omit_when_none` is left out of the JSON when it is None, which
    is how the TypeScript API treats optional properties (`paymentId?: string`): absent, not null."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    omit_when_none: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _drop_unset(self, handler: Any, info: Any) -> Any:
        data = handler(self)
        if not self.omit_when_none or not isinstance(data, dict):
            return data
        for name in self.omit_when_none:
            field = type(self).model_fields[name]
            key = (field.alias if info.by_alias and field.alias else None) or name
            if key in data and data[key] is None:
                del data[key]
        return data

    def to_json(self) -> dict[str, object]:
        """The camelCase dict the web app reads."""
        return self.model_dump(mode="json", by_alias=True)
