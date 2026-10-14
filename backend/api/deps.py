import hmac

from fastapi import Header

from backend.config import settings
from backend.errors import AppError


def require_demo_token(x_demo_token: str | None = Header(default=None)) -> None:
    """State-changing demo endpoints require X-Demo-Token when DEMO_TOKEN is configured."""
    expected = settings.demo_token
    if not expected:
        return
    if not x_demo_token or not hmac.compare_digest(x_demo_token, expected):
        raise AppError(401, "DEMO_TOKEN_REQUIRED", "A valid demo access token is required for this action.")
