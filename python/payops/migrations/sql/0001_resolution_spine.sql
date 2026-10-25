CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"resolution_id" text NOT NULL,
	"case_id" text NOT NULL,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" jsonb NOT NULL,
	"decided_by" jsonb,
	"comment" text,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approvals_resolutionId_unique" UNIQUE("resolution_id")
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"batch_id" text NOT NULL,
	"gw_payment_id" text,
	"amount_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"resolution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"resolution_id" text NOT NULL,
	"case_id" text NOT NULL,
	"action_index" integer NOT NULL,
	"action" jsonb NOT NULL,
	"status" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "executions_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"run_id" text,
	"attempt" integer NOT NULL,
	"actions" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"proposed_by" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_results" (
	"id" text PRIMARY KEY NOT NULL,
	"resolution_id" text NOT NULL,
	"case_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"verdict" text NOT NULL,
	"checks" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refunds" ALTER COLUMN "payment_id" DROP NOT NULL;--> statement-breakpoint
-- Hand-edited: add nullable, backfill from the linked internal payment, then enforce NOT NULL,
-- so databases created by 0000_init that already hold refunds migrate cleanly.
ALTER TABLE "refunds" ADD COLUMN "gw_payment_id" text;--> statement-breakpoint
UPDATE "refunds" AS r SET "gw_payment_id" = p."gw_payment_id" FROM "payments" AS p WHERE p."id" = r."payment_id" AND r."gw_payment_id" IS NULL;--> statement-breakpoint
ALTER TABLE "refunds" ALTER COLUMN "gw_payment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_resolution_id_resolutions_id_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_resolution_id_resolutions_id_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_results" ADD CONSTRAINT "validation_results_resolution_id_resolutions_id_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_per_case_uq" ON "approvals" USING btree ("case_id") WHERE "approvals"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "approvals_status_requested_at_index" ON "approvals" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "disputes_batch_id_index" ON "disputes" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_one_open_per_batch_uq" ON "disputes" USING btree ("batch_id") WHERE "disputes"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "executions_resolution_id_action_index_index" ON "executions" USING btree ("resolution_id","action_index");--> statement-breakpoint
CREATE INDEX "resolutions_case_id_created_at_index" ON "resolutions" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "validation_results_resolution_id_at_index" ON "validation_results" USING btree ("resolution_id","at");--> statement-breakpoint
CREATE INDEX "refunds_gw_payment_id_index" ON "refunds" USING btree ("gw_payment_id");--> statement-breakpoint
CREATE INDEX "refunds_gw_refund_id_index" ON "refunds" USING btree ("gw_refund_id");