-- Add actionType column to org_plugins for distinguishing MCP vs static action plugins
ALTER TABLE org_plugins ADD COLUMN action_type TEXT;
