-- Migration: 004_add_family_and_virtual_member_fields.sql
-- Description: Allow members without mobile number (dependent family members), add createdBy, hasAppAccess, and isClaimed columns

BEGIN;

ALTER TABLE members ALTER COLUMN "mobileNumber" DROP NOT NULL;

ALTER TABLE members 
ADD COLUMN IF NOT EXISTS "createdBy" BIGINT REFERENCES members(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS "hasAppAccess" BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS "isClaimed" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_members_created_by ON members ("createdBy");
CREATE INDEX IF NOT EXISTS idx_members_has_app_access ON members ("hasAppAccess");

COMMIT;
