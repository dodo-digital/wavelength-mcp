-- Move context history capture into the database so concurrent updates serialize
-- through the wl_context row lock used by INSERT ... ON CONFLICT DO UPDATE.

CREATE OR REPLACE FUNCTION wl_context_history_before_update()
RETURNS trigger AS $$
BEGIN
  INSERT INTO wl_context_history (
    context_id,
    slug,
    version,
    doc_type,
    title,
    content,
    tags,
    metadata,
    changed_by,
    change_type
  )
  VALUES (
    OLD.id,
    OLD.slug,
    OLD.version,
    OLD.doc_type,
    OLD.title,
    OLD.content,
    OLD.tags,
    OLD.metadata,
    OLD.updated_by,
    'updated'
  )
  ON CONFLICT (context_id, version) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wl_context_history_before_update_trigger ON wl_context;
CREATE TRIGGER wl_context_history_before_update_trigger
  BEFORE UPDATE ON wl_context
  FOR EACH ROW
  EXECUTE FUNCTION wl_context_history_before_update();

DROP TRIGGER IF EXISTS wl_context_history_after_insert_trigger ON wl_context;
DROP FUNCTION IF EXISTS wl_context_history_after_insert();
