-- NasirLink Migration 0002: Video Preview Toggle & Configurable Countdown Redirect
-- Backward-compatible migration for existing Cloudflare D1 and SQLite databases

ALTER TABLE links ADD COLUMN preview_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN auto_redirect_seconds INTEGER NOT NULL DEFAULT 0;

UPDATE links
SET preview_enabled = 1
WHERE link_type = 'video' AND preview_enabled = 0;

CREATE INDEX IF NOT EXISTS idx_links_preview_enabled ON links(preview_enabled);
