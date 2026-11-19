-- NasirLink Migration: X Player Card & Separated Social/Direct Routes
PRAGMA foreign_keys = ON;

-- Ensure required columns exist on links table
-- SQLite / D1 safe column additions
ALTER TABLE links ADD COLUMN card_type TEXT DEFAULT 'player';
ALTER TABLE links ADD COLUMN player_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE links ADD COLUMN player_compatibility_status TEXT DEFAULT 'compatible';

CREATE INDEX IF NOT EXISTS idx_links_player_enabled ON links(player_enabled);
