-- Re-creates the objects MGM's migrations attach to tables in schemas that
-- Supabase manages (auth, storage). A logical restore loses them: the
-- Supabase CLI's schema dump leaves those schemas out, and pg_dump writes a
-- table's triggers and policies only together with the table. Restoring the
-- migration history afterwards marks the defining migrations as applied, so
-- nothing would bring them back.
--
-- Run it after data.sql, in the same transaction, from a checkout of the MGM
-- release being restored (docs/runbooks/backup-and-restore.md, logical
-- restore step 3). It is idempotent: each object is dropped if it exists,
-- then created. It does not open or commit a transaction of its own.
--
-- Each statement is copied from the newest migration that defines the object.
-- scripts/tests/test_restore_managed_schema_objects.py compares this file with
-- supabase/migrations and fails when a migration adds, changes or drops such
-- a trigger or policy, or touches a Supabase-managed table in another way the
-- test does not model; update this file and the runbook when it does.

SET search_path = public, pg_temp;

-- From supabase/migrations/00017_user_profile_auto_create.sql
DROP TRIGGER IF EXISTS trg_create_profile_on_auth_user ON auth.users;
CREATE TRIGGER trg_create_profile_on_auth_user
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION fn_create_profile_on_auth_user();

-- From supabase/migrations/00064_mgm_release3_pilot_billing_bridge.sql
DROP POLICY IF EXISTS "invoice_logos_select" ON storage.objects;
CREATE POLICY "invoice_logos_select" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_insert" ON storage.objects;
CREATE POLICY "invoice_logos_insert" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_update" ON storage.objects;
CREATE POLICY "invoice_logos_update" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  )
  WITH CHECK (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_delete" ON storage.objects;
CREATE POLICY "invoice_logos_delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

RESET search_path;
