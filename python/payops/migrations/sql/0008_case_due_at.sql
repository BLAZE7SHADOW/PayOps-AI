ALTER TABLE "cases" ADD COLUMN "due_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: same windows as shared/sla.ts (CRITICAL 4h, HIGH 8h, MEDIUM 24h, LOW 72h).
UPDATE "cases" SET "due_at" = "opened_at" + (CASE "severity"
	WHEN 'CRITICAL' THEN interval '4 hours'
	WHEN 'HIGH' THEN interval '8 hours'
	WHEN 'MEDIUM' THEN interval '24 hours'
	ELSE interval '72 hours' END);
