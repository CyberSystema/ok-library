// The shapes the API speaks, lifted out of main.tsx.
//
// Domain types only — the response shapes and the enums that describe them.
// Deliberately NOT the Library tab's UI configuration (SMART_LISTS,
// CORE_TABLE_COLUMNS, DENSITIES, the storage keys): those are one screen's
// concern and belong beside it. A screen under screens/ needs to know what a
// Book is; it does not need to know which columns the table shows by default.
//
// A PURE MOVE. Only `export` was added.

export type BookStatus = 'available' | 'borrowed' | 'lost' | 'maintenance';
/** MARC leader/07 and IFLA LRM: a work that is finished vs one that keeps arriving. */
export type BibLevel = 'monograph' | 'serial';

export type Book = {
  id: string;
  title: string;
  author: string;
  status: BookStatus;
  roomCode?: string | null;
  shelfCode?: string | null;
  isbn?: string | null;
  /**
   * Whether the ISBN's check digit is arithmetically correct. COMPUTED by the
   * server on every read, never stored — and until now never displayed, so a
   * mistyped ISBN stayed silently wrong forever. `null` means no ISBN.
   */
  isbnValid?: boolean | null;
  publicationYear?: number | null;
  /** Latest year the date can denote; equals publicationYear for a single date. */
  publicationYearEnd?: number | null;
  /** The authored date in the EDTF subset — "1955/1957", "~1850", "19XX". */
  dateEdtf?: string | null;
  /** MARC 880-style parallel forms; the original script is what displays. */
  titleRomanized?: string | null;
  authorRomanized?: string | null;
  publisherRomanized?: string | null;
  /**
   * Dewey Decimal, alongside the local shelf mark rather than replacing it —
   * no re-shelving, but imported records keep their classification. MARC 082.
   */
  ddc?: string | null;
  bibLevel?: BibLevel | null;
  customFields?: Record<string, string | number | boolean | null>;
  version: number;
  publisher?: string | null;
  language?: string | null;
  description?: string | null;
  legacyId?: string | null;
  coverUrl?: string | null;
  /** The physical copies. A record can be held in more than one place. */
  items?: Item[];
};

export type Borrower = {
  id: string;
  name: string;
  contact?: string | null;
  totalLoans: number;
  openLoans: number;
  overdueLoans: number;
};

// Smart lists are pre-saved filter combinations the user can apply with one click.
// Each entry maps to query-string params understood by /api/books.
export type SmartList = {
  key: string;
  icon: string;
  label: string;
  // Returns the filter params; the caller spreads these into the URLSearchParams.
  params: Record<string, string>;
};

export type CatalogRow = {
  legacyId?: string | null;
  title?: string | null;
  author?: string | null;
  isbn?: string | null;
  publicationYear?: number | null;
  publisher?: string | null;
  language?: string | null;
  description?: string | null;
  shelfCode?: string | null;
  needsReview?: boolean;
  customFields: Record<string, string | number | boolean | null>;
};

export type CustomFieldType = 'text' | 'number' | 'boolean' | 'date' | 'enum';

export type CustomField = {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  // Pinned attributes lead every attribute list, ordered by sortOrder. Optional
  // so a client running against an API that predates the columns still parses.
  pinned?: boolean;
  sortOrder?: number;
  enumOptions: string[];
};

export type SessionUser = { id: string; username: string; role: string; needsOnboarding?: boolean };

export type LoginResponse = {
  user: SessionUser;
  // Present so clients on browsers that block the cross-site auth cookie
  // (Safari/WebKit ITP) can authenticate via an Authorization: Bearer header.
  token?: string;
};

export type SessionResponse = {
  user: SessionUser;
};

export type ActiveBorrow = {
  id: string;
  bookId: string;
  title: string;
  author: string;
  borrowerName: string;
  borrowerContact?: string | null;
  borrowedAt: string;
  dueAt: string;
  isOverdue: boolean;
  // WHICH copy is out. A record can have several on loan at once since the
  // holdings layer, so a loan row that named only the title was ambiguous.
  itemId?: string | null;
  copyNumber?: number | null;
  shelfCode?: string | null;
  barcode?: string | null;
  renewalCount?: number;
};

export type Iso2789Report = {
  period: { from: string; to: string };
  library: { isil: string | null; name: string | null; place: string | null };
  stockBaselineDate: string | null;
  collection: {
    titles: number; items: number; serialTitles: number;
    byDocumentCategory: Array<{ category: string; items: number }>;
    byLanguage: Array<{ language: string; titles: number }>;
  };
  flow: {
    additions: number;
    withdrawals: { total: number; byReason: Array<{ reason: string; items: number }> };
    loans: number; itemsLent: number; renewedLoans: number; activeBorrowers: number;
  };
  users: { registered: number; byCategory: Array<{ category: string; borrowers: number }> };
  caveats: string[];
};

export type ScanHit = {
  book: Book;
  item: Item | null;
  items: Item[];
  openLoan: { id: string; borrower_name: string; due_at: string; item_id: string | null; renewal_count: number } | null;
};

// ── Loan policies, holds and renewals ───────────────────────────────────────
export type LoanPolicy = {
  id?: string;
  borrowerCategory: string;
  itemType: string;
  loanDays: number;
  renewalLimit: number;
  renewalDays: number | null;
  maxConcurrentLoans: number | null;
  lendable: boolean;
  notes?: string | null;
};

