from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..container import Services


def get_services(request: Request) -> Services:
    return request.app.state.services  # type: ignore[no-any-return]


async def get_session(services: Annotated[Services, Depends(get_services)]) -> AsyncIterator[AsyncSession]:
    """One session per request. Read routes never commit; write routes commit through `transaction`."""
    async with services.sessions() as session:
        yield session


ServicesDep = Annotated[Services, Depends(get_services)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]
