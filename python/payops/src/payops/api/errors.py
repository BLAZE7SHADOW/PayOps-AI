"""Turns every failure into `{ "error": { "code", "message", "details"?, "requestId" } }`, the shape the web app reads."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..errors import STATUS, AppError
from ..observability import request_id_var

log = logging.getLogger("payops.api")


def _body(code: str, message: str, details: object = None) -> dict[str, object]:
    error: dict[str, object] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    error["requestId"] = request_id_var.get()
    return {"error": error}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(_: Request, err: AppError) -> JSONResponse:
        return JSONResponse(_body(err.code, err.message, err.details), status_code=err.status)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, err: RequestValidationError) -> JSONResponse:
        problems = [{"path": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in err.errors()]
        # A body that is not JSON at all is a 400; a body that is JSON but wrong is a 422.
        if any(e["type"] == "json_invalid" for e in err.errors()):
            return JSONResponse(_body("BAD_REQUEST", "Malformed JSON body"), status_code=STATUS["BAD_REQUEST"])
        return JSONResponse(_body("VALIDATION_FAILED", "Request validation failed", problems), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, err: StarletteHTTPException) -> JSONResponse:
        if err.status_code == 404:
            return JSONResponse(_body("NOT_FOUND", f"No route for {request.method} {request.url.path}"), status_code=404)
        if err.status_code == 405:
            return JSONResponse(_body("NOT_FOUND", f"No route for {request.method} {request.url.path}"), status_code=404)
        return JSONResponse(_body("INTERNAL", str(err.detail)), status_code=err.status_code)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, err: Exception) -> JSONResponse:
        log.error("unhandled error", exc_info=err)
        return JSONResponse(_body("INTERNAL", "Unexpected server error"), status_code=500)
