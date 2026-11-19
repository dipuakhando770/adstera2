-- NasirLink Migration: Cloudflare Custom Domains & Dynamic Metadata Rotation
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS custom_domains (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cloudflare_mode TEXT NOT NULL DEFAULT 'zone' CHECK (cloudflare_mode IN ('zone', 'saas')),
  cloudflare_zone_id TEXT,
  cloudflare_hostname_id TEXT,
  dns_status TEXT NOT NULL DEFAULT 'pending' CHECK (dns_status IN ('pending', 'verified', 'active', 'failed')),
  ssl_status TEXT NOT NULL DEFAULT 'pending' CHECK (ssl_status IN ('pending', 'active', 'failed')),
  domain_status TEXT NOT NULL DEFAULT 'active' CHECK (domain_status IN ('active', 'suspended', 'maintenance')),
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_hostname ON custom_domains(hostname);
CREATE INDEX IF NOT EXISTS idx_custom_domains_is_default ON custom_domains(is_default);

CREATE TABLE IF NOT EXISTS video_sources (
  id TEXT PRIMARY KEY,
  short_link_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  video_title TEXT,
  video_description TEXT,
  video_width INTEGER DEFAULT 1280,
  video_height INTEGER DEFAULT 720,
  mime_type TEXT DEFAULT 'video/mp4',
  codec TEXT DEFAULT 'avc1.64002a',
  cdn_hostname TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (short_link_id) REFERENCES links(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_sources_link_id ON video_sources(short_link_id);

CREATE TABLE IF NOT EXISTS metadata_variants (
  id TEXT PRIMARY KEY,
  video_source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (video_source_id) REFERENCES video_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metadata_variants_source_id ON metadata_variants(video_source_id);

CREATE TABLE IF NOT EXISTS metadata_rotation_state (
  id TEXT PRIMARY KEY,
  video_source_id TEXT NOT NULL UNIQUE,
  selected_variant_id TEXT,
  rotation_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (rotation_mode IN ('fixed', 'random_persistent', 'scheduled')),
  rotation_interval_hours INTEGER NOT NULL DEFAULT 24,
  last_rotated_at TEXT,
  next_rotation_at TEXT,
  FOREIGN KEY (video_source_id) REFERENCES video_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (selected_variant_id) REFERENCES metadata_variants(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_metadata_rotation_state_source_id ON metadata_rotation_state(video_source_id);

-- Ensure links table has custom domain binding column
ALTER TABLE links ADD COLUMN custom_domain_id TEXT;
CREATE INDEX IF NOT EXISTS idx_links_custom_domain_id ON links(custom_domain_id);
