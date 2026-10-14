from typing import Any


class AppError(Exception):
    """Raised by services/routes; rendered as {"error": {"code", "message", "details"}}."""

    def __init__(self, status_code: int, code: str, message: str, details: list[Any] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or []


def not_found(what: str, ident: str) -> AppError:
    return AppError(404, "NOT_FOUND", f"{what} '{ident}' was not found.")


def error_body(code: str, message: str, details: list[Any] | None = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details or []}}
