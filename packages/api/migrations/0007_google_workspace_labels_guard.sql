-- Clean up stale data from old Google plugins
DELETE FROM credentials WHERE provider IN ('google_drive','google_docs','google_sheets');
DELETE FROM integrations WHERE service IN ('google_drive','google_docs','google_sheets');
DELETE FROM action_policies WHERE service IN ('google_drive','google_docs','google_sheets');
DELETE FROM disabled_actions WHERE service IN ('google_drive','google_docs','google_sheets');
DELETE FROM mcp_tool_cache WHERE service IN ('google_drive','google_docs','google_sheets');
DELETE FROM org_plugins WHERE name IN ('google-drive','google-docs','google-sheets');

-- Add Drive Labels guard settings to org_settings
ALTER TABLE org_settings ADD COLUMN drive_labels_guard_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_settings ADD COLUMN drive_required_label_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE org_settings ADD COLUMN drive_labels_fail_mode TEXT NOT NULL DEFAULT 'deny';
