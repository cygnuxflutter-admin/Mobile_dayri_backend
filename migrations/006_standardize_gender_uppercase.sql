-- Migration: 006_standardize_gender_uppercase.sql
-- Description: Standardize gender values to uppercase ('MALE', 'FEMALE') and enforce check constraint

BEGIN;

-- 1. Standardize existing gender values to uppercase
UPDATE members
SET gender = UPPER(TRIM(gender))
WHERE gender IS NOT NULL;

-- 2. Clean up any invalid or empty values to 'MALE'
UPDATE members
SET gender = 'MALE'
WHERE gender IS NULL OR TRIM(gender) = '' OR UPPER(TRIM(gender)) NOT IN ('MALE', 'FEMALE');

-- 3. Add CHECK constraint on members table
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_gender_check;
ALTER TABLE members
ADD CONSTRAINT members_gender_check CHECK (gender IN ('MALE', 'FEMALE'));

COMMIT;
