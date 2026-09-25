-- MGM's pilot application does not expose entity deletion. The inherited
-- deletion RPCs are intentionally not installed in a fresh MGM database.
-- If MGM later gains a reviewed deletion workflow, add it in a new migration.
SELECT 1;
