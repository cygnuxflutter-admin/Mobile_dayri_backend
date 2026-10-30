-- Migration: 005_create_surnames_table.sql
-- Description: Create surnames master table with Gujarati and English support

BEGIN;

CREATE TABLE IF NOT EXISTS surnames (
  id BIGSERIAL PRIMARY KEY,
  surname TEXT NOT NULL,
  "surnameEnglish" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_surname_english 
ON surnames (LOWER(TRIM("surnameEnglish"))) 
WHERE COALESCE("isDeleted", false) = false;

CREATE INDEX IF NOT EXISTS idx_surnames_gujarati 
ON surnames (LOWER(TRIM(surname))) 
WHERE COALESCE("isDeleted", false) = false;

CREATE INDEX IF NOT EXISTS idx_surnames_active 
ON surnames ("isActive") 
WHERE COALESCE("isDeleted", false) = false;

-- Auto-seed from existing members table if available
INSERT INTO surnames (surname, "surnameEnglish", "isActive", "isDeleted", created_at, updated_at)
SELECT DISTINCT TRIM(m.surname), TRIM(m."surnameEnglish"), TRUE, FALSE, NOW(), NOW()
FROM members m
WHERE NULLIF(TRIM(m.surname), '') IS NOT NULL
  AND NULLIF(TRIM(m."surnameEnglish"), '') IS NOT NULL
  AND COALESCE(m."isDeleted", false) = false
ON CONFLICT (LOWER(TRIM("surnameEnglish"))) WHERE COALESCE("isDeleted", false) = false
DO NOTHING;

COMMIT;
