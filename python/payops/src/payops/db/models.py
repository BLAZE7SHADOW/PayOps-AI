"""SQLAlchemy models for the 35 tables (generated from the migrated schema, then tidied).

Column names are the database's snake_case. The JSON the web app sees is camelCase and is produced by the DTO layer, not
here. The models are dataclasses, so tests build rows directly without a database. JSONB columns are typed `Any`; their
shapes are checked by the DTOs that read and write them. `tests/test_models.py` fails if a model and a migration drift
apart."""

import datetime
from typing import Any

from sqlalchemy import (
    REAL,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    Text,
    UniqueConstraint,
)
from sqlalchemy import text as sa_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, MappedAsDataclass, mapped_column


class Base(MappedAsDataclass, DeclarativeBase):
    pass


class AgentControl(Base):
    __tablename__ = "agent_controls"
    __table_args__ = (PrimaryKeyConstraint("id", name="agent_controls_pkey"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    changed_by_id: Mapped[str] = mapped_column(Text, nullable=False)
    changed_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="audit_events_pkey"),
        Index("audit_events_at_index", "at"),
        Index("audit_events_case_id_index", "case_id"),
        Index("audit_events_entity_id_index", "entity_id"),
        Index("audit_events_seq_index", "seq", unique=True),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False, server_default=sa_text("now()"))
    actor_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(Text, nullable=False)
    actor_name: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    prev_hash: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    hash: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    before: Mapped[Any | None] = mapped_column(JSONB)
    after: Mapped[Any | None] = mapped_column(JSONB)
    run_id: Mapped[str | None] = mapped_column(Text)
    case_id: Mapped[str | None] = mapped_column(Text)


class AuthRateLimit(Base):
    __tablename__ = "auth_rate_limits"
    __table_args__ = (PrimaryKeyConstraint("key", name="auth_rate_limits_pkey"),)

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False)
    reset_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)


