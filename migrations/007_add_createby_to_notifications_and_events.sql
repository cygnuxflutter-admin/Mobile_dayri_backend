-- Migration: 007_add_createby_to_notifications_and_events.sql
-- Description: Add createBy column to notifications and events tables

BEGIN;

-- 1. Add createBy to notifications table
ALTER TABLE notifications 
ADD COLUMN IF NOT EXISTS "createBy" BIGINT REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_create_by ON notifications ("createBy");

-- 2. Add createBy to events table
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS "createBy" BIGINT REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_create_by ON events ("createBy");

COMMIT;
