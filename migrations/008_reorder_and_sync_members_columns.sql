-- Migration: 008_reorder_and_sync_members_columns.sql
-- Description: Reorder columns of members table according to updated specification and add age column

BEGIN;

-- 1. Create a temporary table with the exact columns and order requested
CREATE TABLE IF NOT EXISTS members_new (
  id BIGSERIAL PRIMARY KEY,
  "firstName" TEXT NOT NULL,
  "firstNameEnglish" TEXT NOT NULL,
  "middleName" TEXT NOT NULL,
  "middleNameEnglish" TEXT NOT NULL,
  surname TEXT NOT NULL,
  "surnameEnglish" TEXT NOT NULL,
  "mobileNumber" TEXT,
  gender TEXT NOT NULL CHECK (gender IN ('MALE', 'FEMALE')),
  "dateOfBirth" TEXT NOT NULL,
  "isActive" BOOLEAN DEFAULT TRUE,
  "isDeleted" BOOLEAN DEFAULT FALSE,
  "deletedBy" BIGINT,
  "isApproved" BOOLEAN DEFAULT FALSE,
  "approvedBy" BIGINT,
  "created_at" TIMESTAMPTZ DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ DEFAULT NOW(),
  "photo_url" TEXT,
  "currentAddress" TEXT,
  "latlng" TEXT,
  "role" TEXT NOT NULL DEFAULT 'USER' CHECK ("role" IN ('USER', 'ADMIN', 'SUPERADMIN')),
  "sonIds" BIGINT[],
  "fatherId" BIGINT,
  "fcmToken" TEXT,
  "passwordHash" TEXT,
  "isPasswordChange" BOOLEAN NOT NULL DEFAULT FALSE,
  age INTEGER,
  "countryCode" TEXT NOT NULL DEFAULT '+91',
  "isOutsideIndia" BOOLEAN NOT NULL DEFAULT FALSE,
  country TEXT,
  state TEXT,
  city TEXT,
  "secondaryMobileNumber" VARCHAR(25) NULL DEFAULT NULL,
  "email" VARCHAR(150) NULL DEFAULT NULL,
  "business" TEXT NULL DEFAULT NULL,
  "status" TEXT NULL DEFAULT NULL,
  "createdBy" BIGINT,
  "hasAppAccess" BOOLEAN NOT NULL DEFAULT TRUE,
  "isClaimed" BOOLEAN NOT NULL DEFAULT TRUE
);

-- 2. Copy existing data if members table exists and is not members_new
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'members') THEN
    INSERT INTO members_new (
      id,
      "firstName",
      "firstNameEnglish",
      "middleName",
      "middleNameEnglish",
      surname,
      "surnameEnglish",
      "mobileNumber",
      gender,
      "dateOfBirth",
      "isActive",
      "isDeleted",
      "deletedBy",
      "isApproved",
      "approvedBy",
      "created_at",
      "updated_at",
      "photo_url",
      "currentAddress",
      "latlng",
      "role",
      "sonIds",
      "fatherId",
      "fcmToken",
      "passwordHash",
      "isPasswordChange",
      age,
      "countryCode",
      "isOutsideIndia",
      country,
      state,
      city,
      "secondaryMobileNumber",
      "email",
      "business",
      "status",
      "createdBy",
      "hasAppAccess",
      "isClaimed"
    )
    SELECT
      id,
      "firstName",
      "firstNameEnglish",
      "middleName",
      "middleNameEnglish",
      surname,
      "surnameEnglish",
      "mobileNumber",
      CASE
        WHEN gender IS NOT NULL AND UPPER(TRIM(gender)) IN ('MALE', 'FEMALE') THEN UPPER(TRIM(gender))
        ELSE 'MALE'
      END AS gender,
      "dateOfBirth",
      COALESCE("isActive", TRUE),
      COALESCE("isDeleted", FALSE),
      "deletedBy",
      COALESCE("isApproved", FALSE),
      "approvedBy",
      COALESCE("created_at", NOW()),
      COALESCE("updated_at", NOW()),
      "photo_url",
      "currentAddress",
      "latlng",
      COALESCE("role", 'USER'),
      "sonIds",
      "fatherId",
      "fcmToken",
      "passwordHash",
      COALESCE("isPasswordChange", FALSE),
      CASE
        WHEN "dateOfBirth" IS NULL OR TRIM("dateOfBirth") = '' THEN NULL
        WHEN TRIM("dateOfBirth") ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$'
          THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM("dateOfBirth"), 'DD-MM-YYYY')))::INTEGER
        WHEN TRIM("dateOfBirth") ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM("dateOfBirth"), 'YYYY-MM-DD')))::INTEGER
        ELSE NULL
      END AS age,
      COALESCE("countryCode", '+91'),
      COALESCE("isOutsideIndia", FALSE),
      country,
      state,
      city,
      "secondaryMobileNumber",
      "email",
      "business",
      "status",
      "createdBy",
      COALESCE("hasAppAccess", TRUE),
      COALESCE("isClaimed", TRUE)
    FROM members;

    -- Drop old table (CASCADE to temporarily drop FK references which we recreate below)
    DROP TABLE members CASCADE;
    ALTER TABLE members_new RENAME TO members;
  ELSE
    ALTER TABLE members_new RENAME TO members;
  END IF;
