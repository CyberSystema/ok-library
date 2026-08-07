-- Publication dates that can say what the books actually say.
--
-- `publication_year INTEGER` cannot express a volume bound from two parts with
-- two imprints — which is where the librarian hit it — nor "c. 1850", nor
-- "[19--]", all of which are ordinary in a collection this old. EDTF
-- (ISO 8601-2) is the standard for exactly this, and MARC 260$c / 008 map onto
-- it directly.
--
-- `date_edtf` holds the authored expression. `publication_year` stays and
-- becomes DERIVED — the earliest year the expression can denote — with
-- `publication_year_end` as the latest. Deriving rather than asking the
-- librarian to keep a third field in sync is the point: sorting
-- (SORT_COLUMN.publicationYear), the decade histogram, the embedding text and
-- every existing query keep working with no change at all, and the range filter
-- becomes an overlap test that is a no-op for single-year books.

ALTER TABLE books ADD COLUMN date_edtf TEXT;
ALTER TABLE books ADD COLUMN publication_year_end INTEGER;

-- Every existing row is a plain year, so it is already valid EDTF and its span
-- is a single point. Backfilling both columns now means nothing has to special-
-- case "record predating EDTF support".
UPDATE books
   SET date_edtf = CAST(publication_year AS TEXT),
       publication_year_end = publication_year
 WHERE publication_year IS NOT NULL;

-- Range filtering tests overlap against these two columns together.
CREATE INDEX IF NOT EXISTS idx_books_year_span ON books(publication_year, publication_year_end);
