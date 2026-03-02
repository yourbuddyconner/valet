-- Add timezone column to users table (IANA timezone, e.g. "America/Los_Angeles")
ALTER TABLE users ADD COLUMN timezone TEXT;
