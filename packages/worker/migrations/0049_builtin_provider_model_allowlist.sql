-- Add model allowlist + show_all toggle to built-in provider keys
ALTER TABLE org_api_keys ADD COLUMN models TEXT;
ALTER TABLE org_api_keys ADD COLUMN show_all_models INTEGER NOT NULL DEFAULT 1;
