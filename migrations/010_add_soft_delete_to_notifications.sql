-- Migration: 010_add_soft_delete_to_notifications.sql
-- Description: Add isActive, isDeleted, and deletedBy columns to notifications table for soft delete support

BEGIN;

ALTER TABLE notifications 
ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT TRUE;

ALTER TABLE notifications 
ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN DEFAULT FALSE;

ALTER TABLE notifications 
ADD COLUMN IF NOT EXISTS "deletedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_is_deleted ON notifications ("isDeleted");
CREATE INDEX IF NOT EXISTS idx_notifications_is_active ON notifications ("isActive");
CREATE INDEX IF NOT EXISTS idx_notifications_deleted_by ON notifications ("deletedBy");

COMMIT;
