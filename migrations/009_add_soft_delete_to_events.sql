-- Migration: 009_add_soft_delete_to_events.sql
-- Description: Add isActive, isDeleted, and deletedBy columns to events table for soft delete support

BEGIN;

ALTER TABLE events 
ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT TRUE;

ALTER TABLE events 
ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN DEFAULT FALSE;

ALTER TABLE events 
ADD COLUMN IF NOT EXISTS "deletedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_is_deleted ON events ("isDeleted");
CREATE INDEX IF NOT EXISTS idx_events_is_active ON events ("isActive");
CREATE INDEX IF NOT EXISTS idx_events_deleted_by ON events ("deletedBy");

COMMIT;
