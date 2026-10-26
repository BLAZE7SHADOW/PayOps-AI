# pyright: reportArgumentType=false, reportCallIssue=false, reportOptionalSubscript=false
"""Sign-in over HTTP with real cookies (ports of apps/server auth.test.ts and auth-security.test.ts): password and demo sign-in, the code step, one-time use of
codes, guessing limits, sessions that can be revoked, role changes that apply at once, and the JSON-only rule."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest_asyncio
from sqlalchemy import select, update

from payops.api.app import create_app
from payops.auth.demo_users import DEMO_PASSWORD
from payops.auth.password import hash_password
from payops.auth.secret_box import open_secret
from payops.auth.tokens import SESSION_COOKIE, SessionConfig, sign_session
from payops.auth.totp import totp_code
from payops.db.engine import create_engine, session_factory
from payops.db.models import AuditEvent, Session, User
from payops.settings import Settings

JSON = {"content-type": "application/json"}
SECRET = "a-test-secret-of-sufficient-length"
CONFIG = SessionConfig(SECRET, False)


class Clock:
    """A clock the tests can move, so expiry and rate-limit windows can be crossed without waiting."""

    def __init__(self) -> None:
        self.moment = datetime.now(UTC)

    def now(self) -> datetime:
        return self.moment


@pytest_asyncio.fixture
async def world(seeded_url: str) -> AsyncIterator[tuple[httpx.AsyncClient, Clock, object]]:
    engine = create_engine(url=seeded_url, pool_size=5)
    clock = Clock()
    app = create_app(Settings(jwt_secret=SECRET), engine, clock=clock)
    async with app.router.lifespan_context(app):
        # Give every demo account the known demo password, as a deployed database has after the demo users are seeded.
        async with session_factory(engine)() as s, s.begin():
            await s.execute(update(User).values(password_hash=hash_password(DEMO_PASSWORD)))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", headers=JSON) as c:
            yield c, clock, app.state.services
    await engine.dispose()


async def sign_in(c: httpx.AsyncClient, email: str = "ops@payops.dev") -> httpx.Response:
    return await c.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})


def token_of(res: httpx.Response) -> str:
    return res.cookies[SESSION_COOKIE]


async def test_login_sets_an_httponly_cookie_and_me_returns_the_user(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    assert (await c.get("/api/auth/me")).status_code == 401
    res = await sign_in(c, "OPS@payops.dev")  # the email is lower-cased
    assert res.status_code == 200 and res.json()["role"] == "OPS" and res.json()["email"] == "ops@payops.dev"
    header = res.headers["set-cookie"].lower()
    assert "httponly" in header and "samesite=lax" in header and "max-age=28800" in header and "path=/" in header
    assert (await c.get("/api/auth/me")).json()["email"] == "ops@payops.dev"  # the client keeps the cookie
    assert (await c.get("/api/cases?limit=1")).status_code == 200


async def test_bad_credentials_get_one_generic_message(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    wrong = await c.post("/api/auth/login", json={"email": "ops@payops.dev", "password": "nope"})
    unknown = await c.post("/api/auth/login", json={"email": "nobody@payops.dev", "password": "nope"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["error"]["message"] == unknown.json()["error"]["message"] == "Email or password is incorrect"


async def test_eleven_attempts_in_a_minute_get_a_429_and_a_new_window_lets_you_in(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, _ = world
    statuses = [(await c.post("/api/auth/login", json={"email": "ops@payops.dev", "password": "nope"})).status_code for _ in range(11)]
    assert statuses[:10] == [401] * 10 and statuses[10] == 429
    clock.moment += timedelta(seconds=61)
    assert (await sign_in(c)).status_code == 200


async def test_demo_sign_in_lists_the_accounts_and_refuses_anyone_else(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    assert {a["email"] for a in (await c.get("/api/auth/demo-accounts")).json()} >= {"ops@payops.dev", "admin@payops.dev"}
    ok = await c.post("/api/auth/demo-login", json={"email": "manager@payops.dev"})
    assert ok.status_code == 200 and ok.json()["role"] == "MANAGER"
    assert (await c.post("/api/auth/demo-login", json={"email": "stranger@payops.dev"})).status_code == 401


async def test_state_changing_requests_must_be_json(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    res = await c.post("/api/auth/login", content="email=ops@payops.dev&password=x", headers={"content-type": "application/x-www-form-urlencoded"})
    assert res.status_code == 415 and res.json()["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"
    assert (await c.get("/api/auth/me", headers={"content-type": "text/plain"})).status_code == 401  # reads are not constrained


async def test_logout_revokes_the_session_on_the_server_so_a_copied_cookie_stops_working(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    cookie = token_of(await sign_in(c))
    assert (await c.post("/api/auth/logout")).status_code == 200
    copied = httpx.Cookies()
    copied.set(SESSION_COOKIE, cookie)
    assert (await c.get("/api/auth/me", cookies=copied)).status_code == 401


async def test_an_expired_session_is_refused_even_though_the_signature_is_valid(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    cookie = token_of(await sign_in(c))
    async with services.sessions() as s, s.begin():
        await s.execute(update(Session).values(expires_at=clock.moment - timedelta(seconds=1)))
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: cookie})).status_code == 401


async def test_forged_and_garbage_cookies_are_refused(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    forged = sign_session("usr_81cv7z92n81hk7", "ADMIN", "Ananya Rao", "ops@payops.dev", "ses_made_up", SessionConfig("another-secret-that-is-long-enough-123", False))
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: forged})).status_code == 401
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: "garbage"})).status_code == 401
    unknown_session = sign_session("usr_81cv7z92n81hk7", "ADMIN", "x", "ops@payops.dev", "ses_made_up", CONFIG)
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: unknown_session})).status_code == 401  # signed correctly, but no such session row


async def test_sessions_are_listed_and_others_can_be_signed_out(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    first = token_of(await sign_in(c))
    second = token_of(await sign_in(c))
    overview = (await c.get("/api/auth/security", cookies={SESSION_COOKIE: second})).json()
    assert overview["mfaEnabled"] is False and overview["mfaRecommended"] is False and len(overview["sessions"]) == 2
    assert [s["current"] for s in overview["sessions"]].count(True) == 1
    out = await c.post("/api/auth/sessions/revoke-others", cookies={SESSION_COOKIE: second})
    assert out.json() == {"revoked": 1}
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: first})).status_code == 401
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: second})).status_code == 200


async def test_someone_elses_session_looks_missing_to_an_analyst_and_an_admin_can_revoke_it(world) -> None:  # type: ignore[no-untyped-def]
    c, _, services = world
    ops = token_of(await sign_in(c, "ops@payops.dev"))
    admin = token_of(await sign_in(c, "admin@payops.dev"))
    async with services.sessions() as s:
        ops_session = (await s.scalars(select(Session.id).where(Session.user_id == "usr_81cv7z92n81hk7"))).first()
        sid = {x["id"]: x for x in (await c.get("/api/auth/security", cookies={SESSION_COOKIE: ops})).json()["sessions"]}
    assert ops_session in sid
    other = (await c.get("/api/auth/security", cookies={SESSION_COOKIE: admin})).json()["sessions"][0]["id"]
    assert (await c.post(f"/api/auth/sessions/{other}/revoke", cookies={SESSION_COOKIE: ops})).status_code == 404
    assert (await c.post(f"/api/auth/sessions/{ops_session}/revoke", cookies={SESSION_COOKIE: admin})).json() == {"revoked": True}
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: ops})).status_code == 401


async def test_an_admin_can_sign_a_user_out_everywhere_and_an_analyst_cannot(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    ops = token_of(await sign_in(c, "ops@payops.dev"))
    admin = token_of(await sign_in(c, "admin@payops.dev"))
    assert (await c.post("/api/auth/users/usr_m3e4bbsmtc0d9m/sessions/revoke", cookies={SESSION_COOKIE: ops})).status_code == 403
    res = await c.post("/api/auth/users/usr_81cv7z92n81hk7/sessions/revoke", cookies={SESSION_COOKIE: admin})
    assert res.json() == {"revoked": 1}
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: ops})).status_code == 401


async def test_a_role_change_applies_on_the_next_request(world) -> None:  # type: ignore[no-untyped-def]
    c, _, services = world
    cookie = token_of(await sign_in(c, "ops@payops.dev"))
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: cookie})).json()["role"] == "OPS"
    async with services.sessions() as s, s.begin():
        await s.execute(update(User).where(User.id == "usr_81cv7z92n81hk7").values(role="VIEWER"))
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: cookie})).json()["role"] == "VIEWER"
    assert (await c.post("/api/cases/case_w3wryfpvbpyt13/notes", json={"text": "hi"}, cookies={SESSION_COOKIE: cookie})).status_code == 403


async def enrol(c: httpx.AsyncClient, clock: Clock, services, cookie: str) -> str:  # type: ignore[no-untyped-def]
    """Turns MFA on for the signed-in user and returns the seed."""
    setup = await c.post("/api/auth/mfa/setup", cookies={SESSION_COOKIE: cookie})
    secret = setup.json()["secret"]
    assert setup.json()["otpauthUrl"].startswith("otpauth://totp/PayOps%20AI%3A")
    enable = await c.post("/api/auth/mfa/enable", json={"code": totp_code(secret, clock.moment.timestamp() * 1000)}, cookies={SESSION_COOKIE: cookie})
    assert enable.status_code == 200 and enable.json()["mfaEnabled"] is True
    return secret


async def test_mfa_setup_stores_the_seed_encrypted_and_enable_needs_a_correct_code(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    cookie = token_of(await sign_in(c, "manager@payops.dev"))
    assert (await c.get("/api/auth/security", cookies={SESSION_COOKIE: cookie})).json()["mfaRecommended"] is True
    secret = (await c.post("/api/auth/mfa/setup", cookies={SESSION_COOKIE: cookie})).json()["secret"]
    async with services.sessions() as s:
        stored = (await s.scalars(select(User.totp_secret_sealed).where(User.email == "manager@payops.dev"))).one()
    assert stored != secret and secret not in stored and open_secret(stored, CONFIG.seal_key) == secret
    wrong = await c.post("/api/auth/mfa/enable", json={"code": "000000"}, cookies={SESSION_COOKIE: cookie})
    assert wrong.status_code == 422
    assert (await c.get("/api/auth/security", cookies={SESSION_COOKIE: cookie})).json()["mfaEnabled"] is False
    ok = await c.post("/api/auth/mfa/enable", json={"code": totp_code(secret, clock.moment.timestamp() * 1000)}, cookies={SESSION_COOKIE: cookie})
    assert ok.status_code == 200
    assert (await c.post("/api/auth/mfa/setup", cookies={SESSION_COOKIE: cookie})).status_code == 409  # already on
    audit = (await c.get("/api/audit?entityId=" + "usr_3t6ty5cke43ngr", cookies={SESSION_COOKIE: cookie})).json()["items"]
    assert any(a["action"] == "auth.mfa_enabled" for a in audit)


async def test_enabling_mfa_signs_out_other_browsers_and_keeps_the_current_one(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    here = token_of(await sign_in(c, "manager@payops.dev"))
    elsewhere = token_of(await sign_in(c, "manager@payops.dev"))
    await enrol(c, clock, services, here)
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: here})).status_code == 200
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: elsewhere})).status_code == 401


async def test_sign_in_with_a_code_gives_no_session_until_the_code_is_right(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    secret = await enrol(c, clock, services, token_of(await sign_in(c, "manager@payops.dev")))
    c.cookies.clear()
    step1 = await sign_in(c, "manager@payops.dev")
    assert step1.status_code == 200 and step1.json()["mfaRequired"] is True and SESSION_COOKIE not in step1.cookies
    challenge = step1.json()["challenge"]
    assert (await c.post("/api/auth/login/mfa", json={"challenge": challenge, "code": "000000"})).status_code == 401
    clock.moment += timedelta(seconds=30)  # the enrolment used this step; the next code is a new one
    code = totp_code(secret, clock.moment.timestamp() * 1000)
    ok = await c.post("/api/auth/login/mfa", json={"challenge": challenge, "code": code})
    assert ok.status_code == 200 and ok.json()["role"] == "MANAGER"
    assert (await c.get("/api/auth/me")).status_code == 200
    again = await c.post("/api/auth/login/mfa", json={"challenge": challenge, "code": code})
    assert again.status_code == 401  # a code is accepted once


async def test_a_wrong_password_never_reaches_the_code_step_and_demo_sign_in_asks_for_the_code_too(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    await enrol(c, clock, services, token_of(await sign_in(c, "manager@payops.dev")))
    c.cookies.clear()
    bad = await c.post("/api/auth/login", json={"email": "manager@payops.dev", "password": "nope"})
    assert bad.status_code == 401 and "challenge" not in bad.text
    demo = await c.post("/api/auth/demo-login", json={"email": "manager@payops.dev"})
    assert demo.json()["mfaRequired"] is True and SESSION_COOKIE not in demo.cookies


async def test_a_challenge_is_not_a_cookie_and_a_cookie_is_not_a_challenge(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    cookie = token_of(await sign_in(c, "manager@payops.dev"))
    secret = await enrol(c, clock, services, cookie)
    challenge = (await sign_in(c, "manager@payops.dev")).json()["challenge"]
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: challenge})).status_code == 401
    clock.moment += timedelta(seconds=30)
    code = totp_code(secret, clock.moment.timestamp() * 1000)
    res = await c.post("/api/auth/login/mfa", json={"challenge": cookie, "code": code})
    assert res.status_code == 401 and "expired" in res.json()["error"]["message"]


async def test_five_wrong_codes_then_even_the_right_one_is_refused_for_a_while(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    secret = await enrol(c, clock, services, token_of(await sign_in(c, "manager@payops.dev")))
    challenge = (await sign_in(c, "manager@payops.dev")).json()["challenge"]
    for _ in range(4):  # enrolling counted as the first attempt, so the sixth in all is refused
        assert (await c.post("/api/auth/login/mfa", json={"challenge": challenge, "code": "000000"})).status_code == 401
    clock.moment += timedelta(seconds=30)
    right = totp_code(secret, clock.moment.timestamp() * 1000)
    assert (await c.post("/api/auth/login/mfa", json={"challenge": challenge, "code": right})).status_code == 429
    clock.moment += timedelta(minutes=6)
    # the challenge itself lasts five minutes, so sign in again for a fresh one
    fresh = (await sign_in(c, "manager@payops.dev")).json()["challenge"]
    clock.moment += timedelta(seconds=30)
    assert (await c.post("/api/auth/login/mfa", json={"challenge": fresh, "code": totp_code(secret, clock.moment.timestamp() * 1000)})).status_code == 200


async def test_turning_mfa_off_needs_a_valid_code_and_password_only_sign_in_works_again(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    cookie = token_of(await sign_in(c, "manager@payops.dev"))
    secret = await enrol(c, clock, services, cookie)
    assert (await c.post("/api/auth/mfa/disable", json={"code": "000000"}, cookies={SESSION_COOKIE: cookie})).status_code == 422
    clock.moment += timedelta(seconds=30)
    off = await c.post("/api/auth/mfa/disable", json={"code": totp_code(secret, clock.moment.timestamp() * 1000)}, cookies={SESSION_COOKIE: cookie})
    assert off.json() == {"mfaEnabled": False}
    assert "id" in (await sign_in(c, "manager@payops.dev")).json()
    async with services.sessions() as s:
        actions = set((await s.scalars(select(AuditEvent.action).where(AuditEvent.entity_id == "usr_3t6ty5cke43ngr"))).all())
    assert {"auth.mfa_enabled", "auth.mfa_disabled"} <= actions


async def test_an_admin_can_reset_a_lost_device(world) -> None:  # type: ignore[no-untyped-def]
    c, clock, services = world
    manager = token_of(await sign_in(c, "manager@payops.dev"))
    await enrol(c, clock, services, manager)
    admin = token_of(await sign_in(c, "admin@payops.dev"))
    assert (await c.post("/api/auth/users/usr_3t6ty5cke43ngr/mfa/reset", cookies={SESSION_COOKIE: manager})).status_code == 403
    res = await c.post("/api/auth/users/usr_3t6ty5cke43ngr/mfa/reset", cookies={SESSION_COOKIE: admin})
    assert res.json() == {"mfaEnabled": False, "sessionsRevoked": 1}
    assert (await c.get("/api/auth/me", cookies={SESSION_COOKIE: manager})).status_code == 401
    assert "id" in (await sign_in(c, "manager@payops.dev")).json()
    assert (await c.post("/api/auth/users/usr_nope/mfa/reset", cookies={SESSION_COOKIE: admin})).status_code == 404


async def test_every_mfa_and_session_route_needs_a_sign_in(world) -> None:  # type: ignore[no-untyped-def]
    c, _, _ = world
    for method, path in (("GET", "/api/auth/security"), ("POST", "/api/auth/mfa/setup"), ("POST", "/api/auth/mfa/enable"), ("POST", "/api/auth/mfa/disable"),
                         ("POST", "/api/auth/sessions/revoke-others"), ("POST", "/api/auth/sessions/ses_x/revoke")):
        res = await c.request(method, path, json={"code": "123456"} if "mfa" in path else None)
        assert res.status_code == 401, path
