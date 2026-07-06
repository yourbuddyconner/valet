-- Edge-triggered failure logging (follow-up to the getCredential chokepoint log):
-- persist the last known failure state per credential so getCredential logs
-- transitions (healthy -> broken, reason change, recovery) instead of re-warning
-- on every resolution attempt — a permanently-broken credential otherwise warns
-- once per cron sweep pass, forever.
--
-- last_failure_at records when the credential entered its CURRENT failure mode
-- (stamped on transitions only — first failure or reason change), never on
-- repeat attempts, so retry loops add no write traffic. NULL last_failure_reason
-- == credential is healthy, which doubles as a queryable "currently broken
-- integrations" view.
ALTER TABLE credentials ADD COLUMN last_failure_reason TEXT;
ALTER TABLE credentials ADD COLUMN last_failure_at TEXT;
