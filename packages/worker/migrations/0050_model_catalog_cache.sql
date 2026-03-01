-- Model catalog cache: stores external fetch results (models.dev catalog, provider probes)
CREATE TABLE model_catalog_cache (
  cache_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  cached_at INTEGER NOT NULL DEFAULT (unixepoch())
);
