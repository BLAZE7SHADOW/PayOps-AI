"""The sign-in building blocks against values produced by the TypeScript implementation: a hash, a sealed TOTP seed, one-time codes, a session cookie and an
MFA challenge made there must be accepted here, and the other way round (tests/fixtures/auth_vectors.json, made by running the real TypeScript modules)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import jwt

from payops.auth.demo_users import DEMO_ACCOUNTS, DEMO_IDS
from payops.auth.password import hash_password, verify_password
from payops.auth.secret_box import open_secret, seal_secret
from payops.auth.tokens import SessionConfig, sign_mfa_challenge, sign_session, verify_mfa_challenge, verify_session
from payops.auth.totp import base32_decode, base32_encode, generate_totp_secret, otpauth_url, totp_code, verify_totp

V = json.loads((Path(__file__).parent / "fixtures" / "auth_vectors.json").read_text())
CONFIG = SessionConfig(secret=V["jwtSecret"], secure=False)


def _issued(token: str) -> datetime:
    return datetime.fromtimestamp(jwt.decode(token, options={"verify_signature": False})["iat"], tz=UTC)


def test_a_password_hashed_by_typescript_verifies_and_a_wrong_one_does_not() -> None:
    assert verify_password(V["password"], V["passwordHash"])
    assert not verify_password("wrong", V["passwordHash"])


def test_a_password_hashed_here_has_the_same_format_and_verifies() -> None:
    stored = hash_password("payops-demo")
    scheme, salt, digest = stored.split("$")
    assert scheme == "scrypt" and len(salt) == 24 and len(digest) == 88
    assert verify_password("payops-demo", stored) and not verify_password("Payops-demo", stored)


def test_malformed_hashes_fail_instead_of_raising() -> None:
    for bad in ("", "nope", "scrypt$AAAA$AAAA", "bcrypt$a$b", "scrypt$$"):
        assert not verify_password("x", bad)


def test_a_seed_sealed_by_typescript_opens_here_and_the_reverse() -> None:
    key = CONFIG.seal_key
    assert open_secret(V["sealed"], key) == V["totpSecret"]
    assert open_secret(V["sealed"], "another key") is None
    assert open_secret(seal_secret("JBSWY3DPEHPK3PXP", key), key) == "JBSWY3DPEHPK3PXP"


def test_a_changed_or_foreign_sealed_value_does_not_open() -> None:
    v, iv, data, tag = V["sealed"].split("$")
    assert open_secret("$".join([v, iv, data, "A" * len(tag)]), CONFIG.seal_key) is None
    assert open_secret("v2$a$b$c", CONFIG.seal_key) is None
    assert open_secret("garbage", CONFIG.seal_key) is None


def test_one_time_codes_match_the_typescript_codes() -> None:
    for case in V["codes"]:
        assert totp_code(V["totpSecret"], case["ms"]) == case["code"]


def test_rfc_6238_reference_code() -> None:
    # RFC 6238 appendix B: secret "12345678901234567890", T=59 gives 94287082 with 8 digits (SHA-1).
    assert totp_code(base32_encode(b"12345678901234567890"), 59_000, digits=8) == "94287082"


def test_a_code_is_accepted_within_one_step_and_only_once() -> None:
    secret, now = V["totpSecret"], 1_700_000_000_000
    code = totp_code(secret, now)
    step = verify_totp(secret, code, now)
    assert step is not None
    assert verify_totp(secret, code, now, last_used_step=step) is None  # no reuse
    assert verify_totp(secret, totp_code(secret, now - 30_000), now) is not None  # one step of drift
    assert verify_totp(secret, totp_code(secret, now - 90_000), now) is None
    assert verify_totp(secret, f"{code[:3]} {code[3:]}", now) == step  # spaces are fine
    assert verify_totp(secret, "12345", now) is None and verify_totp(secret, "abcdef", now) is None


def test_base32_round_trips_and_rejects_junk() -> None:
    seed = generate_totp_secret()
    assert len(seed) == 32 and base32_encode(base32_decode(seed)) == seed
    try:
        base32_decode("not base32 !!")
    except ValueError:
        return
    raise AssertionError("expected a ValueError")


def test_otpauth_link_matches_typescript() -> None:
    assert otpauth_url(V["totpSecret"], "ops@payops.dev", "PayOps AI") == V["otpauth"]


def test_a_session_cookie_made_by_typescript_is_accepted_here() -> None:
    claims = verify_session(V["sessionToken"], CONFIG, _issued(V["sessionToken"]))
    assert claims is not None
    assert (claims.user_id, claims.role, claims.session_id, claims.name, claims.email) == (
        "usr_1",
        "OPS",
        "ses_abc",
        "Ananya Rao",
        "ops@payops.dev",
    )


def test_a_session_cookie_made_here_has_the_same_claims() -> None:
    now = datetime.now(UTC)
    token = sign_session("usr_1", "OPS", "Ananya Rao", "ops@payops.dev", "ses_abc", CONFIG, now)
    mine = jwt.decode(token, CONFIG.key, algorithms=["HS256"], issuer="payops")
    theirs = jwt.decode(
        V["sessionToken"], CONFIG.key, algorithms=["HS256"], issuer="payops", options={"verify_exp": False}
    )
    assert set(mine) == set(theirs) and mine["exp"] - mine["iat"] == theirs["exp"] - theirs["iat"] == 8 * 3600
    assert jwt.get_unverified_header(token) == jwt.get_unverified_header(V["sessionToken"])


def test_expired_forged_and_garbage_cookies_are_refused() -> None:
    issued = _issued(V["sessionToken"])
    late = datetime.fromtimestamp(issued.timestamp() + 8 * 3600 + 1, tz=UTC)
    assert verify_session(V["sessionToken"], CONFIG, late) is None
    assert (
        verify_session(V["sessionToken"], SessionConfig("another-secret-that-is-long-enough-123", False), issued)
        is None
    )
    assert verify_session("garbage", CONFIG) is None and verify_session(None, CONFIG) is None
    assert (
        verify_session(V["challengeToken"], CONFIG, issued) is None
    )  # a challenge has no session id, so it is not a cookie


def test_mfa_challenge_round_trip_and_it_is_not_a_session() -> None:
    issued = _issued(V["challengeToken"])
    assert verify_mfa_challenge(V["challengeToken"], CONFIG, issued) == "usr_1"
    assert (
        verify_mfa_challenge(V["sessionToken"], CONFIG, _issued(V["sessionToken"])) is None
    )  # a session cookie is not a challenge
    mine = sign_mfa_challenge("usr_9", CONFIG, issued)
    assert verify_mfa_challenge(mine, CONFIG, issued) == "usr_9"
    assert verify_mfa_challenge(mine, CONFIG, datetime.fromtimestamp(issued.timestamp() + 301, tz=UTC)) is None


def test_demo_user_ids_match_the_ones_already_in_the_database() -> None:
    dump = json.loads(__import__("gzip").open(Path(__file__).parent / "contract" / "db.json.gz").read())["tables"][
        "users"
    ]
    stored = {u["email"]: u["id"] for u in dump}
    assert {a.email: DEMO_IDS[a.email] for a in DEMO_ACCOUNTS} == stored
