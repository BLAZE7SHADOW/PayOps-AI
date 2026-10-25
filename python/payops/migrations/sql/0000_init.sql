CREATE TABLE "gw_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_ref" text NOT NULL,
	"merchant_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text NOT NULL,
	"method" text NOT NULL,
	"card" jsonb,
	"captured_at" timestamp with time zone,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_payments_amount_positive" CHECK ("gw_payments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "gw_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"gw_payment_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_refunds_amount_positive" CHECK ("gw_refunds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "gw_settlement_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"gw_payment_id" text NOT NULL,
	"gross_minor" bigint NOT NULL,
	"fee_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"line_no" integer NOT NULL,
	"settled_on" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"gw_payment_id" text NOT NULL,
	"gw_refund_id" text,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email_masked" text NOT NULL,
	"phone_masked" text NOT NULL,
	"risk_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"ip_country" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_id" text NOT NULL,
	"payment_id" text,
	"refund_id" text,
	"batch_id" text,
	"merchant_id" text NOT NULL,
	"account" text NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"memo" text NOT NULL,
	"reversal_of" text,
	CONSTRAINT "ledger_amount_positive" CHECK ("ledger_entries"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_fixed_minor" bigint DEFAULT 0 NOT NULL,
	"tax_bps" integer DEFAULT 1800 NOT NULL,
	"settlement_cycle_days" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"payment_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"locked_reason" text,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_amount_positive" CHECK ("orders"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"device_id" text NOT NULL,
	"order_id" text,
	"amount_minor" bigint NOT NULL,
	"result" text NOT NULL,
	"failure_code" text,
	"card_country" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"gw_payment_id" text NOT NULL,
	"order_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"hold" boolean DEFAULT false NOT NULL,
	"recon" jsonb,
	"mismatch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_gwPaymentId_unique" UNIQUE("gw_payment_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"gw_refund_id" text,
	"amount_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"settled_on" timestamp with time zone NOT NULL,
	"payment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_net_minor" bigint NOT NULL,
	"reported_net_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text,
	"order_id" text,
	"author_type" text NOT NULL,
	"text" text NOT NULL,
	"complaint_type" text,
	"urgent" boolean,
	"injection_probability" real,
	"quarantined" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"run_id" text,
	"case_id" text
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"display_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"priority" integer NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"rule_ids" jsonb NOT NULL,
	"matrix" jsonb NOT NULL,
	"mismatched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entity_refs" jsonb NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignee_id" text,
	"active_run_id" text,
	"resolution" jsonb,
	"last_detected_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_displayId_unique" UNIQUE("display_id")
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "gw_refunds" ADD CONSTRAINT "gw_refunds_gw_payment_id_gw_payments_id_fk" FOREIGN KEY ("gw_payment_id") REFERENCES "public"."gw_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_settlement_lines" ADD CONSTRAINT "gw_settlement_lines_gw_payment_id_gw_payments_id_fk" FOREIGN KEY ("gw_payment_id") REFERENCES "public"."gw_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_webhook_deliveries" ADD CONSTRAINT "gw_webhook_deliveries_gw_payment_id_gw_payments_id_fk" FOREIGN KEY ("gw_payment_id") REFERENCES "public"."gw_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gw_payments_order_ref_index" ON "gw_payments" USING btree ("order_ref");--> statement-breakpoint
CREATE INDEX "gw_payments_created_at_index" ON "gw_payments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "gw_refunds_gw_payment_id_index" ON "gw_refunds" USING btree ("gw_payment_id");--> statement-breakpoint
CREATE INDEX "gw_settlement_lines_batch_id_index" ON "gw_settlement_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "gw_settlement_lines_gw_payment_id_index" ON "gw_settlement_lines" USING btree ("gw_payment_id");--> statement-breakpoint
CREATE INDEX "gw_webhook_deliveries_gw_payment_id_index" ON "gw_webhook_deliveries" USING btree ("gw_payment_id");--> statement-breakpoint
CREATE INDEX "devices_customer_id_index" ON "devices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_payment_id_index" ON "ledger_entries" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_refund_id_index" ON "ledger_entries" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_id_index" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "orders_status_index" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_customer_id_index" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_created_at_index" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_customer_id_at_index" ON "payment_attempts" USING btree ("customer_id","at");--> statement-breakpoint
CREATE INDEX "payments_order_id_index" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_customer_id_index" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payments_created_at_id_index" ON "payments" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "payments_mismatch_created_at_index" ON "payments" USING btree ("mismatch","created_at");--> statement-breakpoint
CREATE INDEX "refunds_payment_id_index" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_status_index" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "settlements_merchant_id_settled_on_index" ON "settlements" USING btree ("merchant_id","settled_on");--> statement-breakpoint
CREATE INDEX "support_notes_payment_id_index" ON "support_notes" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "support_notes_order_id_index" ON "support_notes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "audit_events_at_index" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_id_index" ON "audit_events" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_case_id_index" ON "audit_events" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_open_fingerprint_uq" ON "cases" USING btree ("fingerprint") WHERE "cases"."status" not in ('RESOLVED', 'REJECTED');--> statement-breakpoint
CREATE INDEX "cases_status_priority_opened_at_index" ON "cases" USING btree ("status","priority","opened_at");--> statement-breakpoint
CREATE INDEX "cases_type_index" ON "cases" USING btree ("type");--> statement-breakpoint
CREATE INDEX "cases_payment_ref_idx" ON "cases" USING btree (("entity_refs" ->> 'paymentId'));