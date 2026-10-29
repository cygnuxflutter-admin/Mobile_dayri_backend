-- Migration: 003_add_business_and_status_to_members.sql
-- Description: Add optional business and status (married, unmarried) columns to members table

BEGIN;

ALTER TABLE members 
ADD COLUMN IF NOT EXISTS "business" TEXT NULL DEFAULT NULL,
ADD COLUMN IF NOT EXISTS "status" TEXT NULL DEFAULT NULL;

COMMIT;
