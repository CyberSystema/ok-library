-- Custom attributes were listed alphabetically by key, which buries the handful
-- the librarian touches on nearly every book among two dozen they rarely open.
--
-- `pinned` lifts a field to a distinguished group at the top of every attribute
-- list; `sort_order` orders fields within their group (pinned or not), falling
-- back to the label when it is equal. Both are librarian-editable from Settings,
-- so this is a starting point rather than a fixed policy.
ALTER TABLE custom_field_definitions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_field_definitions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Seed the eight the librarian named as their everyday fields, in the order
-- they asked for them (alphabetical by English label, which is how they listed
-- them). Anything not named keeps pinned = 0 and sorts as before.
UPDATE custom_field_definitions SET pinned = 1, sort_order = 1  WHERE field_key = 'condition';
UPDATE custom_field_definitions SET pinned = 1, sort_order = 2  WHERE field_key = 'cover_type';
UPDATE custom_field_definitions SET pinned = 1, sort_order = 3  WHERE field_key = 'edition';
UPDATE custom_field_definitions SET pinned = 1, sort_order = 4  WHERE field_key = 'editor';
UPDATE custom_field_definitions SET pinned = 1, sort_order = 5  WHERE field_key = 'illustration_type';
UPDATE custom_field_definitions SET pinned = 1, sort_order = 6  WHERE field_key = 'pages';
UPDATE custom_field_definitions SET pinned = 1, sort_order = 7  WHERE field_key = 'place_of_publication';
UPDATE custom_field_definitions SET pinned = 1, sort_order = 8  WHERE field_key = 'volume_num';