END $$;

-- 3. Rename sequence to members_id_seq if needed
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'members_new_id_seq') THEN
    DROP SEQUENCE IF EXISTS members_id_seq CASCADE;
    ALTER SEQUENCE members_new_id_seq RENAME TO members_id_seq;
  END IF;
END $$;

-- 4. Update the primary key sequence
SELECT setval(
  pg_get_serial_sequence('members', 'id'),
  COALESCE((SELECT MAX(id) FROM members), 0) + 1,
  false
);

-- 5. Add Foreign Key constraints on members self-referencing fields
ALTER TABLE members
  ADD CONSTRAINT members_deletedBy_fkey FOREIGN KEY ("deletedBy") REFERENCES members(id) ON DELETE SET NULL,
  ADD CONSTRAINT members_approvedBy_fkey FOREIGN KEY ("approvedBy") REFERENCES members(id) ON DELETE SET NULL,
  ADD CONSTRAINT members_fatherId_fkey FOREIGN KEY ("fatherId") REFERENCES members(id) ON DELETE SET NULL,
  ADD CONSTRAINT members_createdBy_fkey FOREIGN KEY ("createdBy") REFERENCES members(id) ON DELETE SET NULL;

-- 6. Re-add foreign key constraints from other tables referencing members(id) if those tables exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'relationship_requests') THEN
    ALTER TABLE relationship_requests DROP CONSTRAINT IF EXISTS relationship_requests_requester_id_fkey;
    ALTER TABLE relationship_requests ADD CONSTRAINT relationship_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES members(id) ON DELETE CASCADE;
    ALTER TABLE relationship_requests DROP CONSTRAINT IF EXISTS relationship_requests_target_id_fkey;
    ALTER TABLE relationship_requests ADD CONSTRAINT relationship_requests_target_id_fkey FOREIGN KEY (target_id) REFERENCES members(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'video_upload_sessions') THEN
    ALTER TABLE video_upload_sessions DROP CONSTRAINT IF EXISTS video_upload_sessions_member_id_fkey;
    ALTER TABLE video_upload_sessions ADD CONSTRAINT video_upload_sessions_member_id_fkey FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'events') THEN
    ALTER TABLE events DROP CONSTRAINT IF EXISTS events_createBy_fkey;
    ALTER TABLE events ADD CONSTRAINT events_createBy_fkey FOREIGN KEY ("createBy") REFERENCES members(id) ON DELETE SET NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notifications') THEN
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_createBy_fkey;
    ALTER TABLE notifications ADD CONSTRAINT notifications_createBy_fkey FOREIGN KEY ("createBy") REFERENCES members(id) ON DELETE SET NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_notifications') THEN
    ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_user_id_fkey;
    ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES members(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 7. Create indexes
CREATE INDEX IF NOT EXISTS idx_members_created_by ON members ("createdBy");
CREATE INDEX IF NOT EXISTS idx_members_has_app_access ON members ("hasAppAccess");
CREATE INDEX IF NOT EXISTS idx_members_father_id ON members ("fatherId");
CREATE INDEX IF NOT EXISTS idx_members_mobile_number ON members ("mobileNumber");

COMMIT;
