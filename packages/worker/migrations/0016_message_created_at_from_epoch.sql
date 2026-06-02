UPDATE messages
SET created_at = datetime(created_at_epoch, 'unixepoch')
WHERE created_at_epoch IS NOT NULL;
