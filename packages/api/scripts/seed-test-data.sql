-- Seed test data for E2E testing
-- Run with: wrangler d1 execute agent-ops-db --local --file=scripts/seed-test-data.sql

-- Create test user
INSERT OR REPLACE INTO users (id, email, name)
VALUES ('test-user-001', 'test@example.com', 'Test User');

-- Create API token (token value: "test-api-token-12345")
-- SHA-256 hash of "test-api-token-12345"
INSERT OR REPLACE INTO api_tokens (id, user_id, name, token_hash, scopes)
VALUES (
  'test-token-001',
  'test-user-001',
  'E2E Test Token',
  '8c8ce69e7409078d13753d8f5cc1caf5cd019e6755004a01b852af4ee809c4b5',
  '["*"]'
);
