CREATE TABLE "diagnosis_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"diagnosed_root_cause" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"correct_root_cause" text,
	"given_by_id" text NOT NULL,
	"given_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagnosis_feedback" ADD CONSTRAINT "diagnosis_feedback_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_feedback" ADD CONSTRAINT "diagnosis_feedback_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diagnosis_feedback_run_id_given_by_id_index" ON "diagnosis_feedback" USING btree ("run_id","given_by_id");--> statement-breakpoint
CREATE INDEX "diagnosis_feedback_case_id_index" ON "diagnosis_feedback" USING btree ("case_id");