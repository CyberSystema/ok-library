-- Two librarian-facing corrections, both done in SQL rather than through the
-- application so they cannot half-apply on a catalogue this size.
--
-- ─── 1. `pages` becomes free text (ISBD area 5 / MARC 300$a) ────────────────
--
-- Libraries do not record extent as a number. A volume that continues the
-- previous volume's pagination is "σ. 351-700"; a real record reads
-- "156,[3]σ. ; 21εκ.". The number type made all of those unrecordable — the
-- librarian hit this on the multi-volume sets.
--
-- Deliberately NOT done through PUT /api/custom-fields/:id, which does the same
-- job for the general case: that handler loads all ~12.5K rows and emits ~232
-- batched statements inside a single Worker invocation, and bumps `version` on
-- all 11,573 affected rows, forcing every offline client to re-pull the whole
-- catalogue. One statement here costs neither.
--
-- CAST(... AS TEXT) is lossless — 318 becomes "318". The inverse cast is the
-- rollback. `version` is intentionally left alone: the stored value is the same
-- number, so no client's copy has actually gone stale.
UPDATE books
   SET custom_fields = json_set(
         custom_fields,
         '$.pages',
         CAST(json_extract(custom_fields, '$.pages') AS TEXT)
       )
 WHERE json_valid(custom_fields)
   AND json_type(custom_fields, '$.pages') IN ('integer', 'real');

UPDATE custom_field_definitions
   SET field_type = 'text',
       updated_at = datetime('now')
 WHERE field_key = 'pages'
   AND field_type = 'number';

-- The normalized shadow table is not read anywhere (see the note at
-- index.ts `book_attribute_values is empty for the imported catalogue`), but
-- keep it consistent so a future reader is not misled by stale numeric JSON.
UPDATE book_attribute_values
   SET value_json = CAST(json_extract(value_json, '$') AS TEXT),
       updated_at = datetime('now')
 WHERE json_valid(value_json)
   AND json_type(value_json, '$') IN ('integer', 'real')
   AND attribute_definition_id IN (
         SELECT id FROM custom_field_definitions WHERE field_key = 'pages'
       );

-- ─── 2. "Category Label" joins the everyday attributes ─────────────────────
--
-- It is filled on 4,099 books — a third of the catalogue — and the librarian
-- reaches for it constantly, but it sat in the "Other" group.
--
-- Appends after the current highest pinned position instead of claiming a fixed
-- slot. Migration 0019 seeded sort_order 1..8 unconditionally; the live values
-- now read 2..9, which means the librarian has since rearranged them by hand.
-- Renumbering would silently undo that. The `AND pinned = 0` guard also makes a
-- re-run a no-op, so this can never move a field that is already placed.
UPDATE custom_field_definitions
   SET pinned = 1,
       sort_order = COALESCE(
         (SELECT MAX(sort_order) FROM custom_field_definitions WHERE pinned = 1 AND deleted_at IS NULL),
         0
       ) + 1,
       updated_at = datetime('now')
 WHERE field_key = 'category_label'
   AND pinned = 0
   AND deleted_at IS NULL;
