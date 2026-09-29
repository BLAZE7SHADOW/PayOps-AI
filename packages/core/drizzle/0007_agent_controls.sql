CREATE TABLE "agent_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"changed_by_id" text NOT NULL,
	"changed_by_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
