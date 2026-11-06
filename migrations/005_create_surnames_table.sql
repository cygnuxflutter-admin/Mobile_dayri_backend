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

COMMIT;
