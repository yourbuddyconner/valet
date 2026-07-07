-- Add inputSchema/outputSchema JSON columns to mcp_tool_cache so the
-- workflow editor can render MCP tool params and outputs without holding
-- live credentials (the action catalog endpoint runs unauthenticated for
-- editor browsing).
--
-- Both columns are nullable: older cache rows (and MCP servers that don't
-- advertise an outputSchema) leave them NULL, and the catalog endpoint
-- omits the field from its response in that case.

ALTER TABLE mcp_tool_cache ADD COLUMN input_schema TEXT;
ALTER TABLE mcp_tool_cache ADD COLUMN output_schema TEXT;
