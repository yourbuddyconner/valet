-- Add org setting for Drive files.list corpora scope (user, domain, allDrives)
ALTER TABLE org_settings ADD COLUMN drive_corpora TEXT NOT NULL DEFAULT 'user';
