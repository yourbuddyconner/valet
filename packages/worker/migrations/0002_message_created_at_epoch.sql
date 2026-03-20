ALTER TABLE messages ADD COLUMN created_at_epoch INTEGER;
UPDATE messages SET created_at_epoch = CAST(strftime('%s', created_at) AS INTEGER)
  WHERE created_at IS NOT NULL;
