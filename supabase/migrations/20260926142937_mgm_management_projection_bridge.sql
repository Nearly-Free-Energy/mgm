-- Audit attribution required by the released microgrid projection.
-- Preserve historical rows without inventing their creator; new rows use auth.uid().
ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid()
    REFERENCES auth.users(id) ON DELETE SET NULL;
