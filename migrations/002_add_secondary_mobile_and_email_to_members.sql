-- Migration: 002_add_secondary_mobile_and_email_to_members.sql
-- Description: Add optional secondaryMobileNumber and email columns to members table

BEGIN;

ALTER TABLE members 
ADD COLUMN IF NOT EXISTS "secondaryMobileNumber" VARCHAR(25) NULL DEFAULT NULL,
ADD COLUMN IF NOT EXISTS "email" VARCHAR(150) NULL DEFAULT NULL;

COMMIT;
