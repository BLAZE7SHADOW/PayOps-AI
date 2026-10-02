ALTER TABLE "audit_events" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "prev_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Rows written before the chain existed get a position now; their hashes are filled in by sealLegacyAuditRows() right after migrations run.
UPDATE "audit_events" a SET "seq" = n.rn FROM (SELECT "id", row_number() OVER (ORDER BY "at", "id") AS rn FROM "audit_events") n WHERE a."id" = n."id";--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_seq_index" ON "audit_events" USING btree ("seq");--> statement-breakpoint
-- Append-only, enforced by the database (D077). A trigger, not a rule: it fails loudly instead of silently doing nothing.
-- The one allowed update is sealing a legacy row that has no hash yet. TRUNCATE is not blocked (demo reset and test cleanup use it).
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."hash" = '' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update" BEFORE UPDATE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();--> statement-breakpoint
CREATE TRIGGER "audit_events_no_delete" BEFORE DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
