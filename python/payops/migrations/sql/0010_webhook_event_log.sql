CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"gw_payment_id" text NOT NULL,
	"gw_refund_id" text,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_http_status" integer,
	"last_message" text DEFAULT '' NOT NULL,
	"next_retry_at" timestamp with time zone,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "webhook_events_status_updated_at_index" ON "webhook_events" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "webhook_events_gw_payment_id_index" ON "webhook_events" USING btree ("gw_payment_id");--> statement-breakpoint
CREATE INDEX "webhook_events_updated_at_index" ON "webhook_events" USING btree ("updated_at");