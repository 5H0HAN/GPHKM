-- Rapid resends can produce the same signed JWT within one second. Keep one marker per token digest.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "identifier"
           ORDER BY "expires_at" DESC, "created_at" DESC, "id" DESC
         ) AS "position"
  FROM "auth_verification"
  WHERE "identifier" LIKE 'gphkm:email-verification:%'
)
DELETE FROM "auth_verification" AS target
USING ranked
WHERE target."id" = ranked."id" AND ranked."position" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_verification_gphkm_email_verification_uq"
  ON "auth_verification" USING btree ("identifier")
  WHERE "auth_verification"."identifier" LIKE 'gphkm:email-verification:%';
