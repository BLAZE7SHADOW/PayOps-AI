"""PII masking used by API projections and the simulator's seeded customers. (packages/shared mask.ts)"""

from __future__ import annotations

import re


def mask_email(email: str) -> str:
    parts = email.split("@")
    user, domain = parts[0], parts[1] if len(parts) > 1 else ""
    if not domain:
        return "***"
    return f"{user[:1]}{'*' * max(3, len(user) - 1)}@{domain}"


def mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    return f"+91 ******{digits[-4:]}"


# Free-text scrubber (docs/07-security.md, D078). The field maskers above only help when a value sits under a known key.
# This one looks at the text itself, so an
# email or phone number that a customer typed into a note is still removed before the text leaves for Gemini or Jev. A
# safety net, not a PII detector: it catches
# emails, Indian-style mobile numbers and long digit runs (card or account numbers). Names are not caught.
_EMAIL_IN_TEXT = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_IN_TEXT = re.compile(r"(?<![\w.])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)")
_LONG_DIGITS_IN_TEXT = re.compile(r"(?<![\w.])\d(?:[\s-]?\d){11,18}(?!\d)")


def scrub_pii_text(text: str) -> str:
    text = _EMAIL_IN_TEXT.sub("[email removed]", text)
    text = _PHONE_IN_TEXT.sub("[phone removed]", text)
    return _LONG_DIGITS_IN_TEXT.sub("[number removed]", text)