export type Hold = {
  id: string;
  bookId?: string;
  title?: string;
  author?: string;
  position?: number;
  borrowerId?: string | null;
  borrowerName: string;
  borrowerContact?: string | null;
  status: 'waiting' | 'ready' | 'fulfilled' | 'cancelled' | 'expired';
  itemId?: string | null;
  copyNumber?: number | null;
  shelfCode?: string | null;
  placedAt: string;
  readyAt?: string | null;
  expiresAt?: string | null;
};

export type AuditLogItem = {
  id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  created_at: string;
};

export type StaffRole = 'admin' | 'librarian' | 'viewer';

export type StaffUser = {
  id: string;
  username: string;
  role: StaffRole;
  active: number;
  created_at: string;
  updated_at: string;
};

export type BorrowHistoryItem = {
  id: string;
  itemId?: string | null;
  borrowerName: string;
  borrowerContact?: string | null;
  borrowedAt: string;
  dueAt: string;
  returnedAt?: string | null;
  notes?: string | null;
  wasOverdue: boolean;
};

export type RoomSummaryItem = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  total_books: number;
  available_books: number;
  borrowed_books: number;
  lost_books: number;
  maintenance_books: number;
};

export type FacetItem = {
  value: string;
  /** The "nothing recorded here" bucket, always sorted first by the server. */
  isEmpty: boolean;
  count: number;
};

export type SetSummary = {
  key: string;
  setId: string | null;
  title: string;
  sampleAuthor: string;
  bookCount: number;
  minVol: number | null;
  maxVol: number | null;
  unnumbered: number;
  gapsAvailable: boolean;
  missing: number[];
  missingCount: number;
};

export type FacetResponse = {
  field: string;
  totalBooks: number;
  truncated: boolean;
  shownCount: number;
  items: FacetItem[];
};

export type AppSection = 'dashboard' | 'books' | 'circulation' | 'import' | 'settings';

export type StatsResponse = {
  byStatus: Array<{ status: string; count: number }>;
  byLanguage: Array<{ language: string; count: number }>;
  byYear: Array<{ bucket: string; count: number }>;
  completeness: {
    total: number;
    withIsbn: number;
    withShelf: number;
    withPublisher: number;
    withYear: number;
    untitled: number;
    unknownAuthor: number;
  };
  recentlyUpdated: Array<{
    id: string;
    title: string;
    author: string;
    legacyId: string | null;
    updatedAt: string;
  }>;
  topShelves: Array<{ shelfCode: string; count: number }>;
};

export type Theme = 'light' | 'dark';

export type DuplicateEntry = { id: string; title: string; author: string; isbn: string | null };

export type DuplicateGroup = DuplicateEntry[];

export type CatalogFacets = {
  // No `titles`: title is intentionally excluded from autocomplete (unique-ish
  // values, and suggesting them risks picking an existing book's title).
  authors: string[];
  publishers: string[];
  languages: string[];
  shelfCodes: string[];
  // Per-custom-field distinct values (text fields only), keyed by field key.
  customFields: Record<string, string[]>;
};

export type SearchMode = 'all' | 'any' | 'exact';

export type SearchField = 'title' | 'author' | 'isbn' | 'publisher' | 'language' | 'description' | 'roomCode' | 'shelfCode' | 'tags' | 'custom';

// One physical copy of a record — the object on the shelf, as distinct from the
// edition it is a copy of.
export type Item = {
  id: string;
  bookId: string;
  copyNumber: number;
  barcode?: string | null;
  volumeNum?: string | null;
  volumeLabel?: string | null;
  roomCode?: string | null;
  shelfCode?: string | null;
  callNumber?: string | null;
  itemType: string;
  status: BookStatus;
  condition?: string | null;
  // When this COPY entered the collection. The record's own createdAt is the
  // import timestamp for the whole legacy catalogue, so it cannot stand in.
  acquisitionDate?: string | null;
  notes?: string | null;
  version: number;
};

export type TitleSuggestion = {
  id: string;
  title: string;
  author: string;
  shelfCode?: string | null;
  publicationYear?: number | null;
  isbn?: string | null;
};

export type ValueVariantGroup = { canonical: string; total: number; variants: Array<{ value: string; count: number }> };

// ── Duplicate-record merge ──────────────────────────────────────────────────
// Two records for one book, each holding one copy, is what the catalogue looked
// like before there was a holdings layer. Merging folds them into one record
// with two copies — the shape the shelves actually have.
export type MergeCandidateItem = {
  id: string; shelfCode: string | null; roomCode: string | null;
  copyNumber: number; status: string; barcode: string | null;
};

export type MergeCandidateBook = {
  id: string; title: string; author: string; isbn: string | null; publisher: string | null;
  dateEdtf: string | null; legacyId: string | null; updatedAt: string;
  filledFields: number; openLoans: number; items: MergeCandidateItem[];
};

export type MergeCandidateGroup = { key: string; differingFields: string[]; books: MergeCandidateBook[] };

export type MergePreview = {
  wouldFillFields: Record<string, unknown>;
  wouldRescueAttributes: Record<string, unknown>;
  wouldAddTags: string[];
  copiesAfter: number;
  copiesMoving: Array<{ shelfCode: string | null; copyNumber: number }>;
  recordsRemoved: number;
};
