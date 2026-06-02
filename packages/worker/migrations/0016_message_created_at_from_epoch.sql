UPDATE messages
SET created_at = datetime(created_at_epoch, 'unixepoch')
WHERE created_at_epoch IS NOT NULL
  AND datetime(created_at_epoch, 'unixepoch') IS NOT NULL
  AND COALESCE(created_at, '') != datetime(created_at_epoch, 'unixepoch');
