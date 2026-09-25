-- 00059_metering_plugin.sql
-- Release 2 (issue #4): register the `metering` bundled plugin.
--
-- The trusted plugin-name CHECK constraints from 00056 enumerate exactly
-- two names. Release 2 adds the third (`metering`, defined in
-- src/lib/plugins/bundled.ts). DROP + ADD both constraints so pilot-chain
-- and full-chain databases converge; the permitted set stays closed —
-- adding a future plugin requires another versioned migration.

ALTER TABLE mgm_plugins
  DROP CONSTRAINT IF EXISTS mgm_plugins_name_known;
ALTER TABLE mgm_plugins
  ADD CONSTRAINT mgm_plugins_name_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering'
    )
  );

ALTER TABLE mgm_plugin_audit_log
  DROP CONSTRAINT IF EXISTS mgm_plugin_audit_log_plugin_known;
ALTER TABLE mgm_plugin_audit_log
  ADD CONSTRAINT mgm_plugin_audit_log_plugin_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering'
    )
  );