class Counter(Base):
    __tablename__ = "counters"
    __table_args__ = (PrimaryKeyConstraint("id", name="counters_pkey"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)


class Customer(Base):
    __tablename__ = "customers"
    __table_args__ = (PrimaryKeyConstraint("id", name="customers_pkey"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email_masked: Mapped[str] = mapped_column(Text, nullable=False)
    phone_masked: Mapped[str] = mapped_column(Text, nullable=False)
    risk_flags: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class Dispute(Base):
    __tablename__ = "disputes"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="disputes_pkey"),
        Index("disputes_batch_id_index", "batch_id"),
        Index("disputes_one_open_per_batch_uq", "batch_id", postgresql_where="(status = 'OPEN'::text)", unique=True),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    batch_id: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    gw_payment_id: Mapped[str | None] = mapped_column(Text)
    resolution_id: Mapped[str | None] = mapped_column(Text)


class GwPayment(Base):
    __tablename__ = "gw_payments"
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="gw_payments_amount_positive"),
        PrimaryKeyConstraint("id", name="gw_payments_pkey"),
        Index("gw_payments_created_at_index", "created_at"),
        Index("gw_payments_order_ref_index", "order_ref"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    order_ref: Mapped[str] = mapped_column(Text, nullable=False)
    merchant_id: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("'INR'::text"))
    status: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    refunded_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=sa_text("0"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    card: Mapped[Any | None] = mapped_column(JSONB)
    captured_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="ledger_amount_positive"),
        PrimaryKeyConstraint("id", name="ledger_entries_pkey"),
        Index("ledger_entries_journal_id_index", "journal_id"),
        Index("ledger_entries_payment_id_index", "payment_id"),
        Index("ledger_entries_refund_id_index", "refund_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    journal_id: Mapped[str] = mapped_column(Text, nullable=False)
    merchant_id: Mapped[str] = mapped_column(Text, nullable=False)
    account: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    posted_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    memo: Mapped[str] = mapped_column(Text, nullable=False)
    payment_id: Mapped[str | None] = mapped_column(Text)
    refund_id: Mapped[str | None] = mapped_column(Text)
    batch_id: Mapped[str | None] = mapped_column(Text)
    reversal_of: Mapped[str | None] = mapped_column(Text)


class Merchant(Base):
    __tablename__ = "merchants"
    __table_args__ = (PrimaryKeyConstraint("id", name="merchants_pkey"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    fee_bps: Mapped[int] = mapped_column(Integer, nullable=False)
    fee_fixed_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=sa_text("0"))
    tax_bps: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("1800"))
    settlement_cycle_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("1"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class SupportNote(Base):
    __tablename__ = "support_notes"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="support_notes_pkey"),
        Index("support_notes_order_id_index", "order_id"),
        Index("support_notes_payment_id_index", "payment_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    author_type: Mapped[str] = mapped_column(Text, nullable=False)
    text_: Mapped[str] = mapped_column("text", Text, nullable=False)
    quarantined: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    payment_id: Mapped[str | None] = mapped_column(Text)
    order_id: Mapped[str | None] = mapped_column(Text)
    complaint_type: Mapped[str | None] = mapped_column(Text)
    urgent: Mapped[bool | None] = mapped_column(Boolean)
    injection_probability: Mapped[float | None] = mapped_column(REAL)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="users_pkey"),
        UniqueConstraint("email", name="users_email_unique"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    totp_secret_sealed: Mapped[str | None] = mapped_column(Text)
    totp_enabled_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))
    totp_last_step: Mapped[int | None] = mapped_column(Integer)


class WebhookEvent(Base):
    __tablename__ = "webhook_events"
    __table_args__ = (
        PrimaryKeyConstraint("id", name="webhook_events_pkey"),
        Index("webhook_events_gw_payment_id_index", "gw_payment_id"),
        Index("webhook_events_status_updated_at_index", "status", "updated_at"),
        Index("webhook_events_updated_at_index", "updated_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    event: Mapped[str] = mapped_column(Text, nullable=False)
    gw_payment_id: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[Any] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    last_message: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    first_received_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    gw_refund_id: Mapped[str | None] = mapped_column(Text)
    last_http_status: Mapped[int | None] = mapped_column(Integer)
    next_retry_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))


class Case(Base):
    __tablename__ = "cases"
    __table_args__ = (
        ForeignKeyConstraint(["assignee_id"], ["users.id"], name="cases_assignee_id_users_id_fk"),
        PrimaryKeyConstraint("id", name="cases_pkey"),
        UniqueConstraint("display_id", name="cases_displayId_unique"),
        Index(
            "cases_open_fingerprint_uq",
            "fingerprint",
            postgresql_where="(status <> ALL (ARRAY['RESOLVED'::text, 'REJECTED'::text]))",
            unique=True,
        ),
        Index("cases_payment_ref_idx"),
        Index("cases_status_priority_opened_at_index", "status", "priority", "opened_at"),
        Index("cases_type_index", "type"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    display_id: Mapped[str] = mapped_column(Text, nullable=False)
    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    rule_ids: Mapped[Any] = mapped_column(JSONB, nullable=False)
    matrix: Mapped[Any] = mapped_column(JSONB, nullable=False)
    mismatched: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    entity_refs: Mapped[Any] = mapped_column(JSONB, nullable=False)
    signals: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'{}'::jsonb"))
    last_detected_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    opened_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    assignee_id: Mapped[str | None] = mapped_column(Text)
    active_run_id: Mapped[str | None] = mapped_column(Text)
    resolution: Mapped[Any | None] = mapped_column(JSONB)
    resolved_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))
    due_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (
        ForeignKeyConstraint(["customer_id"], ["customers.id"], name="devices_customer_id_customers_id_fk"),
        PrimaryKeyConstraint("id", name="devices_pkey"),
        Index("devices_customer_id_index", "customer_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    customer_id: Mapped[str] = mapped_column(Text, nullable=False)
    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    ip_country: Mapped[str] = mapped_column(Text, nullable=False)
    first_seen_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)


class GwRefund(Base):
    __tablename__ = "gw_refunds"
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="gw_refunds_amount_positive"),
        ForeignKeyConstraint(["gw_payment_id"], ["gw_payments.id"], name="gw_refunds_gw_payment_id_gw_payments_id_fk"),
        PrimaryKeyConstraint("id", name="gw_refunds_pkey"),
        Index("gw_refunds_gw_payment_id_index", "gw_payment_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    gw_payment_id: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    processed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))


class GwSettlementLine(Base):
    __tablename__ = "gw_settlement_lines"
    __table_args__ = (
        ForeignKeyConstraint(
            ["gw_payment_id"], ["gw_payments.id"], name="gw_settlement_lines_gw_payment_id_gw_payments_id_fk"
        ),
        PrimaryKeyConstraint("id", name="gw_settlement_lines_pkey"),
        Index("gw_settlement_lines_batch_id_index", "batch_id"),
        Index("gw_settlement_lines_gw_payment_id_index", "gw_payment_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    batch_id: Mapped[str] = mapped_column(Text, nullable=False)
    merchant_id: Mapped[str] = mapped_column(Text, nullable=False)
    gw_payment_id: Mapped[str] = mapped_column(Text, nullable=False)
    gross_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    fee_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tax_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    net_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    settled_on: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class GwWebhookDelivery(Base):
    __tablename__ = "gw_webhook_deliveries"
    __table_args__ = (
        ForeignKeyConstraint(
            ["gw_payment_id"], ["gw_payments.id"], name="gw_webhook_deliveries_gw_payment_id_gw_payments_id_fk"
        ),
        PrimaryKeyConstraint("id", name="gw_webhook_deliveries_pkey"),
        Index("gw_webhook_deliveries_gw_payment_id_index", "gw_payment_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    event: Mapped[str] = mapped_column(Text, nullable=False)
    gw_payment_id: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    final_status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    gw_refund_id: Mapped[str | None] = mapped_column(Text)


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="orders_amount_positive"),
        ForeignKeyConstraint(["customer_id"], ["customers.id"], name="orders_customer_id_customers_id_fk"),
        ForeignKeyConstraint(["merchant_id"], ["merchants.id"], name="orders_merchant_id_merchants_id_fk"),
        PrimaryKeyConstraint("id", name="orders_pkey"),
        Index("orders_created_at_index", "created_at"),
        Index("orders_customer_id_index", "customer_id"),
        Index("orders_status_index", "status"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    merchant_id: Mapped[str] = mapped_column(Text, nullable=False)
    customer_id: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    timeline: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    payment_id: Mapped[str | None] = mapped_column(Text)
    locked_reason: Mapped[str | None] = mapped_column(Text)


class PaymentAttempt(Base):
    __tablename__ = "payment_attempts"
    __table_args__ = (
        ForeignKeyConstraint(["customer_id"], ["customers.id"], name="payment_attempts_customer_id_customers_id_fk"),
        PrimaryKeyConstraint("id", name="payment_attempts_pkey"),
        Index("payment_attempts_customer_id_at_index", "customer_id", "at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    customer_id: Mapped[str] = mapped_column(Text, nullable=False)
    device_id: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    result: Mapped[str] = mapped_column(Text, nullable=False)
    at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    order_id: Mapped[str | None] = mapped_column(Text)
    failure_code: Mapped[str | None] = mapped_column(Text)
    card_country: Mapped[str | None] = mapped_column(Text)


class SavedView(Base):
    __tablename__ = "saved_views"
    __table_args__ = (
        ForeignKeyConstraint(["owner_id"], ["users.id"], name="saved_views_owner_id_users_id_fk"),
        PrimaryKeyConstraint("id", name="saved_views_pkey"),
        Index("saved_views_owner_id_name_index", "owner_id", "name", unique=True),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    filters: Mapped[Any] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        ForeignKeyConstraint(["user_id"], ["users.id"], name="sessions_user_id_users_id_fk"),
        PrimaryKeyConstraint("id", name="sessions_pkey"),
        Index("sessions_user_id_revoked_at_index", "user_id", "revoked_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    last_seen_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    ip: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    user_agent: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    mfa_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))


class Settlement(Base):
    __tablename__ = "settlements"
    __table_args__ = (
        ForeignKeyConstraint(["merchant_id"], ["merchants.id"], name="settlements_merchant_id_merchants_id_fk"),
        PrimaryKeyConstraint("id", name="settlements_pkey"),
        Index("settlements_merchant_id_settled_on_index", "merchant_id", "settled_on"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    merchant_id: Mapped[str] = mapped_column(Text, nullable=False)
    settled_on: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    payment_ids: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    expected_net_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reported_net_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class CaseNote(Base):
    __tablename__ = "case_notes"
    __table_args__ = (
        ForeignKeyConstraint(["case_id"], ["cases.id"], name="case_notes_case_id_cases_id_fk"),
        PrimaryKeyConstraint("id", name="case_notes_pkey"),
        Index("case_notes_case_id_created_at_index", "case_id", "created_at"),
        Index("case_notes_created_at_index", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    text_: Mapped[str] = mapped_column("text", Text, nullable=False)
    author_id: Mapped[str] = mapped_column(Text, nullable=False)
    author_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (
        ForeignKeyConstraint(["customer_id"], ["customers.id"], name="payments_customer_id_customers_id_fk"),
        ForeignKeyConstraint(["merchant_id"], ["merchants.id"], name="payments_merchant_id_merchants_id_fk"),
        ForeignKeyConstraint(["order_id"], ["orders.id"], name="payments_order_id_orders_id_fk"),
        PrimaryKeyConstraint("id", name="payments_pkey"),
        UniqueConstraint("gw_payment_id", name="payments_gwPaymentId_unique"),
        Index("payments_created_at_id_index", "created_at", "id"),
        Index("payments_customer_id_index", "customer_id"),
        Index("payments_mismatch_created_at_index", "mismatch", "created_at"),
        Index("payments_order_id_index", "order_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    gw_payment_id: Mapped[str] = mapped_column(Text, nullable=False)
    order_id: Mapped[str] = mapped_column(Text, nullable=False)
    merchant_id: Mapped[str] = mapped_column(Text, nullable=False)
    customer_id: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    hold: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    mismatch: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    recon: Mapped[Any | None] = mapped_column(JSONB)


class Resolution(Base):
    __tablename__ = "resolutions"
    __table_args__ = (
        ForeignKeyConstraint(["case_id"], ["cases.id"], name="resolutions_case_id_cases_id_fk"),
        PrimaryKeyConstraint("id", name="resolutions_pkey"),
        Index("resolutions_case_id_created_at_index", "case_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    actions: Mapped[Any] = mapped_column(JSONB, nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    proposed_by: Mapped[Any] = mapped_column(JSONB, nullable=False)
    policy: Mapped[Any] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    run_id: Mapped[str | None] = mapped_column(Text)


class AgentRun(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        ForeignKeyConstraint(["case_id"], ["cases.id"], name="agent_runs_case_id_cases_id_fk"),
        ForeignKeyConstraint(["resolution_id"], ["resolutions.id"], name="agent_runs_resolution_id_resolutions_id_fk"),
        PrimaryKeyConstraint("id", name="agent_runs_pkey"),
        Index("agent_runs_case_id_created_at_index", "case_id", "created_at"),
        Index("agent_runs_status_index", "status"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("1"))
    budget: Mapped[Any] = mapped_column(JSONB, nullable=False)
    evidence: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    findings: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    resolution_id: Mapped[str | None] = mapped_column(Text)
    approval_id: Mapped[str | None] = mapped_column(Text)
    path: Mapped[str | None] = mapped_column(Text)
    scenario_key: Mapped[str | None] = mapped_column(Text)
    diagnosis: Mapped[Any | None] = mapped_column(JSONB)
    proposal: Mapped[Any | None] = mapped_column(JSONB)
    policy: Mapped[Any | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    finished_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))
    grounding: Mapped[Any | None] = mapped_column(JSONB)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (
        ForeignKeyConstraint(["case_id"], ["cases.id"], name="approvals_case_id_cases_id_fk"),
        ForeignKeyConstraint(["resolution_id"], ["resolutions.id"], name="approvals_resolution_id_resolutions_id_fk"),
        PrimaryKeyConstraint("id", name="approvals_pkey"),
        UniqueConstraint("resolution_id", name="approvals_resolutionId_unique"),
        Index(
            "approvals_one_pending_per_case_uq", "case_id", postgresql_where="(status = 'PENDING'::text)", unique=True
        ),
        Index("approvals_status_requested_at_index", "status", "requested_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    resolution_id: Mapped[str] = mapped_column(Text, nullable=False)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    tier: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    requested_by: Mapped[Any] = mapped_column(JSONB, nullable=False)
    requested_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    decided_by: Mapped[Any | None] = mapped_column(JSONB)
    comment: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))


class Execution(Base):
    __tablename__ = "executions"
    __table_args__ = (
        ForeignKeyConstraint(["resolution_id"], ["resolutions.id"], name="executions_resolution_id_resolutions_id_fk"),
        PrimaryKeyConstraint("id", name="executions_pkey"),
        UniqueConstraint("idempotency_key", name="executions_idempotencyKey_unique"),
        Index("executions_resolution_id_action_index_index", "resolution_id", "action_index"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    resolution_id: Mapped[str] = mapped_column(Text, nullable=False)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    action_index: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[Any] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    started_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    result: Mapped[Any | None] = mapped_column(JSONB)
    error: Mapped[Any | None] = mapped_column(JSONB)
    finished_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(True))
    before: Mapped[Any | None] = mapped_column(JSONB)


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="refunds_amount_positive"),
        ForeignKeyConstraint(["payment_id"], ["payments.id"], name="refunds_payment_id_payments_id_fk"),
        PrimaryKeyConstraint("id", name="refunds_pkey"),
        Index("refunds_gw_payment_id_index", "gw_payment_id"),
        Index("refunds_gw_refund_id_index", "gw_refund_id"),
        Index("refunds_payment_id_index", "payment_id"),
        Index("refunds_status_index", "status"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    requested_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    gw_payment_id: Mapped[str] = mapped_column(Text, nullable=False)
    payment_id: Mapped[str | None] = mapped_column(Text)
    gw_refund_id: Mapped[str | None] = mapped_column(Text)


class ValidationResult(Base):
    __tablename__ = "validation_results"
    __table_args__ = (
        ForeignKeyConstraint(
            ["resolution_id"], ["resolutions.id"], name="validation_results_resolution_id_resolutions_id_fk"
        ),
        PrimaryKeyConstraint("id", name="validation_results_pkey"),
        Index("validation_results_resolution_id_at_index", "resolution_id", "at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    resolution_id: Mapped[str] = mapped_column(Text, nullable=False)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    checks: Mapped[Any] = mapped_column(JSONB, nullable=False)
    at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)


class AgentFinding(Base):
    __tablename__ = "agent_findings"
    __table_args__ = (
        ForeignKeyConstraint(["case_id"], ["cases.id"], name="agent_findings_case_id_cases_id_fk"),
        ForeignKeyConstraint(["run_id"], ["agent_runs.id"], name="agent_findings_run_id_agent_runs_id_fk"),
        PrimaryKeyConstraint("id", name="agent_findings_pkey"),
        Index("agent_findings_run_finding_uq", "run_id", "finding_id", unique=True),
        Index("agent_findings_run_id_index", "run_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(Text, nullable=False)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    finding_id: Mapped[str] = mapped_column(Text, nullable=False)
    agent: Mapped[str] = mapped_column(Text, nullable=False)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_ids: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'[]'::jsonb"))
    confidence: Mapped[float] = mapped_column(REAL, nullable=False)
    grounded: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("true"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )


class AgentStep(Base):
    __tablename__ = "agent_steps"
    __table_args__ = (
        ForeignKeyConstraint(["run_id"], ["agent_runs.id"], name="agent_steps_run_id_agent_runs_id_fk"),
        PrimaryKeyConstraint("id", name="agent_steps_pkey"),
        Index("agent_steps_run_id_seq_index", "run_id", "seq"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(Text, nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    node: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'{}'::jsonb"))
    at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False)


class DiagnosisFeedback(Base):
    __tablename__ = "diagnosis_feedback"
    __table_args__ = (
        ForeignKeyConstraint(["case_id"], ["cases.id"], name="diagnosis_feedback_case_id_cases_id_fk"),
        ForeignKeyConstraint(["run_id"], ["agent_runs.id"], name="diagnosis_feedback_run_id_agent_runs_id_fk"),
        PrimaryKeyConstraint("id", name="diagnosis_feedback_pkey"),
        Index("diagnosis_feedback_case_id_index", "case_id"),
        Index("diagnosis_feedback_run_id_given_by_id_index", "run_id", "given_by_id", unique=True),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(Text, nullable=False)
    case_id: Mapped[str] = mapped_column(Text, nullable=False)
    diagnosed_root_cause: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''::text"))
    given_by_id: Mapped[str] = mapped_column(Text, nullable=False)
    given_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
    correct_root_cause: Mapped[str | None] = mapped_column(Text)


class Evidence(Base):
    __tablename__ = "evidence"
    __table_args__ = (
        ForeignKeyConstraint(["run_id"], ["agent_runs.id"], name="evidence_run_id_agent_runs_id_fk"),
        PrimaryKeyConstraint("id", name="evidence_pkey"),
        Index("evidence_run_evidence_uq", "run_id", "evidence_id", unique=True),
        Index("evidence_run_id_index", "run_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_id: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    system: Mapped[str] = mapped_column(Text, nullable=False)
    entity_ref: Mapped[str] = mapped_column(Text, nullable=False)
    facts: Mapped[Any] = mapped_column(JSONB, nullable=False, server_default=sa_text("'{}'::jsonb"))
    step_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(True), nullable=False, server_default=sa_text("now()")
    )
