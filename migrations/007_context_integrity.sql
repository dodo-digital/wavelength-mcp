-- Fix audit trail integrity: prevent deleting docs that have history,
-- and prevent duplicate version snapshots from concurrent operations.

-- Change CASCADE to RESTRICT — deleting a context doc with history is an error
ALTER TABLE wl_context_history
  DROP CONSTRAINT wl_context_history_context_id_fkey,
  ADD CONSTRAINT wl_context_history_context_id_fkey
    FOREIGN KEY (context_id) REFERENCES wl_context(id) ON DELETE RESTRICT;

-- Prevent duplicate version numbers per document (catches concurrent snapshot races)
CREATE UNIQUE INDEX IF NOT EXISTS idx_wl_context_history_unique_version
  ON wl_context_history(context_id, version);
