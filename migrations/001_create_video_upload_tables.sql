-- Migration: 001_create_video_upload_tables.sql
-- Description: Creates video_upload_sessions and video_upload_chunks tables for resumable video chunk uploads.

BEGIN;

CREATE TABLE IF NOT EXISTS video_upload_sessions (
  id UUID PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT NOT NULL,
  chunk_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  checksum TEXT,
  checksum_algorithm TEXT DEFAULT 'sha256',
  status TEXT NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized', 'uploading', 'assembling', 'completed', 'cancelled', 'failed', 'expired')),
  storage_path TEXT NOT NULL,
  final_file_name TEXT,
  final_file_path TEXT,
  final_file_url TEXT,
  error_message TEXT,
  metadata JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_upload_chunks (
  upload_id UUID NOT NULL REFERENCES video_upload_sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  size BIGINT NOT NULL,
  checksum TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (upload_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_member_id ON video_upload_sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_status ON video_upload_sessions(status);
CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_expires_at ON video_upload_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_video_upload_chunks_upload_id ON video_upload_chunks(upload_id);

COMMIT;
