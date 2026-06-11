ALTER TABLE session_threads ADD COLUMN origin_type TEXT;
ALTER TABLE session_threads ADD COLUMN origin_channel_type TEXT;
ALTER TABLE session_threads ADD COLUMN origin_channel_id TEXT;
ALTER TABLE session_threads ADD COLUMN origin_trigger_id TEXT;
ALTER TABLE session_threads ADD COLUMN origin_trigger_type TEXT;
