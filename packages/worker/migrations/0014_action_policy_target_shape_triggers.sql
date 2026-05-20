DELETE FROM action_policies
WHERE NOT (
  (service IS NOT NULL AND action_id IS NOT NULL AND risk_level IS NULL)
  OR (service IS NOT NULL AND action_id IS NULL AND risk_level IS NULL)
  OR (service IS NULL AND action_id IS NULL AND risk_level IS NOT NULL)
);

CREATE TRIGGER validate_action_policies_target_insert
BEFORE INSERT ON action_policies
WHEN NOT (
  (NEW.service IS NOT NULL AND NEW.action_id IS NOT NULL AND NEW.risk_level IS NULL)
  OR (NEW.service IS NOT NULL AND NEW.action_id IS NULL AND NEW.risk_level IS NULL)
  OR (NEW.service IS NULL AND NEW.action_id IS NULL AND NEW.risk_level IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'action_policies must target exactly one of action, service, or risk level');
END;

CREATE TRIGGER validate_action_policies_target_update
BEFORE UPDATE ON action_policies
WHEN NOT (
  (NEW.service IS NOT NULL AND NEW.action_id IS NOT NULL AND NEW.risk_level IS NULL)
  OR (NEW.service IS NOT NULL AND NEW.action_id IS NULL AND NEW.risk_level IS NULL)
  OR (NEW.service IS NULL AND NEW.action_id IS NULL AND NEW.risk_level IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'action_policies must target exactly one of action, service, or risk level');
END;
