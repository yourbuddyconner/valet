ALTER TABLE custom_mcp_connectors
  ADD COLUMN credential_scope TEXT NOT NULL DEFAULT 'org'
    CHECK(credential_scope IN ('org', 'user'));

ALTER TABLE custom_mcp_connectors
  ADD COLUMN api_key_placement TEXT NOT NULL DEFAULT 'header'
    CHECK(api_key_placement IN ('header', 'query'));

ALTER TABLE custom_mcp_connectors
  ADD COLUMN api_key_query_param TEXT;
