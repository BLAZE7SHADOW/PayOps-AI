CREATE TABLE "agent_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"agent" text NOT NULL,
	"code" text NOT NULL,
	"statement" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real NOT NULL,
	"grounded" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"source" text NOT NULL,
	"system" text NOT NULL,
	"entity_ref" text NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"step_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_findings" ADD CONSTRAINT "agent_findings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_findings" ADD CONSTRAINT "agent_findings_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_findings_run_id_index" ON "agent_findings" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_findings_run_finding_uq" ON "agent_findings" USING btree ("run_id","finding_id");--> statement-breakpoint
CREATE INDEX "evidence_run_id_index" ON "evidence" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_run_evidence_uq" ON "evidence" USING btree ("run_id","evidence_id");