-- Add scope to the integrations unique index so a user can have both
-- a personal (user) and org-scoped integration for the same service.
DROP INDEX IF EXISTS idx_integrations_user_service;
CREATE UNIQUE INDEX idx_integrations_user_service ON integrations(user_id, service, scope);
