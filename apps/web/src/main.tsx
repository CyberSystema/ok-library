import React, { Fragment, FormEvent, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  BookCardSkeleton,
  ConfirmProvider,
  MiniBar,
  ToastProvider,
  fmt,
  highlight,
  normalizeForCompare,
  useConfirm,
  useToast,
  StatCard, SectionHeader, EdtfHint, Combobox, Dialog,
  endOfLocalDayIso, isoToLocalDateInput,
  // The cover lightbox is a role="dialog" that cannot use <Dialog>'s markup, so it borrows
  // Dialog's behaviour from the same two primitives instead of going without.
  useModalFocus, trapTab
} from './ui';
import { I18nProvider, LanguageSwitcher, useI18n, useT, type Lang } from './i18n';
import { csvCell, formatEdtfRange, formatHoldingStatement, ITEM_TYPES, parseEdtf } from '@ok-library/shared';
import { cacheGet, cacheSet, cacheBustPrefixes, cacheClear } from './cache';
// The network layer now lives in api.ts. main.tsx exports nothing, so anything a
// screen outside this file needs has to be reachable from there instead.
import {
  API_BASE, PAGE_SIZE, DEBOUNCE_MS, IMPORT_CHUNK_SIZE, IMPORT_MIN_CHUNK_SIZE,
  apiRequest, joinApiUrl, sleep, newMutationId,
  setAuthToken, setUnauthorizedHandler, subscribeNetStatus,
  ApiRequestError, SpreadsheetRowMissingError, OfflineWriteBlockedError,
  isOfflineWriteBlockedError, isPayloadTooLargeError,
  type NetStatus
} from './api';
import type {
  BookStatus, BibLevel, Book, Borrower, SmartList, CatalogRow, CustomFieldType, CustomField,
  SessionUser, LoginResponse, SessionResponse, ActiveBorrow, Iso2789Report, ScanHit,
  LoanPolicy, Hold, AuditLogItem, StaffRole, StaffUser, BorrowHistoryItem, RoomSummaryItem,
  FacetItem, SetSummary, FacetResponse, AppSection, StatsResponse, Theme, DuplicateEntry,
  DuplicateGroup, CatalogFacets, SearchMode, SearchField, Item, TitleSuggestion,
  ValueVariantGroup, MergeCandidateItem, MergeCandidateBook, MergeCandidateGroup, MergePreview
} from './types';
import { OnboardingCourse } from './onboarding';
// The Handbook's mechanism is eager — a few hundred bytes of ids and the provider
// — while the renderer and the prose are lazy. `check_handbook.mjs` asserts the
// content packs never reach the main chunk.
import { HandbookProvider, HelpLink, useHandbook } from './handbook/context';
const HandbookView = lazy(() => import('./handbook').then((m) => ({ default: m.Handbook })));
const HandbookPrintable = lazy(() => import('./handbook').then((m) => ({ default: m.HandbookPrintable })));
import { AuthoritiesCard, BookAuthorities } from './screens/authorities';
import { BorrowersCard } from './screens/borrowers';
import { CopiesEditor } from './screens/copies';
import { SerialHoldingsEditor, type SerialHolding } from './screens/serials';
import { LibraryIdentityCard } from './screens/identity';
import { MarcIoCard } from './screens/marcio';
import { RoomsCard } from './screens/rooms';
import { TrashCard } from './screens/trash';
import './styles.css';

// Lazy-loaded only when the user opens the Import tab — saves ~1MB from the initial bundle.
async function loadXlsx() {
  return await import('xlsx');
}























// Fields the rail can group by. Core fields first, then every custom attribute
// (appended at runtime from the live definitions, everyday ones first). Must
// stay a subset of the server's whitelist in db.ts `resolveEmptyFieldExpr`.
// Sentinel rail mode. Not a facet field — it groups by multi-part work and
// reports absent volumes, which is a different shape from value/count rows.
const RAIL_SETS = 'sets';

const CORE_FACET_CHOICES: Array<{ key: string; labelKey: string }> = [
  { key: 'shelfCode', labelKey: 'library.add.shelf' },
  { key: 'publisher', labelKey: 'library.add.publisher' },
  { key: 'publicationYear', labelKey: 'library.add.year' },
  { key: 'language', labelKey: 'library.add.language' },
  { key: 'roomCode', labelKey: 'library.bulk.field.roomCode' },
  { key: 'status', labelKey: 'detail.statusRow' }
];




// Saved smart lists rendered as one-click filter chips. The keys must be stable
// because they're used to highlight the active chip. The label is resolved at
// render time via the i18n translator using `labelKey`.
const SMART_LISTS: Array<SmartList & { labelKey: string }> = [
  { key: 'missing-isbn',     icon: '🔢', labelKey: 'library.smart.missingIsbn',    label: 'Missing ISBN',     params: { missingIsbn: '1' } },
  { key: 'missing-shelf',    icon: '📍', labelKey: 'library.smart.missingShelf',   label: 'Missing shelf',    params: { missingShelf: '1' } },
  { key: 'untitled',         icon: '⊘',  labelKey: 'library.smart.untitled',       label: 'Untitled',         params: { untitled: '1' } },
  { key: 'unknown-author',   icon: '?',  labelKey: 'library.smart.unknownAuthor',  label: 'Unknown author',   params: { unknownAuthor: '1' } },
  { key: 'bad-isbn',         icon: '⚠',  labelKey: 'library.smart.badIsbn',        label: 'Bad ISBN',         params: { invalidIsbn: '1' } },
  { key: 'pre-1900',         icon: '🏛', labelKey: 'library.smart.pre1900',        label: 'Before 1900',      params: { yearMax: '1899' } },
  { key: 'post-2000',        icon: '🆕', labelKey: 'library.smart.post2000',       label: 'From 2000+',       params: { yearMin: '2000' } },
  { key: 'borrowed',         icon: '🔁', labelKey: 'library.smart.borrowed',       label: 'Currently borrowed', params: { status: 'borrowed' } },
  { key: 'recently-added',   icon: '🕒', labelKey: 'library.smart.recent',         label: 'Recently added',   params: { sortBy: 'updatedAt', sortDir: 'desc' } }
];


// The book-list filter params, built in ONE place so the grid query and the
// "select all matching" query can never drift apart — if they did, the librarian
// would select a different set than the one they are looking at. Pure (takes the
// values, reads no state) so callers can't capture a stale closure.
function buildBookFilterParams(f: {
  q: string;
  qExclude: string;
  qMode: string;
  partialWords: boolean;
  fuzzyTypos: boolean;
  searchFields: string[];
  status: string;
  filterLanguage: string;
  filterYear: string;
  /** Facet rail: which field is being browsed, and the bucket clicked in it. */
  facetField: string;
  facetValue: string;
  facetEmpty: boolean;
  needsReviewFilter: boolean;
  shelfFilter: string;
  smartListKey: string;
  smartLists: ReadonlyArray<{ key: string; params: Record<string, string> }>;
}): URLSearchParams {
  const query = new URLSearchParams();
  if (f.q) query.set('q', f.q);
  if (f.qExclude) query.set('qExclude', f.qExclude);
  query.set('qMode', f.qMode);
  query.set('partialWords', String(f.partialWords));
  query.set('fuzzyTypos', String(f.fuzzyTypos));
  query.set('searchFields', f.searchFields.join(','));
  if (f.status) query.set('status', f.status);
  if (f.filterLanguage) query.set('language', f.filterLanguage);
  // Only send a complete, in-range year — otherwise every keystroke ("1", "19",
  // "190") would post a year the schema rejects (1000–3000) and pop a 400 toast
  // mid-typing. Partial input simply doesn't filter yet.
  if (f.filterYear) {
    const yr = Number(f.filterYear);
    if (Number.isInteger(yr) && yr >= 1000 && yr <= 3000) query.set('year', f.filterYear);
  }
  // Facet selection goes through the dedicated facetField/emptyField params
  // rather than the looser per-field filters, so the list the librarian opens
  // holds exactly the number the rail showed. See the schema comment.
  if (f.facetEmpty) query.set('emptyField', f.facetField);
  else if (f.facetValue) {
    // The Sets rail is a display mode, not a server field: a set IS the books
    // sharing a `series` value, so that is what gets filtered on. Grouping is
    // by exact spelling server-side, which keeps the count and this list equal.
    query.set('facetField', f.facetField === 'sets' ? 'custom:series' : f.facetField);
    query.set('facetValue', f.facetValue);
  }
  if (f.needsReviewFilter) query.set('custom_needs_review', '1');
  if (f.shelfFilter) query.set('shelfCode', f.shelfFilter);
  // Apply the active smart-list's filters last so it composes with the rest.
  if (f.smartListKey) {
    const list = f.smartLists.find((l) => l.key === f.smartListKey);
    if (list) for (const [k, v] of Object.entries(list.params)) query.set(k, v);
  }
  return query;
}

const PREFS_STORAGE_KEY = 'ok-library-prefs-v1';
// Bulk-selection ids, kept in sessionStorage (per tab, cleared when the tab
// closes) so paging/searching/reloading never loses a selection in progress.
const SELECTION_STORAGE_KEY = 'ok-library-selection-v1';

type SortBy = 'updatedAt' | 'title' | 'author' | 'publicationYear' | 'status';
type SortDir = 'asc' | 'desc';
// 'table' is the spreadsheet view: one row per book, one column per field, so
// the librarian can see at a glance which records are missing something.
type Density = 'comfortable' | 'compact' | 'table';
const DENSITIES: Density[] = ['comfortable', 'compact', 'table'];

// Core columns available in the table view. Custom attributes are appended from
// the live definitions, so this only has to name the things that live on the
// book row itself. `get` returns the display string; '' means "missing", which
// is what the gap highlighting keys on.
type BookColumn = {
  key: string;
  /** i18n key for the header, or `label` when the header is authored data. */
  labelKey?: string;
  label?: string;
  get: (book: Book) => string;
  width?: number;
};

const CORE_TABLE_COLUMNS: Array<Omit<BookColumn, 'get'> & { get: (b: Book) => string }> = [
  { key: 'title', labelKey: 'library.add.bookTitle', get: (b) => b.title ?? '', width: 280 },
  { key: 'author', labelKey: 'library.add.author', get: (b) => b.author ?? '', width: 180 },
  { key: 'publisher', labelKey: 'library.add.publisher', get: (b) => b.publisher ?? '', width: 160 },
  { key: 'publicationYear', labelKey: 'library.add.year', get: (b) => displayBookDate(b), width: 96 },
  { key: 'language', labelKey: 'library.add.language', get: (b) => b.language ?? '', width: 90 },
  { key: 'isbn', labelKey: 'library.add.isbn', get: (b) => b.isbn ?? '', width: 130 },
  { key: 'shelfCode', labelKey: 'library.add.shelf', get: (b) => b.shelfCode ?? '', width: 100 },
  { key: 'roomCode', labelKey: 'library.bulk.field.roomCode', get: (b) => b.roomCode ?? '', width: 90 },
  { key: 'ddc', labelKey: 'library.add.ddc', get: (b) => b.ddc ?? '', width: 90 },
  { key: 'legacyId', labelKey: 'ctx.copyLegacy', get: (b) => b.legacyId ?? '', width: 100 },
  { key: 'description', labelKey: 'library.add.description', get: (b) => b.description ?? '', width: 220 }
];

// What the table opens with: the fields a librarian checks on every record,
// plus every everyday (pinned) attribute, which is what "μια εποπτική εικόνα
// των καταχωρήσεων" actually asks for. `status` is always rendered as a badge
// in its own leading column, so it is not listed here.
const DEFAULT_TABLE_COLUMNS = [
  'title', 'author', 'publisher', 'publicationYear', 'language', 'isbn', 'shelfCode'
];

// Kept in sync with CATALOG_CUSTOM_FIELDS in apps/api-worker/src/index.ts.
const CATALOG_FIELD_COUNT = 25;
// Legacy English sentinels historically minted by catalog imports. New writes
// store '' instead (see normalizeBookData), but existing rows may still hold
// these until re-normalized, so the UI must treat both as "no value".
const TITLE_PLACEHOLDER = '(Untitled)';
const AUTHOR_PLACEHOLDER = '(Unknown)';

// A book field is "empty" if it's blank OR holds the legacy sentinel.
function isPlaceholder(value: string | null | undefined, kind: 'title' | 'author'): boolean {
  const text = (value ?? '').trim();
  const sentinel = kind === 'title' ? TITLE_PLACEHOLDER : AUTHOR_PLACEHOLDER;
  return text === '' || text === sentinel;
}

// Render the title/author, substituting a caller-supplied (localized) placeholder
// for empty or legacy-sentinel values. The placeholder defaults to the English
// sentinel so non-React callers keep working, but every UI call passes t(...).
function displayTitle(book: { title: string }, placeholder: string = TITLE_PLACEHOLDER): string {
  const trimmed = book.title?.trim() ?? '';
  return trimmed === '' || trimmed === TITLE_PLACEHOLDER ? placeholder : trimmed;
}

function displayAuthor(book: { author: string }, placeholder: string = AUTHOR_PLACEHOLDER): string {
  const trimmed = book.author?.trim() ?? '';
  return trimmed === '' || trimmed === AUTHOR_PLACEHOLDER ? placeholder : trimmed;
}

// Render one custom-attribute value for display.
//
// Module scope on purpose: the detail view, the overview table and the CSV-ish
// surfaces must all format a boolean or a date the same way. Definition-aware,
// because the raw JSON is `true` / an ISO timestamp and neither is something to
// show a librarian. Falls back to String() when no definition exists, which is
// what keeps values from a since-deleted attribute readable rather than blank.
function formatCustomValue(
  def: { type: CustomFieldType } | undefined,
  value: unknown,
  yes: string,
  no: string
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? yes : no;
  if (def?.type === 'boolean') {
    const s = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on', 'ναι'].includes(s)) return yes;
    if (['false', '0', 'no', 'n', 'off', 'οχι', 'όχι'].includes(s)) return no;
  }
  if (def?.type === 'date') {
    const text = String(value).trim();
    // Stored as a full ISO timestamp; the librarian only ever entered a day.
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return text.slice(0, 10);
  }
  return String(value);
}

// A custom-attribute value counts as present only if it would render as
// something. Shared so "is this cell empty?" means the same in the detail view
// and in the table's missing-value highlighting.
function hasCustomValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

// ─── Desktop app downloads ────────────────────────────────────────────────────
// Installers are published to GitHub Releases; `latest/download/<asset>` always
// resolves to the newest release's asset, so the button never needs updating.
// Override the base via VITE_DESKTOP_DL_BASE if you host the installers elsewhere.
const DESKTOP_DL_BASE = (import.meta.env.VITE_DESKTOP_DL_BASE as string | undefined)
  ?? 'https://github.com/CyberSystema/ok-library/releases/latest/download';
const DESKTOP_RELEASES_URL = (import.meta.env.VITE_DESKTOP_RELEASES_URL as string | undefined)
  ?? 'https://github.com/CyberSystema/ok-library/releases/latest';
const DESKTOP_DOWNLOADS = {
  mac: `${DESKTOP_DL_BASE}/OK-Library-macOS.dmg`,
  windows: `${DESKTOP_DL_BASE}/OK-Library-Windows-x64.zip`,
  windowsArm: `${DESKTOP_DL_BASE}/OK-Library-Windows-arm64.zip`
};

type DesktopOS = 'mac' | 'windows' | 'other';

/** Best-effort OS detection for picking the right installer. */
function detectDesktopOS(): DesktopOS {
  if (typeof navigator === 'undefined') return 'other';
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = (uaData?.platform || navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  const hay = `${platform} ${ua}`;
  // Note: iPadOS reports as "Mac"; harmless here since the link still points at
  // the releases page fallback only for the 'other' bucket.
  if (hay.includes('mac')) return 'mac';
  if (hay.includes('win')) return 'windows';
  return 'other';
}

/** True when running inside the Electron desktop shell (preload sets this). */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { okDesktop?: { isDesktop?: boolean } }).okDesktop?.isDesktop);
}

/**
 * Auto-detecting "Download desktop app" button. Picks the installer for the
 * visitor's OS; on an unrecognized OS it links to the releases page (all
 * platforms). The small "other platforms" link is always available so e.g. a
 * Mac user can still grab the Windows build.
 *
 * Hidden inside the desktop app itself — only the web app offers the download.
 */
function DownloadDesktopButton() {
  const t = useT();
  const os = useMemo(detectDesktopOS, []);

  if (isDesktopShell()) return null;

  const target =
    os === 'mac'
      ? { href: DESKTOP_DOWNLOADS.mac, label: t('desktop.downloadMac') }
      : os === 'windows'
        ? { href: DESKTOP_DOWNLOADS.windows, label: t('desktop.downloadWin') }
        : { href: DESKTOP_RELEASES_URL, label: t('desktop.downloadApp') };

  return (
    <span className="desktop-download">
      <a className="btn-download" href={target.href} title={t('desktop.tooltip')}>
        <svg
          className="btn-download-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v12" />
          <path d="m7 11 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        <span>{target.label}</span>
      </a>
      {os !== 'other' && (
        <a
          className="desktop-download-other"
          href={DESKTOP_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t('desktop.otherTooltip')}
        >
          {t('desktop.other')}
        </a>
      )}
    </span>
  );
}

const RESERVED_ATTRIBUTE_KEYS = new Set([
  'title',
  'subtitle',
  'author',
  'isbn',
  'publicationYear',
  'publisher',
  'language',
  'description',
  'roomCode',
  'shelfCode',
  'acquisitionDate',
  'status',
  'tags',
  'customFields',
  'version',
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt'
]);

// /api/books and /api/stats which depend on borrow state.




// Autocomplete option lists for the add/edit book forms. Memoized on `facets`
// so the ~4000 <option> nodes are only rebuilt when the catalog values change —
// never on every keystroke in the (frequently re-rendering) parent form.
const CatalogDatalists = React.memo(function CatalogDatalists({ facets }: { facets: CatalogFacets }) {
  return (
    <>
      <datalist id="suggest-author">{(facets.authors ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="suggest-publisher">{(facets.publishers ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="suggest-language">{(facets.languages ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="suggest-shelf">{(facets.shelfCodes ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      {/* One datalist per free-text custom field, referenced by suggest-cf-<key>.
          Guard against a stale cached facets shape that predates customFields. */}
      {Object.entries(facets.customFields ?? {}).map(([key, values]) => (
        <datalist id={`suggest-cf-${key}`} key={key}>{(values ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      ))}
    </>
  );
});

// ISBN registration groups that mean "this book was published in Greece", and
// so that a Latin-script title for it is almost certainly a romanization.
// 960 and 618 are the Greek group identifiers; 978-/979- are the EAN prefixes.
const GREEK_ISBN_GROUPS = [/^97[89]960/, /^97[89]618/, /^960/, /^618/];

const NON_LATIN_SCRIPT = /[Ͱ-Ͽἀ-῿Ѐ-ӿ가-힯぀-ヿ一-鿿]/;
const LATIN_LETTER = /[A-Za-z]/;

/**
 * Is this value a ROMANIZATION rather than the work's own script?
 *
 * The librarian's ISBN complaint traced to Open Library serving ALA-LC
 * romanized MARC for Greek books. With one slot per field the romanized form
 * simply overwrote the Greek. Detecting it lets the value go to the parallel
 * field instead, where it is useful rather than destructive.
 *
 * Deliberately conservative — it only says yes when the value is pure Latin AND
 * we have positive evidence the work is not: a Greek ISBN group, or a declared
 * non-Latin language. A genuinely English book keeps its title in the normal
 * field, which is the common case and must not regress.
 */
function isRomanizedFor(value: string, language: string | null, isbnDigits: string): boolean {
  if (!LATIN_LETTER.test(value) || NON_LATIN_SCRIPT.test(value)) return false;
  if (GREEK_ISBN_GROUPS.some((re) => re.test(isbnDigits))) return true;
  const lang = (language ?? '').trim().toLowerCase();
  return ['el', 'ell', 'gre', 'ko', 'kor', 'ru', 'rus'].includes(lang);
}

/**
 * Live feedback under the publication-date field.
 *
 * The field takes EDTF, so it accepts things a year box cannot: "1955/1957" for
 * a volume bound from two parts, "~1850" for circa, "19XX" for an undated
 * imprint. Showing the interpreted span as it is typed is what makes that
 * discoverable — otherwise the syntax is invisible.
 *
 * An unrecognised value is flagged but never blocks the save: a librarian
 * transcribing what is printed in the book must always be able to record it,
 * and refusing would lose the only note of it. It simply won't sort or filter
 * by year, which the hint says.
 */
/**
 * How a book's date reads: "1955", "1955–1957", "c. 1850", "1955?".
 *
 * Prefers the authored EDTF expression so a range or a qualifier survives to
 * the screen; falls back to the derived year for rows that predate the column.
 */
function displayBookDate(book: { dateEdtf?: string | null; publicationYear?: number | null }): string {
  const raw = (book.dateEdtf ?? '').trim();
  if (raw) {
    const parsed = parseEdtf(raw);
    // Unparseable is shown verbatim — it is what the librarian transcribed.
    return parsed ? formatEdtfRange(parsed) : raw;
  }
  return book.publicationYear ? String(book.publicationYear) : '';
}







// One row of the "value consistency" tool: shows the fold-equivalent spellings
// of a value with their book counts, lets the librarian pick (or type) the
// canonical form, and merge the rest into it.
function VariantGroupCard({ group, mergeLabel, keepLabel, onMerge }: {
  group: ValueVariantGroup;
  mergeLabel: string;
  keepLabel: string;
  onMerge: (canonical: string) => void;
}) {
  const [canonical, setCanonical] = useState(group.canonical);
  return (
    <div className="variant-group">
      <div className="variant-chips">
        {group.variants.map((v) => (
          <button
            type="button"
            key={v.value}
            className={`variant-chip${v.value === canonical ? ' is-canonical' : ''}`}
            title={keepLabel}
            onClick={() => setCanonical(v.value)}
          >
            <span className="variant-chip-value">{v.value}</span>
            <span className="variant-chip-count">{v.count}</span>
          </button>
        ))}
      </div>
      <div className="variant-merge-row">
        <input
          value={canonical}
          aria-label={keepLabel}
          onChange={(e) => setCanonical(e.target.value)}
        />
        <button
          type="button"
          className="primary small"
          disabled={!canonical.trim() || group.variants.every((v) => v.value === canonical)}
          onClick={() => onMerge(canonical.trim())}
        >{mergeLabel}</button>
      </div>
    </div>
  );
}

// One duplicate group: pick the record that survives, tick the ones folded into
// it, preview, then merge. Nothing is decided for the librarian — the catalogue
// legitimately contains different printings that share a title and an author,
// and only a person can tell those from a record entered twice.
function MergeGroupCard({ group, t, onPreview, onMerge }: {
  group: MergeCandidateGroup;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onPreview: (keepId: string, mergeIds: string[]) => Promise<MergePreview | null>;
  onMerge: (keepId: string, mergeIds: string[]) => Promise<boolean>;
}) {
  // Default to the fullest record: merging INTO the emptier one would mean
  // rescuing every field across, and the result is the same record either way.
  const fullest = [...group.books].sort((a, b) => b.filledFields - a.filledFields)[0];
  const [keepId, setKeepId] = useState(fullest?.id ?? '');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(group.books.map((b) => b.id)));
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const mergeIds = group.books.map((b) => b.id).filter((id) => id !== keepId && chosen.has(id));
  // A record on loan cannot be folded away: the loan points at it, and moving
  // that would rewrite a borrower's history under them.
  const blocked = group.books.filter((b) => mergeIds.includes(b.id) && b.openLoans > 0);
  const canMerge = mergeIds.length > 0 && blocked.length === 0 && !busy && !done;

  // Every record in a group has the SAME title — that is what put them in one
  // group — so a label built from the title alone reads identically on every
  // row to a screen reader. The shelf is what actually tells them apart, and it
  // is the reason the duplicate exists.
  function describe(b: MergeCandidateBook): string {
    const where = b.items.map((i) => i.shelfCode).filter(Boolean).join(', ');
    return where ? `${b.title} — ${where}` : b.title;
  }

  function toggle(id: string) {
    setPreview(null);
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (done) {
    return (
      <div className="variant-group">
        <p className="muted small" style={{ margin: 0 }}>✓ {t('settings.merge.doneRow', { n: mergeIds.length + 1 })}</p>
      </div>
    );
  }

  return (
    <div className="variant-group merge-group">
      <table className="merge-table">
        <thead>
          <tr>
            <th scope="col">{t('settings.merge.keep')}</th>
            <th scope="col">{t('settings.merge.fold')}</th>
            <th scope="col">{t('library.add.bookTitle')}</th>
            <th scope="col">{t('library.add.publisher')}</th>
            <th scope="col">{t('library.add.year')}</th>
            <th scope="col">{t('settings.merge.copies')}</th>
            <th scope="col">{t('settings.merge.filled')}</th>
          </tr>
        </thead>
        <tbody>
          {group.books.map((b) => (
            <tr key={b.id} className={b.id === keepId ? 'is-keeper' : ''}>
              <td>
                <input
                  type="radio"
                  name={`keep-${group.key}`}
                  checked={b.id === keepId}
                  aria-label={t('settings.merge.keepThis', { title: describe(b) })}
                  onChange={() => { setKeepId(b.id); setPreview(null); }}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={b.id !== keepId && chosen.has(b.id)}
                  disabled={b.id === keepId}
                  aria-label={t('settings.merge.foldThis', { title: describe(b) })}
                  onChange={() => toggle(b.id)}
                />
              </td>
              <td>
                {b.title}
                {b.author ? <span className="muted small"> · {b.author}</span> : null}
                {b.openLoans > 0 ? <span className="badge warn">{t('settings.merge.onLoan')}</span> : null}
              </td>
              <td className="muted small">{b.publisher || '—'}</td>
              <td className="muted small">{b.dateEdtf || '—'}</td>
              <td className="muted small">
                {b.items.length === 0 ? '—' : b.items.map((i) => i.shelfCode || '—').join(', ')}
              </td>
              <td className="muted small">{b.filledFields}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {group.differingFields.length > 0 && (
        <p className="muted small" style={{ margin: '0.5rem 0 0' }}>
          {t('settings.merge.differs', { fields: group.differingFields.join(', ') })}
        </p>
      )}
      {blocked.length > 0 && (
        <p className="small" style={{ margin: '0.5rem 0 0', color: 'var(--danger)' }}>
          {t('settings.merge.blockedLoan')}
        </p>
      )}

      {preview && (
        <div className="merge-preview">
          <p className="small" style={{ margin: 0 }}>
            {t('settings.merge.previewCopies', { n: preview.copiesAfter, removed: preview.recordsRemoved })}
          </p>
          {Object.keys(preview.wouldFillFields).length > 0 && (
            <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
              {t('settings.merge.previewFills', { fields: Object.keys(preview.wouldFillFields).join(', ') })}
            </p>
          )}
          {Object.keys(preview.wouldRescueAttributes).length > 0 && (
            <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
              {t('settings.merge.previewAttrs', { fields: Object.keys(preview.wouldRescueAttributes).join(', ') })}
            </p>
          )}
          {preview.wouldAddTags.length > 0 && (
            <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
              {t('settings.merge.previewTags', { tags: preview.wouldAddTags.join(', ') })}
            </p>
          )}
        </div>
      )}

      <div className="variant-merge-row" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="secondary small"
          disabled={mergeIds.length === 0 || busy}
          onClick={async () => {
            setBusy(true);
            try { setPreview(await onPreview(keepId, mergeIds)); } finally { setBusy(false); }
          }}
        >{t('settings.merge.preview')}</button>
        <button
          type="button"
          className="primary small"
          disabled={!canMerge}
          onClick={async () => {
            setBusy(true);
            try { if (await onMerge(keepId, mergeIds)) setDone(true); } finally { setBusy(false); }
          }}
        >{t('settings.merge.doIt', { n: mergeIds.length })}</button>
      </div>
    </div>
  );
}



// ── Custom right-click context menu ─────────────────────────────────────────
// A single app-owned menu that replaces the browser's native one on the app's
// own surfaces. Menu items are built in App scope (so they can call the app's
// handlers + read the permission gates) and handed to this pure renderer, which
// only positions the menu, clamps it to the viewport, and handles dismissal +
// keyboard navigation.
type CtxItem =
  | { sep: true }
  | { header: string }
  | { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean };

interface CtxMenuState {
  x: number;
  y: number;
  items: CtxItem[];
  title?: string;
}

// Drop empty groups: leading/trailing/duplicate separators and headers that end
// up with no actionable item beneath them, so a permission-filtered menu never
// shows a stray divider or an empty section.
function pruneCtxItems(items: CtxItem[]): CtxItem[] {
  const out: CtxItem[] = [];
  for (const it of items) {
    if ('sep' in it) {
      if (out.length === 0) continue;
      const prev = out[out.length - 1];
      if ('sep' in prev || 'header' in prev) continue;
      out.push(it);
    } else if ('header' in it) {
      // Collapse a header that immediately follows another header/sep-less start.
      if (out.length > 0 && 'header' in out[out.length - 1]) out.pop();
      out.push(it);
    } else {
      out.push(it);
    }
  }
  // Trim trailing separators / dangling headers.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if ('sep' in last || 'header' in last) out.pop();
    else break;
  }
  // Drop any header not immediately followed by an actionable item — otherwise a
  // header whose whole section was permission-filtered would mislabel whatever
  // section comes next.
  return out.filter((it, i) => {
    if (!('header' in it)) return true;
    const next = out[i + 1];
    return next !== undefined && !('sep' in next) && !('header' in next);
  });
}

function ContextMenuView({ state, onClose }: { state: CtxMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The element focused when the menu opened, so focus can return there on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; ready: boolean }>({ x: state.x, y: state.y, ready: false });

  // Measure then clamp inside the viewport (shift so the menu never spills
  // off-screen). Runs before paint. Also remember the trigger element (still
  // focused at this point) so we can restore focus when the menu closes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!triggerRef.current) triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = state.x;
    let y = state.y;
    if (x + w + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - w - pad);
    if (y + h + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - h - pad);
    setPos({ x, y, ready: true });
  }, [state.x, state.y, state.items]);

  // Focus the first item only AFTER the menu is visible — a visibility:hidden
  // element cannot receive focus, so focusing inside the clamp effect (while
  // still hidden) would silently no-op.
  useEffect(() => {
    if (pos.ready) ref.current?.querySelector<HTMLButtonElement>('button.ctx-item:not([disabled])')?.focus();
  }, [pos.ready]);

  // Return focus to the trigger when the menu unmounts (any close path), so
  // keyboard users don't get dumped at the top of the document.
  useEffect(() => () => {
    const el = triggerRef.current;
    if (el && document.body.contains(el)) el.focus?.();
  }, []);

  // Dismiss on any outside press, page scroll, resize, or window blur. Wheel and
  // mousedown are guarded so scrolling/clicking INSIDE the menu doesn't close it
  // (the menu can scroll when it is taller than the viewport). Escape is handled
  // by the App-level key handler so it takes priority over the modals.
  useEffect(() => {
    const isOutside = (t: EventTarget | null) => !ref.current || !ref.current.contains(t as Node);
    const onDown = (e: MouseEvent) => { if (isOutside(e.target)) onClose(); };
    const onWheel = (e: WheelEvent) => { if (isOutside(e.target)) onClose(); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') { e.preventDefault(); onClose(); return; }
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button.ctx-item:not([disabled])') ?? []);
    if (btns.length === 0) return;
    const idx = btns.findIndex((b) => b === document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(idx + 1) % btns.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(idx - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={state.title}
      style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={onKeyDown}
    >
      {state.title ? <div className="ctx-menu-title" title={state.title}>{state.title}</div> : null}
      {state.items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="ctx-sep" role="separator" />;
        if ('header' in it) return <div key={i} className="ctx-menu-header">{it.header}</div>;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            title={it.label}
            onClick={() => { onClose(); it.onClick(); }}
          >
            <span className="ctx-icon" aria-hidden="true">{it.icon ?? ''}</span>
            <span className="ctx-label">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The cover lightbox.
 *
 * ITS OWN COMPONENT for one reason: `useModalFocus` locks page scrolling for as long as it
 * is mounted, and a hook cannot be called conditionally. Calling it from App — which is
 * where this started — set `document.body.style.overflow = 'hidden'` on first render and
 * never released it, so the whole application became unscrollable whether or not a cover
 * was open. Mounting the hook WITH the overlay is what makes "lock the page behind the
 * dialog" mean the dialog.
 *
 * What it fixes, and why it needs the hook at all: the overlay declared `aria-modal` and
 * managed nothing. Focus stayed behind it on the detail dialog, so Tab walked the page
 * underneath, its own ✕ could never be reached, Escape did nothing, and closing did not
 * restore focus. It was the only role="dialog" in the app that skipped this helper — the
 * helper that exists, in its own comment, "so an overlay that cannot use Dialog's markup
 * can still get Dialog's behaviour from the same lines".
 */
function CoverLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 'container' because the overlay's only control is its ✕, and focusing the container
  // keeps the Escape/Tab handler on the element that owns them.
  useModalFocus(boxRef, 'container');
  return (
    <div
      ref={boxRef}
      className="lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('detail.coverZoomAria')}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
          return;
        }
        trapTab(boxRef.current, e);
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        title={t('common.close')}
        aria-label={t('common.close')}
      >✕</button>
      {/* Clicking anywhere (backdrop or the image) closes — matches the hint. */}
      <img className="lightbox-img" src={src} alt={t('detail.coverZoomAria')} />
    </div>
  );
}

/**
 * The edit form's fields, read off a book.
 *
 * ONE mapping, because there are two ways into the editor — the Library tab's edit action and
 * the detail panel's Edit button — and they used to carry their own copies of this 16-field
 * snapshot. They drifted: only one of them recorded the baseline that `saveBookEdit` diffs
 * against, so a version conflict opened from the detail panel (the button librarians actually
 * use) still sent a whole stale record. Every opener goes through here now.
 */
/**
 * Bring the first invalid field into view and put the cursor in it.
 *
 * Both submit gates said "focus the first one" in a comment and focused only the TITLE. A book
 * whose sole problem was a missing required attribute got a red border, an aria-invalid, and a
 * toast in the corner — while the field itself sat several screens below the fold, or below the
 * fold of the detail modal's `max-height: 90vh` scroll box. The librarian read a label in the
 * corner and then hunted a form of two dozen attributes for it.
 *
 * Chosen by DOCUMENT ORDER rather than from the error set, because the form renders pinned
 * attributes in their own group at the top: the first key in the set is not the first field on
 * screen, and "first" has to mean what the librarian sees.
 *
 * Deferred by a timeout so React has committed the aria-invalid attributes this queries for.
 * A frame callback would be the other way, but this runs from a submit — a tab that is not
 * visible cannot have one, and rAF does not fire in a hidden tab.
 */
function focusFirstInvalidField(): void {
  setTimeout(() => {
    const first = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!first) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    first.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    // preventScroll, or focus() fights the scrollIntoView above and lands the field under the
    // sticky header.
    first.focus({ preventScroll: true });
  }, 0);
}

function editFieldsFromBook(b: Book) {
  return {
    title: b.title,
    author: b.author,
    isbn: b.isbn ?? '',
    shelfCode: b.shelfCode ?? '',
    publicationYear: b.dateEdtf ?? b.publicationYear?.toString() ?? '',
    titleRomanized: b.titleRomanized ?? '',
    authorRomanized: b.authorRomanized ?? '',
    publisherRomanized: b.publisherRomanized ?? '',
    status: b.status,
    publisher: b.publisher ?? '',
    language: b.language ?? '',
    ddc: b.ddc ?? '',
    bibLevel: (b.bibLevel ?? 'monograph') as BibLevel,
    description: b.description ?? ''
  };
}

/** What the librarian was shown when the form opened — the thing a save is diffed against. */
function editBaselineFromBook(b: Book) {
  return { form: { ...editFieldsFromBook(b) } as Record<string, unknown>, attrs: { ...(b.customFields ?? {}) } };
}

function App() {
  const toast = useToast();
  const confirm = useConfirm();
  const { t, lang } = useI18n();
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  // Onboarding course: `showOnboarding` opens it as a replay overlay (from
  // Settings); the mandatory first-run gate is derived from currentUser below.
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileUsername, setProfileUsername] = useState('');
  const [profileNewPassword, setProfileNewPassword] = useState('');
  const [profileCurrentPassword, setProfileCurrentPassword] = useState('');
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [myPermissions, setMyPermissions] = useState<Record<string, boolean> | null>(null);
  const [permissionMatrix, setPermissionMatrix] = useState<{
    catalog: string[];
    matrix: Record<'admin' | 'librarian' | 'viewer', Record<string, boolean>>;
  } | null>(null);
  const [permissionMatrixLoading, setPermissionMatrixLoading] = useState(false);
  const [permissionMatrixSaving, setPermissionMatrixSaving] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [currentSection, setCurrentSection] = useState<AppSection>('books');
  const [theme, setTheme] = useState<Theme>('light');
  const [stats, setStats] = useState<StatsResponse | null>(null);

  const [books, setBooks] = useState<Book[]>([]);
  // Distinguishes a failed books fetch from a genuinely empty library so the UI
  // can show a real error + retry instead of a misleading "no books" panel.
  const [booksError, setBooksError] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  // Distinct catalog values that feed the add/edit form autocomplete so a
  // librarian rarely retypes a repeated title, author, publisher, language, or
  // shelf code. Loaded from GET /api/books/facets and refreshed after writes.
  const [facets, setFacets] = useState<CatalogFacets>({
    authors: [], publishers: [], languages: [], shelfCodes: [], customFields: {}
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [totalBooksCount, setTotalBooksCount] = useState(0);

  const [q, setQ] = useState('');
  const [qExclude, setQExclude] = useState('');
  const [qMode, setQMode] = useState<SearchMode>('all');
  const [partialWords, setPartialWords] = useState(true);
  const [fuzzyTypos, setFuzzyTypos] = useState(true);
  // Lexical = the existing FTS + fuzzy stack. Semantic = ANN over book
  // embeddings (Workers AI + Vectorize). The toggle is in advanced search;
  // when semantic mode is on we bypass the filter chips/sort UI and send
  // only `q` to the dedicated `/api/books/semantic` endpoint.
  const [searchEngine, setSearchEngine] = useState<'lexical' | 'semantic'>('lexical');
  // Health probe tells us whether the deployment has Vectorize+AI bound,
  // so we can disable the semantic option in the UI rather than offer a
  // mode that would only ever return 503.
  const [semanticAvailable, setSemanticAvailable] = useState<boolean | null>(null);
  const [searchFields, setSearchFields] = useState<SearchField[]>(['title', 'author', 'isbn']);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [status, setStatus] = useState('');
  const [filterLanguage, setFilterLanguage] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [shelfFilter, setShelfFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('updatedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [density, setDensity] = useState<Density>('comfortable');
  // Which columns the table view shows, and whether to flag empty cells.
  // `null` means "not chosen yet" → fall back to the defaults plus whatever the
  // everyday attributes currently are, so pinning a new attribute surfaces it
  // without the librarian having to re-open the picker.
  const [tableColumns, setTableColumns] = useState<string[] | null>(null);
  const [tableHighlightGaps, setTableHighlightGaps] = useState(true);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [addCopiesOpen, setAddCopiesOpen] = useState(false);
  const [addCopiesCount, setAddCopiesCount] = useState('1');
  const [addCopiesShelf, setAddCopiesShelf] = useState('');
  const [addCopiesBusy, setAddCopiesBusy] = useState(false);
  // Guards the prefs writer against clobbering stored values on first mount.
  const prefsHydratedRef = useRef(false);
  const [jumpPage, setJumpPage] = useState('');
  // Facet rail: the field being browsed, the bucket selected in it, and what
  // the server reported for that field.
  const [facetField, setFacetField] = useState('custom:category_code');
  const [facetValue, setFacetValue] = useState('');
  const [facetEmpty, setFacetEmpty] = useState(false);
  const [facetItems, setFacetItems] = useState<FacetItem[]>([]);
  const [facetTotalBooks, setFacetTotalBooks] = useState<number | null>(null);
  const [facetTruncated, setFacetTruncated] = useState(false);
  // 'Sets' is a rail mode rather than a facet field: it groups by multi-part
  // work and reports which volumes are absent, which is a different shape
  // from a value/count list.
  const [bookSets, setBookSets] = useState<SetSummary[]>([]);
  // What the rail is NOT showing. A rail that quietly omits 357 groups reads as
  // "the library has 573 sets", which is not what it means.
  const [setsMeta, setSetsMeta] = useState<{ matched: number; suppressed: number }>({ matched: 0, suppressed: 0 });
  const [setsGapsOnly, setSetsGapsOnly] = useState(false);
  const [setsLoading, setSetsLoading] = useState(false);
  const [needsReviewFilter, setNeedsReviewFilter] = useState(false);
  const [smartListKey, setSmartListKey] = useState<string>('');
  const [borrowerSuggestions, setBorrowerSuggestions] = useState<Borrower[]>([]);
  // Sequence number for borrower-autocomplete: every keystroke bumps the
  // counter and only the most recent in-flight request is allowed to
  // commit results. Prevents stale responses from overwriting a newer
  // search when responses arrive out of order on slow networks.
  const borrowerSearchSeqRef = useRef(0);
  // Debounce handle for borrower search. We still fire only the latest
  // request via the sequence counter, but coalescing keystrokes into a
  // single network call lowers the cost per typed name and reduces backend
  // pressure on the API + KV rate limiter.
  const borrowerDebounceRef = useRef<number | null>(null);
  // Books already in the catalogue whose title starts with what is being typed
  // into the add form. A duplicate WARNING, not an autocomplete — see
  // `searchTitleSuggestions`. Same debounce + sequence-guard pattern as the
  // borrower search, for the same reasons.
  const [titleSuggestions, setTitleSuggestions] = useState<TitleSuggestion[]>([]);
  const [titleSuggestTotal, setTitleSuggestTotal] = useState(0);
  const titleSuggestSeqRef = useRef(0);
  const titleSuggestDebounceRef = useRef<number | null>(null);
  const bookHistorySeqRef = useRef(0);
  // Drops results from an earlier loadBooks() call that resolves after a newer
  // one (fast typing / rapid filter changes) so a slow response can't clobber
  // the current results, total, and page.
  const loadBooksSeqRef = useRef(0);
  // Same guard for the facet rail. The rail's whole contract is that a bucket's
  // count reproduces as a filtered list, and a facet response that lands after
  // the librarian has moved to another field breaks it — see loadFacet.
  const loadFacetSeqRef = useRef(0);
  const [borrowerQuery, setBorrowerQuery] = useState('');
  const [selectedBorrowerId, setSelectedBorrowerId] = useState<string>('');
  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [showCategoryRail, setShowCategoryRail] = useState(true);
  const [categoryRailQuery, setCategoryRailQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastSearchSignatureRef = useRef<string>('');

  const [createForm, setCreateForm] = useState({
    title: '',
    author: '',
    isbn: '',
    shelfCode: '',
    publicationYear: '',
    titleRomanized: '',
    authorRomanized: '',
    publisherRomanized: '',
    publisher: '',
    language: '',
    ddc: '',
    bibLevel: 'monograph' as BibLevel,
    description: ''
  });
  const [createAttrValues, setCreateAttrValues] = useState<Record<string, unknown>>({});
  // Field keys (core: 'title'; custom: 'cf:<key>') flagged as missing-required on
  // the last add-book submit attempt, so they can be visually highlighted.
  const [createFieldErrors, setCreateFieldErrors] = useState<Set<string>>(new Set());
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  // Cover image chosen in the add-book form. It can only be uploaded once the
  // book row exists (the cover endpoint keys on the book id), so we hold the
  // File here and PUT it right after the book is created. The object-URL
  // preview is revoked by an effect when it changes / on unmount.
  const [createCoverFile, setCreateCoverFile] = useState<File | null>(null);
  const [createCoverPreview, setCreateCoverPreview] = useState<string | null>(null);

  const [editForm, setEditForm] = useState({
    id: '',
    title: '',
    author: '',
    isbn: '',
    shelfCode: '',
    publicationYear: '',
    titleRomanized: '',
    authorRomanized: '',
    publisherRomanized: '',
    status: 'available' as BookStatus,
    version: 0,
    publisher: '',
    language: '',
    ddc: '',
    bibLevel: 'monograph' as BibLevel,
    description: ''
  });
  // Missing-required field keys flagged on the last edit-save attempt (mirrors
  // createFieldErrors), so an existing book can't be saved with its title blanked.
  const [editFieldErrors, setEditFieldErrors] = useState<Set<string>>(new Set());
  const editTitleInputRef = useRef<HTMLInputElement | null>(null);

  const [fieldForm, setFieldForm] = useState({
    key: '',
    label: '',
    type: 'text' as 'text' | 'number' | 'boolean' | 'date' | 'enum',
    required: false,
    // Pinned attributes lead every attribute list. `sortOrder` positions the
    // field within its group; ties fall back to the label.
    pinned: false,
    sortOrder: 0,
    enumOptionsCsv: ''
  });
  const [editingCustomFieldId, setEditingCustomFieldId] = useState<string | null>(null);

  const [importDryRun, setImportDryRun] = useState(true);
  const [importFileName, setImportFileName] = useState('');

  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [borrowerName, setBorrowerName] = useState('');
  const [borrowerContact, setBorrowerContact] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [scanCode, setScanCode] = useState('');
  const [scanResult, setScanResult] = useState<string>('');
  const [activeBorrows, setActiveBorrows] = useState<ActiveBorrow[]>([]);
  const [auditItems, setAuditItems] = useState<AuditLogItem[]>([]);
  const [staffUsers, setStaffUsers] = useState<StaffUser[]>([]);
  const [staffUsersLoading, setStaffUsersLoading] = useState(false);
  const [newUserUsername, setNewUserUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<StaffRole>('viewer');
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editUserPassword, setEditUserPassword] = useState('');
  const [bookHistory, setBookHistory] = useState<BorrowHistoryItem[]>([]);
  const [bookHistoryHasMore, setBookHistoryHasMore] = useState(false);
  const [roomSummary, setRoomSummary] = useState<RoomSummaryItem[]>([]);
  const [unassignedSummary, setUnassignedSummary] = useState({
    totalBooks: 0,
    availableBooks: 0,
    borrowedBooks: 0,
    lostBooks: 0,
    maintenanceBooks: 0
  });
  const [attributeEditorValues, setAttributeEditorValues] = useState<Record<string, unknown>>({});
  // Book selection for bulk actions. Persisted per-tab so a reload (or an
  // accidental navigation) doesn't silently throw away a long selection the
  // librarian built up across several pages.
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem(SELECTION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  });
  // When false, per-row checkboxes are hidden. The user must click "Select"
  // in the section header to enter selection mode. This keeps the default
  // browsing surface uncluttered — nothing is selectable until requested.
  const [selectionMode, setSelectionMode] = useState(false);
  const [detailBook, setDetailBook] = useState<Book | null>(null);
  const [copiesEditorOpen, setCopiesEditorOpen] = useState(false);
  const [serialsEditorOpen, setSerialsEditorOpen] = useState(false);
  const [serialHoldings, setSerialHoldings] = useState<SerialHolding[]>([]);
  const [detailMode, setDetailMode] = useState<'view' | 'edit'>('view');
  // Full-screen cover zoom (lightbox). Holds the resolved cover URL while open,
  // null while closed. Opened by clicking the large cover in the detail view.
  const [coverZoom, setCoverZoom] = useState<string | null>(null);
  // Custom right-click menu: null when closed, else its screen position + items.
  const [contextMenu, setContextMenu] = useState<CtxMenuState | null>(null);
  // A hidden file input reused by the "Replace/Add cover" menu item — the book
  // to attach the chosen file to is stashed in a ref while the picker is open.
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const coverUploadBookRef = useRef<Book | null>(null);
  const [showAddBook, setShowAddBook] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string>('');
  // Full bulk editor. Values are keyed 'core:<bookKey>' or 'cf:<attributeKey>';
  // a key is only written if it appears in `bulkEditValues` (set it) or in
  // `bulkEditClears` (blank it). Anything absent from BOTH is left untouched —
  // an empty text box must never mean "erase this on 300 books".
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditValues, setBulkEditValues] = useState<Record<string, string>>({});
  const [bulkEditClears, setBulkEditClears] = useState<Set<string>>(new Set());
  const [bulkTagsAdd, setBulkTagsAdd] = useState('');
  const [bulkTagsRemove, setBulkTagsRemove] = useState('');
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  // Value-consistency tool: fold-equivalent spelling variants of a field.
  type VariantField = 'author' | 'publisher' | 'language' | 'shelfCode' | 'title';
  const [variantField, setVariantField] = useState<VariantField>('publisher');
  const [valueVariants, setValueVariants] = useState<ValueVariantGroup[]>([]);
  // Duplicate-record merge tool.
  const [mergeGroups, setMergeGroups] = useState<MergeCandidateGroup[]>([]);
  const [mergeTotal, setMergeTotal] = useState(0);
  const [mergeStrict, setMergeStrict] = useState(true);
  const [mergeQuery, setMergeQuery] = useState('');
  // Circulation: the hold shelf, and the rules that decide loan periods.
  const [holds, setHolds] = useState<Hold[]>([]);
  const [loanPolicies, setLoanPolicies] = useState<LoanPolicy[]>([]);
  const [policyCategories, setPolicyCategories] = useState<string[]>([]);
  const [policyItemTypes, setPolicyItemTypes] = useState<string[]>([]);
  const [policiesLoaded, setPoliciesLoaded] = useState(false);
  const [detailHolds, setDetailHolds] = useState<Hold[]>([]);
  // Barcode scanning: a handheld scanner is a keyboard that types a whole code
  // then Enter, so the surface it needs is just a focused text input.
  const [scanHit, setScanHit] = useState<ScanHit | null>(null);
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  // ISO 2789: the international library statistics return.
  const [isoReport, setIsoReport] = useState<Iso2789Report | null>(null);
  const [isoBusy, setIsoBusy] = useState(false);
  const [isoFrom, setIsoFrom] = useState(`${new Date().getUTCFullYear()}-01-01`);
  const [isoTo, setIsoTo] = useState(new Date().toISOString().slice(0, 10));
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeScanned, setMergeScanned] = useState(false);
  const [variantsScanned, setVariantsScanned] = useState(false);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [showDuplicatesPanel, setShowDuplicatesPanel] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateEntry[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [didBootstrapData, setDidBootstrapData] = useState(false);
  const [isLoadingBooks, setIsLoadingBooks] = useState(false);

  const splashStartRef = useRef(0);
  const splashActiveRef = useRef(false);
  const [showSplash, setShowSplash] = useState(false);
  const [splashHiding, setSplashHiding] = useState(false);
  // Reflects whether the most-recent network call hit the server (`online`)
  // or had to fall back to the IndexedDB cache (`offline`). Drives the
  // banner that informs librarians they're working with stale data.
  const [netStatus, setNetStatusUI] = useState<NetStatus>('online');
  useEffect(() => subscribeNetStatus(setNetStatusUI), []);
  // Release the add-book cover preview's object URL when it is replaced or the
  // component unmounts, so staging several covers doesn't leak blobs.
  useEffect(() => {
    if (!createCoverPreview) return;
    return () => URL.revokeObjectURL(createCoverPreview);
  }, [createCoverPreview]);
  // NOTE: the selection deliberately SURVIVES paging, searching, filtering and
  // sorting. It is a set of book ids, and every bulk action resolves those ids
  // to their live rows via GET /api/books/by-ids (which supplies each book's
  // current `version`), so an action always applies to the whole selection —
  // not just the page that happens to be loaded. Only the user clears it, via
  // "Clear selection" (or sign-out); the app never drops it behind their back.
  // Selection is mirrored into sessionStorage so an accidental reload keeps it.
  useEffect(() => {
    try {
      if (selectedBookIds.length === 0) sessionStorage.removeItem(SELECTION_STORAGE_KEY);
      else sessionStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selectedBookIds));
    } catch { /* private mode / quota — selection still works in memory */ }
  }, [selectedBookIds]);
  // Browser-level offline events flip us back to "offline" immediately so
  // we don't have to wait for the next failing fetch to update the UI.
  useEffect(() => {
    const onOffline = () => setNetStatusUI('offline');
    const onOnline = () => setNetStatusUI('online');
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  const queuedToastsRef = useRef<Array<{ type: 'success' | 'error'; text: string }>>([]);

  const pushAppToast = useCallback((type: 'success' | 'error', text: string) => {
    if (!text) return;
    if (splashActiveRef.current) {
      queuedToastsRef.current.push({ type, text });
      return;
    }
    toast.push(type, text);
  }, [toast]);

  // Bridge legacy message/error calls to the toast stack while holding
  // notifications until the splash screen is fully gone.
  const setMessage = useCallback((m: string) => {
    pushAppToast('success', m);
  }, [pushAppToast]);
  const setError = useCallback((e: string) => {
    pushAppToast('error', e);
  }, [pushAppToast]);

  const beginSplash = useCallback(() => {
    splashActiveRef.current = true;
    splashStartRef.current = Date.now();
    setSplashHiding(false);
    setShowSplash(true);
  }, []);

  useEffect(() => {
    if (showSplash || queuedToastsRef.current.length === 0) {
      return;
    }
    const queued = queuedToastsRef.current;
    queuedToastsRef.current = [];
    for (const item of queued) {
      toast.push(item.type, item.text);
    }
  }, [showSplash, toast]);

  const loggedIn = Boolean(currentUser);

  // Mirror `loggedIn` into a ref so the module-level 401 handler can tell a real
  // session expiry from the anonymous first-load probe without re-subscribing.
  const loggedInRef = useRef(false);
  useEffect(() => { loggedInRef.current = loggedIn; }, [loggedIn]);

  // Centralized 401 handling: when the server rejects auth after we believed we
  // were signed in (expired token/cookie), drop to the login screen with a clear
  // message instead of leaving the user on a stale shell showing "no books".
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!loggedInRef.current) return; // ignore the anonymous session probe
      setCurrentUser(null);
      setDidBootstrapData(false);
      // setError, not setMessage. `setMessage` is pushAppToast('success', …): being thrown
      // out of the application was announced as a GREEN success toast that auto-dismissed
      // after four seconds, so a librarian who looked away came back to a login screen
      // with no explanation of why. Error toasts are red, carry role="alert" and never
      // time out.
      setError(t('login.sessionExpired'));
    });
    return () => setUnauthorizedHandler(null);
  }, [t]);

  // Restore session on first load. Uses the stored bearer token (Safari) or the
  // session cookie (other browsers), whichever is available.
  useEffect(() => {
    apiRequest<SessionResponse>('/api/auth/session')
      .then((res) => {
        beginSplash();
        setCurrentUser(res.user);
      })
      .catch(() => { /* no session */ })
      .finally(() => setSessionLoading(false));
  }, [beginSplash]);

  // Load app data once an authenticated session is available (fresh login or restored cookie session).
  useEffect(() => {
    if (!loggedIn || didBootstrapData) {
      return;
    }

    void refreshEverything().then(() => {
      setDidBootstrapData(true);
    });
  }, [loggedIn, didBootstrapData]);

  // Dismiss the splash screen after 3 seconds minimum AND once data is ready.
  useEffect(() => {
    if (!showSplash) return;
    const dataReady = !sessionLoading && loggedIn && didBootstrapData;
    if (!dataReady) return;
    const elapsed = Date.now() - splashStartRef.current;
    const remaining = Math.max(0, 3000 - elapsed);
    const timer = setTimeout(() => {
      setSplashHiding(true);
      setTimeout(() => {
        splashActiveRef.current = false;
        setShowSplash(false);
      }, 400);
    }, remaining);
    return () => clearTimeout(timer);
  }, [showSplash, sessionLoading, loggedIn, didBootstrapData]);

  // Publish the header's real height as `--navbar-h`.
  //
  // Two sticky offsets used to hard-code it — the bulk-action bar at 60px and the
  // category rail at 76px — which was safe only while the header was `height: 60px`.
  // It now wraps when its contents do not fit (a long username, or Greek on a phone),
  // and a 76px header covered the top of the bulk bar, i.e. the strip that holds bulk
  // edit and bulk delete. Measured rather than assumed, so the next thing added to the
  // header cannot silently break the two things pinned below it.
  useEffect(() => {
    let raf = 0;
    const publish = () => {
      const el = document.querySelector('.simple-navbar');
      if (!el) return;
      const h = Math.round(el.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--navbar-h', `${h}px`);
    };
    // Coalesce to one write per frame: a viewport drag fires both the observer and the
    // resize listener many times, and this only needs the settled value.
    const schedule = () => {
      // A hidden tab does not run animation frames, so batching through one there would
      // hold a stale height until the tab came back. Nothing is painting while hidden,
      // so publish straight away and keep the frame batching for the visible case,
      // where a viewport drag fires this many times a second.
      if (document.hidden) { publish(); return; }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(publish);
    };
    // The FIRST publish is synchronous, not scheduled: `requestAnimationFrame` does not
    // run in a hidden or background tab, so coalescing the initial value through it left
    // `--navbar-h` unset — and everything pinned below the header then fell back to the
    // hard-coded 60px this effect exists to replace. Only the later, repeated events are
    // worth batching.
    publish();
    // BOTH signals, deliberately. A ResizeObserver on the header alone did not fire when
    // the viewport narrowed enough to wrap it — measured: header 76px while
    // --navbar-h was still 60px — so the window listener is what actually catches the
    // reflow, and the observer catches the cases the window does not: a longer username
    // arriving, a language change, a control appearing.
    window.addEventListener('resize', schedule);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule);
      const el = document.querySelector('.simple-navbar');
      if (el) ro.observe(el);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [loggedIn, lang]);

  // Restore UI preferences (sort, density, theme) from localStorage so the app feels personal across sessions.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      // The OS preference is consulted even with NOTHING saved.
      //
      // This effect used to `return` here when no prefs blob existed, and the
      // prefers-color-scheme fallback sat at the bottom of the same try block — so it
      // was reachable only for someone who already had a saved blob with no theme key
      // in it. A librarian opening the app for the FIRST time on a machine set to dark
      // got a full-brightness white screen, which is the one case the fallback was
      // written for.
      if (!raw) {
        if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) setTheme('dark');
        return;
      }
      const prefs = JSON.parse(raw) as {
        sortBy?: SortBy; sortDir?: SortDir; density?: Density; theme?: Theme;
        tableColumns?: string[]; tableHighlightGaps?: boolean;
      };
      if (prefs.sortBy) setSortBy(prefs.sortBy);
      if (prefs.sortDir) setSortDir(prefs.sortDir);
      // Validate rather than trust: the blob is user-editable, and an unknown
      // density would render neither grid nor table.
      if (prefs.density && DENSITIES.includes(prefs.density)) setDensity(prefs.density);
      if (Array.isArray(prefs.tableColumns)) setTableColumns(prefs.tableColumns.filter((k) => typeof k === 'string'));
      if (typeof prefs.tableHighlightGaps === 'boolean') setTableHighlightGaps(prefs.tableHighlightGaps);
      if (prefs.theme) setTheme(prefs.theme);
      else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) setTheme('dark');
    } catch {
      // Ignore — corrupted prefs shouldn't break the app.
    }
  }, []);

  useEffect(() => {
    // Skip the very first run. Both this and the restore effect fire in the
    // same mount commit, and this one would otherwise write the INITIAL state
    // (density 'comfortable', no columns) straight over what was just read back
    // — the restored values only reach state on the following render. Observed
    // in practice: the chosen columns survived a reload but the layout did not.
    if (!prefsHydratedRef.current) {
      prefsHydratedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({
        sortBy, sortDir, density, theme, tableColumns, tableHighlightGaps
      }));
    } catch {
      // Storage may be disabled (private mode); ignore.
    }
  }, [sortBy, sortDir, density, theme, tableColumns, tableHighlightGaps]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Power-user shortcuts: "/" focuses search, "Esc" closes the open detail modal.
  useEffect(() => {
    if (!loggedIn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key === 'Escape') {
        // Layered dismissal, top-most first: context menu → cover lightbox →
        // detail modal. Each returns so Escape only peels off one layer.
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        // The cover lightbox sits on top of the detail modal, so Escape must
        // close the lightbox FIRST and leave the detail modal open.
        if (coverZoom) {
          setCoverZoom(null);
          return;
        }
        if (detailBook) {
          setDetailBook(null);
          setDetailMode('view');
          setBookHistory([]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loggedIn, detailBook, coverZoom, contextMenu]);

  // Body-scroll locking lives in <Dialog> now. It used to be duplicated here,
  // and the two RACED: this effect set overflow:hidden first, Dialog then
  // captured 'hidden' as the value to restore, and closing the modal left the
  // page permanently unscrollable. Measured in the browser, not reasoned about.

  const availableBooksFromSummary =
    roomSummary.reduce((sum, room) => sum + Number(room.available_books ?? 0), 0) + Number(unassignedSummary.availableBooks ?? 0);
  const borrowedBooksFromSummary =
    roomSummary.reduce((sum, room) => sum + Number(room.borrowed_books ?? 0), 0) + Number(unassignedSummary.borrowedBooks ?? 0);
  const availableBooksDisplay = fmt(availableBooksFromSummary);
  const borrowedBooksDisplay = fmt(borrowedBooksFromSummary);
  /*
   * THE FOUR TILES DO NOT COUNT THE SAME THING.
   *
   * "Total books" is `response.total` — the FILTERED count, which is the point of it. But
   * Available and Borrowed are summed from /api/rooms/summary and Overdue from the active
   * loans, and none of those three takes a filter parameter. So searching for "Χρυσόστομος"
   * gave a row reading 41 / 13.006 / 3 / 0: one number about the search beside three about
   * the whole catalogue, with nothing to say so. A librarian reading it left to right
   * concludes 41 books of which 13.006 are available.
   *
   * The three keep their meaning and are labelled with it. Deriving them from the filtered
   * query instead would be the richer fix, but it needs a status facet per keystroke, and
   * saying plainly what a number counts is worth more than making it agree.
   */
  const filtersActive = Boolean(
    q || qExclude || status || filterLanguage || filterYear
    // `facetField` is deliberately NOT here: it is which field the category rail is
    // BROWSING and it always has a value (it defaults to custom:category_code), so
    // including it made every tile carry the caption on a completely unfiltered page.
    // Only a chosen bucket narrows the list.
    || facetValue || facetEmpty || needsReviewFilter || shelfFilter || smartListKey
  );
  const overdueCount = activeBorrows.filter((item) => item.isOverdue).length;
  const dueSoonCount = activeBorrows.filter((item) => {
    if (item.isOverdue) {
      return false;
    }
    const diffMs = new Date(item.dueAt).getTime() - Date.now();
    return diffMs > 0 && diffMs <= 48 * 60 * 60 * 1000;
  }).length;

  // How many of the currently-visible books are part of the (possibly much
  // larger, cross-page) selection — drives the "select all / deselect" links.
  const selectedOnPageCount = books.reduce((n, b) => (selectedBookIds.includes(b.id) ? n + 1 : n), 0);

  const role = currentUser?.role ?? null;
  const isAdmin = role === 'admin';
  // The onboarding course is MANDATORY (no bypass) on first sign-in for the
  // librarian role — the people who catalogue. Gate on `role` (synchronous from
  // currentUser) rather than a permission so it can't flicker while the
  // permission matrix is still loading. Everyone can replay it from Settings.
  const mustOnboard = role === 'librarian' && Boolean(currentUser?.needsOnboarding);
  // Permission helper: admins always have everything; for other roles consult
  // the matrix fetched from /api/me/permissions. Falls back to `false` until
  // the permissions are loaded.
  const can = (perm: string): boolean => {
    if (isAdmin) return true;
    return Boolean(myPermissions?.[perm]);
  };
  const canWrite = can('books.write');
  const canDelete = can('books.delete');
  const canImport = can('import');
  const canPrintLabels = can('labels.print');
  const canExportCsv = can('export.csv');
  const canManageCustomFields = isAdmin || can('customFields.manage');
  const canSeeSettings = isAdmin || can('settings');
  const canSeeDashboard = isAdmin || can('dashboard');
  const canSeeCirculation = isAdmin || can('circulation');

  const sectionMeta: Array<{ key: AppSection; label: string; icon: string }> = [
    { key: 'books', label: t('tab.books'), icon: '📚' },
    ...(canSeeCirculation ? [{ key: 'circulation' as AppSection, label: t('tab.circulation'), icon: '🔁' }] : []),
    ...(canImport ? [{ key: 'import' as AppSection, label: t('tab.import'), icon: '⇅' }] : []),
    ...(canSeeDashboard ? [{ key: 'dashboard' as AppSection, label: t('tab.dashboard'), icon: '📊' }] : []),
    ...(canSeeSettings ? [{ key: 'settings' as AppSection, label: t('tab.settings'), icon: '⚙️' }] : []),
    // Visible to every role. A viewer who cannot change a record still has to be
    // able to look up what a field means.
    { key: 'handbook' as AppSection, label: t('tab.handbook'), icon: '📖' }
  ];

  // If the user lands on a section they no longer have access to (after role
  // change or first login as a non-admin), bounce them to the always-visible
  // Library tab so they don't see a blank screen.
  useEffect(() => {
    if (!currentUser) return;
    const allowed = new Set<AppSection>(['books', 'handbook']);
    if (canSeeCirculation) allowed.add('circulation');
    if (canImport) allowed.add('import');
    if (canSeeDashboard) allowed.add('dashboard');
    if (canSeeSettings) allowed.add('settings');
    if (!allowed.has(currentSection)) {
      setCurrentSection('books');
    }
  }, [currentUser, currentSection, canSeeCirculation, canImport, canSeeDashboard, canSeeSettings]);

  // Kept as a no-op for back-compat with call sites; the toast layer auto-
  // dismisses now so we no longer need to wipe state on every action.
  function clearStatus() {
    /* intentional: toasts manage their own lifecycle */
  }

  async function runAction<T>(operation: () => Promise<T>): Promise<T> {
    setIsWorking(true);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        // ONLY when a session actually existed. A 401 from the login request itself means
        // the password was wrong, not that anything expired — and this branch reported
        // "Session expired. Please sign in again." to somebody who was already on the
        // sign-in screen and had never been signed in. `login()`'s own catch then showed
        // the same string a second time. `loggedInRef` is the same test the unauthorized
        // handler uses, so the two agree about what a session is.
        if (loggedInRef.current) {
          setCurrentUser(null);
          setDidBootstrapData(false);
          setError(t('login.sessionExpired'));
        }
      }
      throw error;
    } finally {
      setIsWorking(false);
    }
  }

  // Convert one form-input value into the type the server expects for that
  // custom-field definition. Empty/missing → null (skip from payload).
  function coerceCustomFieldValue(field: CustomField, raw: unknown): unknown {
    if (raw === '' || raw === undefined || raw === null) return null;
    if (field.type === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    if (field.type === 'boolean') {
      if (typeof raw === 'boolean') return raw;
      const t = String(raw).toLowerCase();
      return t === 'true' || t === 'yes' || t === '1' || t === 'on';
    }
    if (field.type === 'date') {
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return String(raw);
  }

  // Walk the form values once and build the {key: value} object the API accepts.
  // Throws when a required field is missing so callers can surface a single
  // error instead of letting the server reject after a round-trip.
  function buildCustomFieldsPayload(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const requiredMissing: string[] = [];
    for (const field of customFields) {
      const raw = values[field.key];
      const empty = raw === undefined || raw === null || raw === '';
      if (field.required && empty) {
        requiredMissing.push(field.label);
        continue;
      }
      if (empty) continue;
      const v = coerceCustomFieldValue(field, raw);
      if (v === null || v === undefined) {
        if (field.required) requiredMissing.push(field.label);
        continue;
      }
      out[field.key] = v;
    }
    if (requiredMissing.length > 0) {
      throw new Error(t('toast.requiredAttrs', { list: requiredMissing.join(', ') }));
    }
    return out;
  }

  function parsePublicationYear(raw: string): number | null {
    if (!raw.trim()) {
      return null;
    }

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 3000) {
      throw new Error(t('toast.invalidYear'));
    }

    return parsed;
  }

  function toNullableText(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const text = String(value).trim();
    return text ? text : null;
  }

  function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }

      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item).trim()).filter(Boolean);
          }
        } catch {
          // Fall back to comma-split.
        }
      }

      // Semicolons as well as commas, because the CSV export joins tags with '; ' — so the app
      // read its own two-tag record back as ONE tag named "θεολογία; πατερικά". A tag may well
      // contain a comma ("Πατέρες, Ελληνικοί"), which is exactly why the export chose the
      // semicolon; the reader simply never learned about it.
      return trimmed
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  function parseSpreadsheetCustomFields(row: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    const explicit = row.customfields;
    if (explicit && typeof explicit === 'string') {
      const trimmed = explicit.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(fields, parsed as Record<string, unknown>);
          }
        } catch {
          throw new Error(t('toast.xlsxCustomFieldsJson'));
        }
      }
    }

    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith('custom.') || key.startsWith('custom_')) {
        const fieldKey = key.replace(/^custom[._]/, '').trim();
        if (!fieldKey) {
          continue;
        }

        if (value === null || value === undefined || String(value).trim() === '') {
          continue;
        }

        fields[fieldKey] = value;
      }
    }

    /*
     * A column named after one of this catalogue's own attributes IS that attribute.
     *
     * Only the `custom_`-prefixed form was recognised, plus fourteen hardcoded aliases. Our own
     * CSV export writes every other attribute under its bare field key — issn, series,
     * signed_copy, additional_isbns, isbn_10, volume_label and the rest — so none of them could
     * be read back, and the file the code calls "this library's off-site backup" silently
     * dropped them on restore. It matches on the field key or the librarian's label, with
     * punctuation and spacing ignored, so 'Place of Publication', 'place_of_publication' and
     * 'placeOfPublication' are one column.
     *
     * A core column never becomes an attribute: `title` stays the title even if someone names
     * an attribute "Title".
     */
    const coreHeaderKeys = new Set([
      ...CORE_SPREADSHEET_ALIASES.map(normalizeColumnName),
      ...LEGACY_ID_ALIASES.map(normalizeColumnName)
    ]);
    for (const def of customFields) {
      if (fields[def.key] !== undefined) continue;
      const wanted = [def.key, def.label].filter(Boolean).map(normalizeColumnName);
      for (const [key, value] of Object.entries(row)) {
        const norm = normalizeColumnName(key);
        if (!norm || coreHeaderKeys.has(norm) || !wanted.includes(norm)) continue;
        if (value === null || value === undefined || String(value).trim() === '') continue;
        fields[def.key] = value;
        break;
      }
    }

    return fields;
  }

  /*
   * Every heading that means a CORE book column. One list, because it was two: the reader in
   * normalizeSpreadsheetRow and the "unmapped columns" warning each carried their own, and they
   * disagreed — the warning knew about 'publicationyear' while the reader looked for exactly
   * that spelling and our own export writes 'Publication Year'. So a librarian restoring from
   * the app's CSV got no warning at all and lost the field anyway.
   */
  const CORE_SPREADSHEET_ALIASES = [
    'title', 'author', 'writer', 'writers', 'isbn', 'publisher', 'language', 'description',
    'publicationyear', 'publication year', 'roomcode', 'room code', 'shelfcode', 'shelf code',
    'shelf location', 'acquisitiondate', 'acquisition date', 'tags', 'status', 'customfields',
    // Written by the export; carried so they do not read as unmapped. Nothing imports them:
    // created_at and updated_at belong to the row, not to the record's content.
    'created at', 'updated at'
  ];

  function findUnknownSpreadsheetColumns(rows: Array<Record<string, unknown>>): string[] {
    const allowedColumns = new Set([
      'title',
      'author',
      'writer',
      'id',
      'item',
      'sub title',
      'subtitle',
      'editor',
      'isbn',
      'publicationyear',
      'published date',
      'place of publication',
      'edition #',
      'edition',
      'category',
      'publisher',
      'language',
      'translator',
      'cover type',
      'pages',
      'condition',
      'shelf location',
      'description',
      'roomcode',
      'shelfcode',
      'acquisitiondate',
      'num. volume',
      'num volume',
      'color',
      'signature',
      'more copies',
      'tags',
      'status',
      'customfields',
      // Stable source key — see LEGACY_ID_ALIASES.
      'legacyid',
      'legacy id',
      'legacy_id',
      'accession',
      'accession number',
      'accessionnumber',
      'catalog id',
      'catalogue id',
      'record id'
    ]);

    const seen = new Set<string>();
    const unknown: string[] = [];

    for (const row of rows) {
      for (const originalKey of Object.keys(row)) {
        const key = originalKey.trim().toLowerCase();
        if (!key) {
          continue;
        }

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        if (allowedColumns.has(key) || key.startsWith('custom.') || key.startsWith('custom_')) {
          continue;
        }

        // Compared with punctuation and spacing ignored, and against this catalogue's own
        // attribute definitions — otherwise re-importing our own export warned about half its
        // columns, and a warning that cries wolf on the app's own file teaches librarians to
        // click through the one that matters.
        const norm = normalizeColumnName(key);
        const allowedNormalized = new Set([
          ...[...allowedColumns].map(normalizeColumnName),
          ...CORE_SPREADSHEET_ALIASES.map(normalizeColumnName),
          ...customFields.flatMap((def) => [normalizeColumnName(def.key), normalizeColumnName(def.label)])
        ]);
        if (norm && allowedNormalized.has(norm)) {
          continue;
        }

        unknown.push(originalKey);
      }
    }

    return unknown;
  }

  // Column headings that mean "this row's permanent id in the source system".
  // Ordered most-specific first so a sheet with both `accession number` and a
  // generic `id` uses the accession number.
  const LEGACY_ID_ALIASES = [
    'legacyid',
    'legacy id',
    'legacy_id',
    'accession number',
    'accessionnumber',
    'accession',
    'catalogue id',
    'catalog id',
    'record id',
    'id'
  ];

  function firstSpreadsheetValue(row: Record<string, unknown>, aliases: string[]): unknown {
    for (const alias of aliases) {
      const key = alias.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        return row[key];
      }
    }

    return null;
  }

  function parseNullableNumber(value: unknown): number | null {
    const text = toNullableText(value);
    if (!text) {
      return null;
    }

    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeColumnName(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function canonicalColumnName(input: string): string {
    const normalized = normalizeColumnName(input);

    if (normalized.includes('subtitle')) return 'subtitle';
    if (normalized.includes('edition')) return 'edition';
    if (normalized.includes('placeofpublication') || (normalized.includes('publication') && normalized.includes('place'))) {
      return 'placeofpublication';
    }
    if (normalized.includes('covertype') || normalized === 'cover') return 'covertype';
    if (normalized.includes('numvolume') || normalized.includes('volume')) return 'numvolume';
    if (normalized.includes('morecopies') || normalized.includes('copycount') || normalized === 'copies' || normalized === 'copy') {
      return 'morecopies';
    }

    return normalized;
  }

  function columnsAreSimilar(a: string, b: string): boolean {
    return canonicalColumnName(a) === canonicalColumnName(b);
  }

  function resolveImportCustomKey(preferredKey: string, labelHint: string): string {
    const exact = customFields.find((field) => field.key === preferredKey);
    if (exact) {
      return exact.key;
    }

    // The fuzzy fallback takes the FIRST match, so it must not depend on the
    // order `customFields` happens to be in — that order is a DISPLAY concern
    // (pinned attributes lead the list) and changing it must never silently
    // re-point a spreadsheet column at a different attribute. Scan a copy
    // sorted by key so the mapping is stable whatever the display order is.
    const byKey = [...customFields].sort((a, b) => a.key.localeCompare(b.key));
    const similar = byKey.find(
      (field) => columnsAreSimilar(field.key, preferredKey) || columnsAreSimilar(field.label, labelHint)
    );
    return similar?.key ?? preferredKey;
  }

  function normalizeSpreadsheetRow(raw: Record<string, unknown>, index: number): Record<string, unknown> | null {
    /*
     * Headers are indexed BOTH as written (trimmed, lowercased) and with punctuation and spacing
     * stripped, because the lookups below ask for 'publicationyear' while our own export writes
     * 'Publication Year'. That mismatch meant a restore from the app's CSV silently dropped the
     * publication year, the room and the acquisition date — measured on a real record: three
     * core fields, no warning, and the import reported success.
     *
     * The written form wins where both exist, and an empty cell never displaces a filled one, so
     * two headings that normalize alike cannot blank each other.
     */
    const written = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase(), value]));
    const row: Record<string, unknown> = { ...written };
    for (const [key, value] of Object.entries(written)) {
      const norm = normalizeColumnName(key);
      if (!norm || norm === key) continue;
      const held = row[norm];
      const heldIsEmpty = held === undefined || held === null || String(held).trim() === '';
      const incomingIsEmpty = value === null || value === undefined || String(value).trim() === '';
      if (heldIsEmpty && !incomingIsEmpty) row[norm] = value;
    }

    const isEmptyRow = Object.values(row).every((value) => toNullableText(value) === null);
    if (isEmptyRow) {
      return null;
    }

    const title = toNullableText(firstSpreadsheetValue(row, ['title']));
    // Author is optional (anonymous / liturgical editions). Only the title is
    // required. A blank author is sent as '' so the server schema accepts it
    // (it rejects null) and the row imports instead of being skipped.
    const author = toNullableText(firstSpreadsheetValue(row, ['author', 'writer', 'writers']));
    if (!title) {
      throw new SpreadsheetRowMissingError(t('toast.rowMissing', { row: index + 2 }));
    }

    const statusInput = toNullableText(firstSpreadsheetValue(row, ['status']))?.toLowerCase();
    const status: BookStatus =
      statusInput === 'available' || statusInput === 'borrowed' || statusInput === 'lost' || statusInput === 'maintenance'
        ? statusInput
        : 'available';

    const publicationYearInput = toNullableText(firstSpreadsheetValue(row, ['publicationyear']));
    let publicationYear: number | null = null;
    if (publicationYearInput) {
      publicationYear = parsePublicationYear(publicationYearInput);
    }

    const customFields = parseSpreadsheetCustomFields(row);

    const mappedCustomTextFields: Array<{ key: string; label: string; aliases: string[] }> = [
      { key: 'item', label: 'Item', aliases: ['item'] },
      { key: 'subTitle', label: 'Sub Title', aliases: ['sub title', 'subtitle'] },
      { key: 'editor', label: 'Editor', aliases: ['editor'] },
      { key: 'placeOfPublication', label: 'Place of Publication', aliases: ['place of publication'] },
      { key: 'publishedDate', label: 'Published Date', aliases: ['published date'] },
      { key: 'editionNumber', label: 'Edition #', aliases: ['edition #', 'edition'] },
      { key: 'category', label: 'Category', aliases: ['category'] },
      { key: 'translator', label: 'Translator', aliases: ['translator'] },
      { key: 'coverType', label: 'Cover Type', aliases: ['cover type'] },
      { key: 'condition', label: 'Condition', aliases: ['condition'] },
      { key: 'numVolume', label: 'Num. Volume', aliases: ['num. volume', 'num volume'] },
      { key: 'color', label: 'Color', aliases: ['color'] },
      { key: 'signature', label: 'Signature', aliases: ['signature'] },
      { key: 'moreCopies', label: 'More copies', aliases: ['more copies'] }
    ];

    for (const field of mappedCustomTextFields) {
      const resolvedKey = resolveImportCustomKey(field.key, field.label);
      if (customFields[resolvedKey] !== undefined) {
        continue;
      }

      const value = toNullableText(firstSpreadsheetValue(row, field.aliases));
      if (value !== null) {
        customFields[resolvedKey] = value;
      }
    }

    const pagesValue = parseNullableNumber(firstSpreadsheetValue(row, ['pages']));
    const pagesKey = resolveImportCustomKey('pages', 'Pages');
    if (pagesValue !== null && customFields[pagesKey] === undefined) {
      customFields[pagesKey] = pagesValue;
    }

    const numVolumeValue = parseNullableNumber(firstSpreadsheetValue(row, ['num. volume', 'num volume']));
    const numVolumeKey = resolveImportCustomKey('numVolume', 'Num. Volume');
    if (numVolumeValue !== null && customFields[numVolumeKey] === undefined) {
      customFields[numVolumeKey] = numVolumeValue;
    }

    const moreCopiesValue = parseNullableNumber(firstSpreadsheetValue(row, ['more copies']));
    const moreCopiesKey = resolveImportCustomKey('moreCopies', 'More copies');
    if (moreCopiesValue !== null && customFields[moreCopiesKey] === undefined) {
      customFields[moreCopiesKey] = moreCopiesValue;
    }

    return {
      title,
      author: author ?? '',
      // The sheet's own identifier for the record. Sending it lets a corrected
      // re-upload UPDATE the books it already created instead of adding a
      // second copy of each one.
      legacyId: toNullableText(firstSpreadsheetValue(row, LEGACY_ID_ALIASES)),
      isbn: toNullableText(firstSpreadsheetValue(row, ['isbn'])),
      publicationYear,
      publisher: toNullableText(firstSpreadsheetValue(row, ['publisher'])),
      language: toNullableText(firstSpreadsheetValue(row, ['language'])),
      description: toNullableText(firstSpreadsheetValue(row, ['description'])),
      roomCode: toNullableText(firstSpreadsheetValue(row, ['roomcode'])),
      shelfCode: toNullableText(firstSpreadsheetValue(row, ['shelfcode', 'shelf location'])),
      acquisitionDate: toNullableText(firstSpreadsheetValue(row, ['acquisitiondate'])),
      tags: parseStringArray(firstSpreadsheetValue(row, ['tags'])),
      customFields,
      status
    };
  }

  async function refreshEverything() {
    const isAdminUser = currentUser?.role === 'admin';
    // The two circulation loaders take the answer BY VALUE, from the permissions
    // request in this very batch.
    //
    // They used to be called bare, and each begins by consulting
    // `canSeeCirculation` — which is derived from `myPermissions`, which this same
    // batch was still fetching. For anyone but an admin it was `null` at that
    // instant, so both loaders early-returned, /api/borrow/active and /api/holds
    // were never requested, and `didBootstrapData` stopped the bootstrap effect
    // from ever running again: a librarian with books out saw "ACTIVE LOANS 0",
    // "All clear", no hold shelf, and a permanently-0 Overdue tile until they
    // performed a circulation action. Awaiting loadMyPermissions() first would NOT
    // have fixed it — `canSeeCirculation` is a const captured at render, and no
    // amount of awaiting changes it mid-batch — which is why the permission is
    // threaded through as an argument instead of read from state.
    const mayCirculate = loadMyPermissions().then(
      (perms) => isAdminUser || Boolean(perms?.circulation)
    );
    await Promise.all([
      loadBooks(),
      loadRoomSummary(),
      loadCustomFields(),
      loadFacets(),
      mayCirculate.then((ok) => loadActiveBorrows(ok)),
      mayCirculate.then((ok) => loadHolds(ok)),
      // audit logs + staff users are admin-only endpoints — loading them for a
      // librarian/viewer is a guaranteed 403 + a wasted Workers request each.
      ...(isAdminUser ? [loadAuditLogs(), loadStaffUsers()] : []),
      loadNeedsReviewCount(),
      loadStats(),
      mayCirculate
    ]);
  }

  // Borrower autocomplete: debounced server search; result rows let the user pick
  // an existing borrower instead of typing a duplicate name. We use a sequence
  // counter to drop stale responses (a slow earlier request returning after a
  // newer one would otherwise clobber the suggestions list).
  async function searchBorrowers(query: string): Promise<void> {
    const seq = ++borrowerSearchSeqRef.current;
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      params.set('limit', '8');
      const response = await apiRequest<{ items: Borrower[] }>(`/api/borrowers?${params.toString()}`);
      if (seq !== borrowerSearchSeqRef.current) return;
      setBorrowerSuggestions(response.items ?? []);
    } catch {
      if (seq !== borrowerSearchSeqRef.current) return;
      setBorrowerSuggestions([]);
    }
  }

  // Debounced wrapper. Coalesces a burst of keystrokes into a single
  // request while the sequence counter inside `searchBorrowers` still
  // guards against out-of-order responses. 180 ms is short enough to feel
  // instant while collapsing typical fast-typing bursts.
  function scheduleBorrowerSearch(query: string): void {
    if (borrowerDebounceRef.current !== null) {
      window.clearTimeout(borrowerDebounceRef.current);
    }
    borrowerDebounceRef.current = window.setTimeout(() => {
      borrowerDebounceRef.current = null;
      void searchBorrowers(query);
    }, 180);
  }

  // Titles already in the catalogue that start with what is being typed.
  //
  // This is a duplicate warning during entry, NOT an autocomplete. The librarian
  // asked to be told "you already have this" while typing the title rather than
  // after saving the record — the existing warning fires post-insert, so the
  // duplicate is always created before they hear about it.
  //
  // Deliberately does not offer the title as a value to accept: titles are
  // near-unique, and offering one invites picking an existing book's title by
  // mistake. That is the same reasoning that keeps title out of
  // /api/books/facets. Picking a row opens that book instead.
  const MIN_TITLE_SUGGEST = 3;

  async function searchTitleSuggestions(query: string, excludeId?: string): Promise<void> {
    const seq = ++titleSuggestSeqRef.current;
    if (query.trim().length < MIN_TITLE_SUGGEST) {
      setTitleSuggestions([]);
      setTitleSuggestTotal(0);
      return;
    }
    try {
      const params = new URLSearchParams({ q: query.trim() });
      if (excludeId) params.set('excludeId', excludeId);
      const response = await apiRequest<{ items: TitleSuggestion[]; total: number }>(
        `/api/books/title-suggest?${params.toString()}`
      );
      if (seq !== titleSuggestSeqRef.current) return;
      setTitleSuggestions(response.items ?? []);
      setTitleSuggestTotal(response.total ?? 0);
    } catch {
      // A failed lookup must never block cataloguing — this is advisory.
      if (seq !== titleSuggestSeqRef.current) return;
      setTitleSuggestions([]);
      setTitleSuggestTotal(0);
    }
  }

  function scheduleTitleSuggest(query: string): void {
    if (titleSuggestDebounceRef.current !== null) {
      window.clearTimeout(titleSuggestDebounceRef.current);
    }
    // Longer than the borrower picker's 180 ms: this fires while typing a whole
    // title, so coalescing harder keeps the query count (and D1 reads) down
    // without the warning ever feeling late.
    titleSuggestDebounceRef.current = window.setTimeout(() => {
      titleSuggestDebounceRef.current = null;
      void searchTitleSuggestions(query);
    }, 300);
  }

  // Apply a suggestion picked via keyboard or pointer. Shared between the
  // dropdown's onMouseDown and the input's keyboard handler so Enter and
  // click do exactly the same thing.
  function applyBorrowerSuggestion(b: Borrower) {
    setSelectedBorrowerId(b.id);
    setBorrowerName(b.name);
    setBorrowerContact(b.contact ?? '');
    setBorrowerQuery('');
    setBorrowerSuggestions([]);
  }

  async function uploadBookCover(book: Book, file: File): Promise<void> {
    clearStatus();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setError(t('toast.coverInvalidType'));
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError(t('toast.coverTooLarge'));
      return;
    }
    try {
      const res = await runAction(() =>
        apiRequest<{ ok: boolean; coverUrl: string; version: number }>(`/api/books/${book.id}/cover`, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file
        }, false)
      );
      setMessage(t('toast.coverUpdated', { title: book.title }));
      // Keep the in-memory book's version in step with the server bump so a
      // subsequent metadata edit doesn't send a stale version and 409.
      setDetailBook((prev) =>
        prev && prev.id === book.id
          ? { ...prev, coverUrl: `/api/books/${book.id}/cover?v=${Date.now()}`, version: res.version ?? prev.version }
          : prev
      );
      setEditForm((prev) => (prev.id === book.id && res.version !== undefined ? { ...prev, version: res.version } : prev));
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBookCover(book: Book): Promise<void> {
    const ok = await confirm({
      title: t('confirm.removeCoverTitle'),
      body: t('confirm.removeCoverBody'),
      confirmLabel: t('confirm.removeCoverAction'),
      danger: true
    });
    if (!ok) return;
    clearStatus();
    try {
      const res = await runAction(() => apiRequest<{ ok: boolean; version: number }>(`/api/books/${book.id}/cover`, { method: 'DELETE' }));
      setMessage(t('toast.coverRemoved'));
      setDetailBook((prev) => (prev && prev.id === book.id ? { ...prev, coverUrl: null, version: res?.version ?? prev.version } : prev));
      setEditForm((prev) => (prev.id === book.id && res?.version !== undefined ? { ...prev, version: res.version } : prev));
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Validate + stage a cover chosen in the add-book form. The same JPEG/PNG/
  // WebP/GIF + 4 MB limits as the server (and the detail-view uploader) are
  // enforced up front so the librarian gets immediate feedback.
  function selectCreateCover(file: File): void {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setError(t('toast.coverInvalidType'));
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError(t('toast.coverTooLarge'));
      return;
    }
    setCreateCoverFile(file);
    // Effect below revokes the previous object URL when this value changes.
    setCreateCoverPreview(URL.createObjectURL(file));
  }

  function clearCreateCover(): void {
    setCreateCoverFile(null);
    setCreateCoverPreview(null);
  }

  async function printLabels(targets: Book[]): Promise<void> {
    if (targets.length === 0) return;
    clearStatus();
    try {
      // Lazy-load the QR generator only when the user actually needs it.
      const labels = await import('./labels');
      await labels.openPrintLabels(targets, API_BASE, {
        docTitle: t('labels.docTitle', { n: targets.length }),
        ready: t('labels.ready', { n: targets.length, s: targets.length === 1 ? '' : 's' }),
        print: t('labels.print'),
        close: t('labels.close'),
        toolbarHint: t('labels.toolbarHint'),
        popupBlocked: t('labels.popupBlocked'),
        untitled: t('common.untitled'),
        unknown: t('common.unknown'),
        copyOf: t('labels.copyOf'),
        noBarcode: t('labels.noBarcode'),
        htmlLang: lang
      });
      // Count TILES, not records: one label per copy, so a selection of 20
      // records on two shelves each prints 40 stickers and the operator needs
      // to know that before they load the sheet.
      const tiles = targets.reduce((n, b) => n + Math.max(1, b.items?.length ?? 1), 0);
      setMessage(t('toast.printOpened', { n: tiles, s: tiles === 1 ? '' : 's' }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadStats() {
    const cached = await cacheGet<StatsResponse>('GET /api/stats');
    if (cached) setStats(cached.value);
    try {
      const response = await apiRequest<StatsResponse>('/api/stats');
      setStats(response);
    } catch {
      if (!cached) setStats(null);
    }
  }

  // ONE field at a time, never a prefetch of all of them. Each miss is a
  // 12.5K-row scan and a KV write, and KV writes (1,000/day) are the tightest
  // budget in the system — the rail must not spend eight of them because the
  // librarian opened it.
  const loadFacet = useCallback(async (field: string) => {
    // A LATER request must win, and only the later one may write.
    //
    // The cached branch below always checked that the hit was for the field asked
    // for; the network branch applied whatever arrived. Pick Publisher, then
    // Language a moment later: language answers first and renders, then the slow
    // publisher scan lands and replaces the rail — publisher names, publisher
    // counts and a "top 600" note, all under a selector reading "Language".
    // Clicking a bucket then filtered Language by a publisher name and returned
    // 0 books, i.e. a rail count that does not reproduce as a list, which is the
    // one promise the rail makes. Same sequence guard as loadBooks.
    const seq = ++loadFacetSeqRef.current;
    const isStale = () => seq !== loadFacetSeqRef.current;
    const path = `/api/facets?field=${encodeURIComponent(field)}`;
    const cached = await cacheGet<FacetResponse>(`GET ${path}`);
    if (cached && cached.value.field === field && !isStale()) {
      setFacetItems(cached.value.items ?? []);
      setFacetTotalBooks(cached.value.totalBooks ?? null);
      setFacetTruncated(Boolean(cached.value.truncated));
    }
    try {
      const response = await apiRequest<FacetResponse>(path);
      if (isStale()) return;
      setFacetItems(response.items ?? []);
      setFacetTotalBooks(response.totalBooks ?? null);
      setFacetTruncated(Boolean(response.truncated));
    } catch {
      if (!cached && !isStale()) { setFacetItems([]); setFacetTruncated(false); }
    }
  }, []);

  type SetsResponse = { items: SetSummary[]; total: number; matched?: number; suppressed?: number };
  const loadBookSets = useCallback(async (gapsOnly: boolean) => {
    const path = `/api/books/sets?minBooks=2&withGapsOnly=${gapsOnly}&limit=300`;
    setSetsLoading(true);
    const cached = await cacheGet<SetsResponse>(`GET ${path}`);
    if (cached) {
      setBookSets(cached.value.items ?? []);
      setSetsMeta({ matched: cached.value.matched ?? 0, suppressed: cached.value.suppressed ?? 0 });
    }
    try {
      const response = await apiRequest<SetsResponse>(path);
      setBookSets(response.items ?? []);
      setSetsMeta({ matched: response.matched ?? 0, suppressed: response.suppressed ?? 0 });
    } catch {
      if (!cached) { setBookSets([]); setSetsMeta({ matched: 0, suppressed: 0 }); }
    } finally {
      setSetsLoading(false);
    }
  }, []);

  function clearFacetSelection() {
    setFacetValue('');
    setFacetEmpty(false);
    setCurrentPage(1);
  }

  function selectFacet(item: FacetItem) {
    if (item.isEmpty) {
      setFacetEmpty((on) => !on);
      setFacetValue('');
    } else {
      setFacetEmpty(false);
      setFacetValue((v) => (v === item.value ? '' : item.value));
    }
    setCurrentPage(1);
  }

  async function loadNeedsReviewCount() {
    const cached = await cacheGet<{ count: number }>('GET /api/needs-review-count');
    if (cached) setNeedsReviewCount(cached.value.count ?? 0);
    try {
      const response = await apiRequest<{ count: number }>('/api/needs-review-count');
      setNeedsReviewCount(response.count ?? 0);
    } catch {
      if (!cached) setNeedsReviewCount(0);
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      const response = await runAction(() => apiRequest<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      }));
      // Persist the bearer token so authenticated requests work even when the
      // cross-site session cookie is blocked (Safari/WebKit).
      if (response.token) setAuthToken(response.token);
      beginSplash();
      setCurrentUser(response.user);
      setDidBootstrapData(false);
      setMessage(t('login.welcome', { username: response.user.username }));
    } catch (e) {
      // A 401 HERE means the credentials were wrong, and it is the only 401 a librarian
      // meets regularly — so it gets its own translated sentence rather than the worker's
      // English "Invalid credentials". Everything else keeps the server's text, which is
      // usually more specific than anything this catch could invent.
      setError(e instanceof ApiRequestError && e.status === 401
        ? t('login.badCredentials')
        : (e as Error).message);
    }
  }

  async function logout() {
    clearStatus();
    try {
      await runAction(() => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }));
    } catch {
      // Keep sign-out resilient even if network request fails.
    }

    // Drop the bearer token and wipe the local response cache so the next user
    // (or re-login) cannot see another account's data even briefly.
    setAuthToken(null);
    void cacheClear();

    setCurrentUser(null);
    setDidBootstrapData(false);
    splashActiveRef.current = false;
    setShowSplash(false);
    setSplashHiding(false);
    setBooks([]);
    setCustomFields([]);
    setActiveBorrows([]);
    setAuditItems([]);
    setStaffUsers([]);
    setBookHistory([]);
    setFacetItems([]);
    setFacetTotalBooks(null);
    setFacetTruncated(false);
    clearFacetSelection();
    setMyPermissions(null);
    setPermissionMatrix(null);
    setShowOnboarding(false);
    // Drop the bulk selection too. It is persisted in sessionStorage, so without
    // this the NEXT librarian to sign in on the same tab would inherit the
    // previous one's selection — and a bulk action would silently hit books
    // they never chose and cannot see.
    setSelectedBookIds([]);
    setSelectionMode(false);
    setMessage(t('login.signedOut'));
  }

  // Mark the onboarding course complete server-side and clear the mandatory
  // gate locally so the librarian lands in the app. Best-effort: even if the
  // POST fails we let them through (they can replay from Settings), but we keep
  // needsOnboarding true so it retries next login rather than silently skipping.
  async function completeOnboarding() {
    try {
      await apiRequest<{ ok: boolean }>('/api/me/onboarding-complete', { method: 'POST' });
    } catch (e) {
      // Never trap a librarian behind the mandatory course. If the server call
      // fails (offline, 500, quota) we still let them into the app — the flag
      // stays set server-side, so the course simply reappears next sign-in.
      setError((e as Error).message);
    } finally {
      setCurrentUser((prev) => (prev ? { ...prev, needsOnboarding: false } : prev));
      setShowOnboarding(false);
    }
  }

  function openProfile() {
    if (!currentUser) return;
    setProfileUsername(currentUser.username);
    setProfileNewPassword('');
    setProfileCurrentPassword('');
    setProfileOpen(true);
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!currentUser) return;
    if (!profileCurrentPassword) {
      toast.push('error', t('profile.errCurrent'));
      return;
    }
    const usernameChanged = profileUsername.trim() && profileUsername.trim() !== currentUser.username;
    const passwordChanged = Boolean(profileNewPassword);
    if (!usernameChanged && !passwordChanged) {
      toast.push('error', t('profile.errNoChange'));
      return;
    }
    if (passwordChanged && profileNewPassword.length < 8) {
      toast.push('error', t('users.errPasswordShort'));
      return;
    }
    setProfileSubmitting(true);
    try {
      const body: Record<string, string> = { currentPassword: profileCurrentPassword };
      if (usernameChanged) body.username = profileUsername.trim();
      if (passwordChanged) body.newPassword = profileNewPassword;
      const res = await apiRequest<{ user: { id: string; username: string; role: string } }>(
        '/api/me',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      setCurrentUser(res.user);
      toast.push('success', t('profile.saved'));
      setProfileOpen(false);
      setProfileNewPassword('');
      setProfileCurrentPassword('');
    } catch (err) {
      toast.push('error', (err as Error).message);
    } finally {
      setProfileSubmitting(false);
    }
  }

  async function applyDefaultBookStructure() {
    clearStatus();
    try {
      const result = await runAction(() =>
        apiRequest<{ ok: boolean; configuredCustomColumns: number; skippedAsSimilar?: string[] }>(
          '/api/setup/default-book-structure',
          {
            method: 'POST'
          }
        )
      );
      await loadCustomFields();
      const skippedCount = result.skippedAsSimilar?.length ?? 0;
      if (skippedCount > 0) {
        setMessage(
          t('toast.defaultStructureSkipped', { added: result.configuredCustomColumns, skipped: skippedCount })
        );
      } else {
        setMessage(t('toast.defaultStructureAdded', { added: result.configuredCustomColumns }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const loadBooks = useCallback(async (pageOverride?: number) => {
    const seq = ++loadBooksSeqRef.current;
    const isStale = () => seq !== loadBooksSeqRef.current;
    setIsLoadingBooks(true);
    setBooksError(null);
    try {
      const page = pageOverride ?? currentPage;

      // ── Semantic mode ─────────────────────────────────────────────────
      // Vectorize doesn't speak filters/sort/pagination the same way SQL
      // does, so when the user is in semantic mode we send only `q` and
      // render the ANN-ranked result list. Filters/sort still apply
      // client-side once we have the rows. Empty query short-circuits.
      if (searchEngine === 'semantic') {
        if (!q.trim()) {
          setBooks([]);
          setTotalBooksCount(0);
          setCurrentPage(1);
          return;
        }
        const semanticParams = new URLSearchParams({ q, topK: '50' });
        const cacheKey = `GET /api/books/semantic?${semanticParams.toString()}`;
        const cached = await cacheGet<{ items: Book[]; total: number }>(cacheKey);
        if (cached && !isStale()) {
          setBooks(cached.value.items);
          setTotalBooksCount(cached.value.total);
          setCurrentPage(1);
        }
        try {
          const response = await apiRequest<{ items: Book[]; total: number }>(
            `/api/books/semantic?${semanticParams.toString()}`
          );
          if (isStale()) return;
          setBooks(response.items);
          setTotalBooksCount(response.total);
          setCurrentPage(1);
        } catch (e) {
          // 503 indicates the server doesn't have Vectorize+AI bound; flip
          // the availability flag and fall back to lexical so the user
          // isn't stuck on a broken mode.
          const err = e as Error & { status?: number };
          if (err.status === 503) {
            setSemanticAvailable(false);
            setSearchEngine('lexical');
            setError(t('library.adv.semanticOff'));
          } else if (!cached) {
            setBooksError(err.message);
            setError(err.message);
          }
        }
        return;
      }

      const query = buildBookFilterParams({
        q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
        status, filterLanguage, filterYear, facetField, facetValue, facetEmpty,
        needsReviewFilter, shelfFilter, smartListKey, smartLists: SMART_LISTS
      });
      query.set('sortBy', sortBy);
      query.set('sortDir', sortDir);
      query.set('page', page.toString());
      query.set('pageSize', String(PAGE_SIZE));

      const cacheKey = `GET /api/books?${query.toString()}`;
      const cached = await cacheGet<{ items: Book[]; total: number }>(cacheKey);
      if (cached && !isStale()) {
        setBooks(cached.value.items);
        setTotalBooksCount(cached.value.total);
        setCurrentPage(page);
      }
      try {
        const response = await apiRequest<{ items: Book[]; total: number }>(`/api/books?${query.toString()}`);
        if (isStale()) return;
        // Clamp: if deleting the last row(s) on the last page left `page` beyond
        // the end, re-fetch the now-last page instead of showing an empty grid
        // with a "Page N of N-1" footer.
        const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
        if (page > lastPage && response.total > 0) {
          void loadBooks(lastPage);
          return;
        }
        setBooks(response.items);
        setTotalBooksCount(response.total);
        setCurrentPage(page);
      } catch (e) {
        // Don't let a failed fetch masquerade as an empty library: record a
        // dedicated error so the list area can render a retry affordance. The
        // cache fallback (if any) still populated `books` above.
        if (!cached) setBooksError((e as Error).message);
        setError((e as Error).message);
      }
    } finally {
      setIsLoadingBooks(false);
    }
  }, [
    currentPage, q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
    status, filterLanguage, filterYear, facetField, facetValue, facetEmpty, needsReviewFilter,
    shelfFilter, sortBy, sortDir, smartListKey, searchEngine, t, setError
  ]);

  // Debounced auto-search: any change to query/filters/sort re-fetches books on page 1.
  useEffect(() => {
    if (!loggedIn || !didBootstrapData) return;
    const signature = JSON.stringify({
      q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
      status, filterLanguage, filterYear, facetField, facetValue, facetEmpty, needsReviewFilter,
      shelfFilter, sortBy, sortDir, smartListKey, searchEngine
    });
    if (signature === lastSearchSignatureRef.current) return;
    lastSearchSignatureRef.current = signature;
    const handle = window.setTimeout(() => {
      void loadBooks(1);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    loggedIn, didBootstrapData,
    q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
    status, filterLanguage, filterYear, facetField, facetValue, facetEmpty, needsReviewFilter,
    shelfFilter, sortBy, sortDir, smartListKey, searchEngine,
    loadBooks
  ]);

  // Probe the server's /api/health on first login to learn whether the
  // optional Vectorize + AI bindings are configured. We don't have a
  // dedicated capability endpoint, but health already reports DB/KV/R2 and
  // adding a hint keeps the network surface small.
  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest<{ ok: boolean; semantic?: boolean }>('/api/health');
        if (cancelled) return;
        // The server tells us via an explicit flag (added below). Until the
        // flag rolls out we leave the toggle enabled and let the loadBooks
        // 503 handler flip it off after the first attempt.
        setSemanticAvailable(res.semantic ?? null);
      } catch {
        if (!cancelled) setSemanticAvailable(null);
      }
    })();
    return () => { cancelled = true; };
  }, [loggedIn]);

  async function loadCustomFields() {
    const cached = await cacheGet<{ items: CustomField[] }>('GET /api/custom-fields');
    if (cached) setCustomFields(cached.value.items);
    try {
      const response = await apiRequest<{ items: CustomField[] }>('/api/custom-fields');
      setCustomFields(response.items);
    } catch (e) {
      if (!cached) setError((e as Error).message);
    }
  }

  // Load the distinct catalog values that power predictive autocomplete on the
  // cataloguing forms AND the search filters. Read-economical: cached server-side
  // (KV, version-keyed) and client-side (IndexedDB), so it's ~one request per
  // session and zero requests per keystroke (the datalist filters client-side).
  // Available to all roles now (search helps viewers too). A fetch failure is
  // swallowed — autocomplete just degrades to no suggestions.
  const loadFacets = useCallback(async () => {
    const cached = await cacheGet<CatalogFacets>('GET /api/books/facets');
    if (cached) setFacets(cached.value);
    try {
      const response = await apiRequest<CatalogFacets>('/api/books/facets');
      setFacets(response);
    } catch {
      /* ignore — autocomplete degrades gracefully to no suggestions */
    }
  }, []);

  // Refresh autocomplete suggestions whenever a book form opens (the add panel
  // or the detail editor). Re-opening after an import or bulk edit re-fetches,
  // so new values show up without a page reload.
  useEffect(() => {
    if (showAddBook || detailMode === 'edit') void loadFacets();
  }, [showAddBook, detailMode, loadFacets]);

  async function loadRoomSummary() {
    type RoomSummaryResponse = {
      items: RoomSummaryItem[];
      unassigned: {
        totalBooks: number;
        availableBooks: number;
        borrowedBooks: number;
        lostBooks: number;
        maintenanceBooks: number;
      };
    };
    const cached = await cacheGet<RoomSummaryResponse>('GET /api/rooms/summary');
    if (cached) {
      setRoomSummary(cached.value.items ?? []);
      setUnassignedSummary(cached.value.unassigned);
    }
    try {
      const response = await apiRequest<RoomSummaryResponse>('/api/rooms/summary');
      setRoomSummary(response.items ?? []);
      setUnassignedSummary(response.unassigned);
    } catch (e) {
      if (!cached) setError((e as Error).message);
    }
  }

  // `maySee` defaults to the derived permission, which is right everywhere the
  // matrix has already arrived. Bootstrap passes it explicitly because at that
  // point `canSeeCirculation` is still false for every non-admin — see
  // refreshEverything().
  async function loadActiveBorrows(maySee: boolean = canSeeCirculation) {
    // Active-loan data is patron PII and the endpoint is now circulation-gated;
    // viewers (no circulation) would get a 403. Skip the fetch for them so login
    // doesn't surface a spurious error and we don't hammer a forbidden endpoint.
    if (!maySee) {
      setActiveBorrows([]);
      return;
    }
    const cached = await cacheGet<{ items: ActiveBorrow[] }>('GET /api/borrow/active');
    if (cached) setActiveBorrows(cached.value.items ?? []);
    try {
      const response = await apiRequest<{ items: ActiveBorrow[] }>('/api/borrow/active');
      setActiveBorrows(response.items ?? []);
    } catch (e) {
      if (!cached) setError((e as Error).message);
    }
  }

  async function loadAuditLogs() {
    try {
      const response = await apiRequest<{ items: AuditLogItem[] }>('/api/audit-logs?page=1&pageSize=8');
      setAuditItems(response.items ?? []);
    } catch {
      // Non-admin users may not have access to audit logs; keep UI silent.
      setAuditItems([]);
    }
  }

  async function loadStaffUsers() {
    setStaffUsersLoading(true);
    try {
      const response = await apiRequest<{ items: StaffUser[] }>('/api/users');
      setStaffUsers(response.items ?? []);
    } catch {
      // Non-admin users can't list users; clear and stay silent.
      setStaffUsers([]);
    } finally {
      setStaffUsersLoading(false);
    }
  }

  // Returns the matrix as well as storing it: a caller in the same tick cannot
  // read it back off state (see refreshEverything).
  async function loadMyPermissions(): Promise<Record<string, boolean> | null> {
    try {
      const res = await apiRequest<{ catalog: string[]; permissions: Record<string, boolean> }>('/api/me/permissions');
      setMyPermissions(res.permissions);
      return res.permissions;
    } catch {
      setMyPermissions(null);
      return null;
    }
  }

  async function loadPermissionMatrix() {
    setPermissionMatrixLoading(true);
    try {
      const res = await apiRequest<{
        catalog: string[];
        matrix: Record<'admin' | 'librarian' | 'viewer', Record<string, boolean>>;
      }>('/api/role-permissions');
      setPermissionMatrix(res);
    } catch {
      setPermissionMatrix(null);
    } finally {
      setPermissionMatrixLoading(false);
    }
  }

  function togglePermissionCell(role: 'librarian' | 'viewer', perm: string) {
    setPermissionMatrix((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        matrix: {
          ...prev.matrix,
          [role]: { ...prev.matrix[role], [perm]: !prev.matrix[role][perm] }
        }
      };
    });
  }

  async function savePermissionMatrix() {
    if (!permissionMatrix) return;
    setPermissionMatrixSaving(true);
    try {
      const res = await apiRequest<{
        catalog: string[];
        matrix: Record<'admin' | 'librarian' | 'viewer', Record<string, boolean>>;
      }>('/api/role-permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matrix: {
            librarian: permissionMatrix.matrix.librarian,
            viewer: permissionMatrix.matrix.viewer
          }
        })
      });
      setPermissionMatrix(res);
      // The current user might be affected; refresh their effective perms.
      await loadMyPermissions();
      toast.push('success', t('roles.saved'));
    } catch (err) {
      toast.push('error', (err as Error).message);
    } finally {
      setPermissionMatrixSaving(false);
    }
  }

  async function createStaffUser(event: FormEvent) {
    event.preventDefault();
    const username = newUserUsername.trim();
    const password = newUserPassword;
    if (!username || !password) {
      toast.push('error', t('users.errMissing'));
      return;
    }
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, role: newUserRole })
      }));
      setNewUserUsername('');
      setNewUserPassword('');
      setNewUserRole('viewer');
      toast.push('success', t('users.created', { username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function updateStaffUserRole(user: StaffUser, role: StaffRole) {
    if (user.role === role) return;
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>(`/api/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ role })
      }));
      toast.push('success', t('users.roleUpdated', { username: user.username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function toggleStaffUserActive(user: StaffUser) {
    const nextActive = user.active === 1 ? false : true;
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>(`/api/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: nextActive })
      }));
      toast.push('success', nextActive
        ? t('users.activated', { username: user.username })
        : t('users.deactivated', { username: user.username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function resetStaffUserPassword(user: StaffUser) {
    const password = editUserPassword;
    if (!password || password.length < 8) {
      toast.push('error', t('users.errPasswordShort'));
      return;
    }
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>(`/api/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password })
      }));
      setEditingUserId(null);
      setEditUserPassword('');
      toast.push('success', t('users.passwordReset', { username: user.username }));
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function deleteStaffUser(user: StaffUser) {
    const ok = await confirm({
      title: t('users.confirmDeleteTitle', { username: user.username }),
      body: t('users.confirmDeleteBody'),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await runAction(() => apiRequest<{ ok: boolean }>(`/api/users/${user.id}`, { method: 'DELETE' }));
      toast.push('success', t('users.deleted', { username: user.username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  // ── ISBN enrichment ─────────────────────────────────────────────────────
  // Pulls metadata from OpenLibrary + Google Books via the worker proxy and
  // fills any EMPTY fields in the Add Book form. We never overwrite a field
  // the librarian has already filled in — the lookup is a convenience, not a
  // policy enforcer.
  const [isbnLookupBusy, setIsbnLookupBusy] = useState(false);

  type IsbnLookupResult = {
    isbn: string;
    title?: string | null;
    subTitle?: string | null;
    author?: string | null;
    publisher?: string | null;
    publicationYear?: number | null;
    language?: string | null;
    description?: string | null;
    pages?: number | null;
    coverUrl?: string | null;
    source: 'openlibrary' | 'googlebooks' | 'both' | 'none';
  };

  async function enrichFromIsbn(): Promise<void> {
    const isbnRaw = createForm.isbn.trim();
    if (!isbnRaw) {
      pushAppToast('error', t('library.add.lookupNoIsbn'));
      return;
    }
    setIsbnLookupBusy(true);
    try {
      // Strip everything but digits/X — same sanitization the server does,
      // but doing it on the client too means the URL is clean and the
      // browser cache key stable for repeat lookups.
      const clean = isbnRaw.replace(/[^0-9Xx]/g, '');
      const isbnDigits = clean;
      const res = await apiRequest<IsbnLookupResult>(`/api/lookup/isbn/${encodeURIComponent(clean)}?source=both`);
      if (res.source === 'none') {
        pushAppToast('error', t('library.add.lookupNone'));
        return;
      }
      let filled = 0;
      setCreateForm((prev) => {
        const next = { ...prev };
        const set = (k: keyof typeof prev, v: string | null | undefined) => {
          if (!v) return;
          if (prev[k] && prev[k].toString().trim().length > 0) return; // don't overwrite
          (next as Record<string, string>)[k] = String(v);
          filled += 1;
        };
        // A romanized value goes to the PARALLEL field, not over the
        // vernacular one. Open Library serves ALA-LC romanization for Greek
        // ("Epiphanios Salaminos Kyprou"), and with only one slot per field
        // that is what the librarian saw land in the form. Routed here, the
        // same data becomes a useful searchable alternate form instead.
        const routeScript = (
          vernacularKey: 'title' | 'author' | 'publisher',
          romanizedKey: 'titleRomanized' | 'authorRomanized' | 'publisherRomanized',
          value: string | null | undefined
        ) => {
          if (!value) return;
          if (isRomanizedFor(value, res.language ?? null, isbnDigits)) set(romanizedKey, value);
          else set(vernacularKey, value);
        };
        routeScript('title', 'titleRomanized', res.title);
        routeScript('author', 'authorRomanized', res.author);
        routeScript('publisher', 'publisherRomanized', res.publisher);
        set('language', res.language);
        set('description', res.description);
        if (res.publicationYear) {
          if (!prev.publicationYear || prev.publicationYear.trim() === '') {
            next.publicationYear = String(res.publicationYear);
            filled += 1;
          }
        }
        return next;
      });
      // Bonus: if there's a `pages` custom field defined and it's currently
      // blank, prefill it too. Keeps the catalog UX consistent with the
      // existing pages field used by the LIBRARY catalogue import.
      //
      // `pages` holds ISBD extent and is now free text ("σ. 351-700"), but a
      // library seeded before that change may still have it typed as a number,
      // so accept either and hand the value over in the shape that field wants.
      if (res.pages !== null && res.pages !== undefined) {
        const pagesField = customFields.find((f) => f.key === 'pages' && (f.type === 'text' || f.type === 'number'));
        if (pagesField && (createAttrValues[pagesField.key] === undefined || createAttrValues[pagesField.key] === '')) {
          const value = pagesField.type === 'number' ? (res.pages as number) : String(res.pages);
          setCreateAttrValues((prev) => ({ ...prev, [pagesField.key]: value }));
          filled += 1;
        }
      }
      if (filled === 0) {
        // Found a record but every field was already filled in.
        pushAppToast('success', t('library.add.lookupOk', { n: 0, source: res.source }));
      } else {
        pushAppToast('success', t('library.add.lookupOk', { n: filled, source: res.source }));
      }
    } catch (e) {
      pushAppToast('error', t('library.add.lookupError', { message: (e as Error).message }));
    } finally {
      setIsbnLookupBusy(false);
    }
  }

  async function createBook(event: FormEvent) {
    event.preventDefault();
    clearStatus();
    setDuplicateWarning([]);

    // Required-field gate (client side). A book must have a title, and every
    // admin-marked-required custom field must be filled. Block the submit,
    // highlight the offending fields, and focus the first one — instead of
    // creating a junk "(Untitled)" record or bouncing off the server.
    const errorKeys = new Set<string>();
    const missingLabels: string[] = [];
    if (!createForm.title.trim()) {
      errorKeys.add('title');
      missingLabels.push(t('library.add.bookTitle'));
    }
    for (const field of customFields) {
      if (!field.required) continue;
      const raw = createAttrValues[field.key];
      if (raw === undefined || raw === null || raw === '') {
        errorKeys.add(`cf:${field.key}`);
        missingLabels.push(field.label);
      }
    }
    setCreateFieldErrors(errorKeys);
    if (missingLabels.length > 0) {
      setError(t('toast.requiredFields', { list: missingLabels.join(', ') }));
      // The title keeps its ref — it is above every attribute and the ref is exact. Anything
      // else, including a required attribute on its own, is found on screen.
      if (errorKeys.has('title')) titleInputRef.current?.focus();
      else focusFirstInvalidField();
      return;
    }

    try {
      const customFieldsValue = buildCustomFieldsPayload(createAttrValues);
      // The date field accepts EDTF ("1955/1957", "~1850", "19XX"), so it is sent
      // as-authored and the server derives the sortable years from it.
      const dateEdtf = createForm.publicationYear.trim() || null;
      const result = await runAction(() => apiRequest<{ id: string; duplicateOf?: DuplicateEntry[] }>('/api/books', {
        method: 'POST',
        body: JSON.stringify({
          title: createForm.title.trim(),
          author: createForm.author.trim(),
          isbn: createForm.isbn.trim() || null,
          shelfCode: createForm.shelfCode.trim() || null,
          publisher: createForm.publisher.trim() || null,
          language: createForm.language.trim() || null,
          description: createForm.description.trim() || null,
          titleRomanized: createForm.titleRomanized.trim() || null,
          authorRomanized: createForm.authorRomanized.trim() || null,
          publisherRomanized: createForm.publisherRomanized.trim() || null,
          ddc: createForm.ddc.trim() || null,
          bibLevel: createForm.bibLevel,
          dateEdtf,
          tags: [],
          customFields: customFieldsValue,
          status: 'available'
        })
      }));

      // Grab the staged cover before we reset the form state below.
      const coverFile = createCoverFile;

      setCreateForm({
        title: '',
        author: '',
        isbn: '',
        shelfCode: '',
        publicationYear: '',
    titleRomanized: '',
    authorRomanized: '',
    publisherRomanized: '',
        publisher: '',
        language: '',
        ddc: '',
        bibLevel: 'monograph' as BibLevel,
        description: ''
      });
      setCreateFieldErrors(new Set());
      setCreateAttrValues({});
      clearCreateCover();
      setShowAddBook(false);

      if (result.duplicateOf && result.duplicateOf.length > 0) {
        setDuplicateWarning(result.duplicateOf);
        setMessage(t('toast.bookAddedDuplicate'));
      } else {
        setMessage(t('toast.bookAdded'));
      }

      // Upload the cover now that the book row exists. Failure here is
      // non-fatal — the book was created — so we keep the success message and
      // add a soft warning toast instead of throwing the whole flow away.
      if (coverFile) {
        try {
          await apiRequest<{ ok: boolean; coverUrl: string }>(`/api/books/${result.id}/cover`, {
            method: 'PUT',
            headers: { 'Content-Type': coverFile.type },
            body: coverFile
          }, false);
        } catch (e) {
          pushAppToast('error', t('toast.bookAddedCoverFailed', { message: (e as Error).message }));
        }
      }

      await Promise.all([loadBooks(), loadRoomSummary(), loadFacet(facetField), loadNeedsReviewCount()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function checkDuplicates() {
    clearStatus();
    try {
      const result = await runAction(() =>
        apiRequest<{ total: number; groups: DuplicateGroup[] }>('/api/books/duplicates')
      );
      setDuplicateGroups(result.groups ?? []);
      setShowDuplicatesPanel(true);
      if (result.total === 0) {
        setMessage(t('toast.noDuplicates'));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Scan a field for spelling variants that fold to the same value (the
  // librarians' natural casing/accent inconsistencies).
  async function loadValueVariants(field: VariantField) {
    clearStatus();
    setVariantField(field);
    setVariantsLoading(true);
    try {
      const res = await apiRequest<{ field: string; groups: ValueVariantGroup[] }>(
        `/api/books/value-variants?field=${encodeURIComponent(field)}`
      );
      setValueVariants(res.groups ?? []);
      setVariantsScanned(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVariantsLoading(false);
    }
  }

  // Merge every spelling in a group into the chosen canonical form.
  async function consolidateVariantGroup(field: VariantField, group: ValueVariantGroup, canonical: string) {
    const to = canonical.trim();
    const from = group.variants.map((v) => v.value).filter((v) => v !== to);
    if (!to || from.length === 0) return;
    const affected = group.variants.filter((v) => v.value !== to).reduce((sum, v) => sum + v.count, 0);
    const ok = await confirm({
      title: t('settings.vc.confirmTitle'),
      body: t('settings.vc.confirmBody', { n: affected, to }),
      confirmLabel: t('settings.vc.merge')
    });
    if (!ok) return;
    clearStatus();
    try {
      const res = await runAction(() => apiRequest<{ updated: number }>('/api/admin/consolidate-value', {
        method: 'POST',
        body: JSON.stringify({ field, from, to })
      }));
      setMessage(t('settings.vc.merged', { n: res.updated, to }));
      await Promise.all([loadValueVariants(field), loadBooks(), loadFacets()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadMergeCandidates(strict: boolean) {
    clearStatus();
    setMergeStrict(strict);
    setMergeLoading(true);
    try {
      const res = await apiRequest<{ groups: MergeCandidateGroup[]; total: number }>(
        `/api/books/merge-candidates?limit=50&match=${strict ? 'strict' : 'loose'}`
        + `&q=${encodeURIComponent(mergeQuery.trim())}`
      );
      setMergeGroups(res.groups ?? []);
      setMergeTotal(res.total ?? 0);
      setMergeScanned(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMergeLoading(false);
    }
  }

  // Dry run: the server reports exactly what it would change and writes nothing.
  async function previewMerge(keepId: string, mergeIds: string[]): Promise<MergePreview | null> {
    clearStatus();
    try {
      return await apiRequest<MergePreview>('/api/books/merge', {
        method: 'POST',
        body: JSON.stringify({ keepId, mergeIds, dryRun: true })
      });
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  async function performMerge(keepId: string, mergeIds: string[]): Promise<boolean> {
    const ok = await confirm({
      title: t('settings.merge.confirmTitle'),
      body: t('settings.merge.confirmBody', { n: mergeIds.length }),
      confirmLabel: t('settings.merge.confirmOk')
    });
    if (!ok) return false;
    clearStatus();
    try {
      const res = await runAction(() => apiRequest<{ copiesMoved: number; copiesAfter: number }>('/api/books/merge', {
        method: 'POST',
        body: JSON.stringify({ keepId, mergeIds, dryRun: false })
      }));
      setMessage(t('settings.merge.merged', { n: mergeIds.length, copies: res.copiesAfter }));
      await Promise.all([loadBooks(), loadFacets()]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function normalizeAllBooks() {
    clearStatus();
    try {
      let offset = 0;
      let totalUpdated = 0;
      let totalBooks = 0;

      while (true) {
        const result = await apiRequest<{
          processed: number; updated: number; offset: number; nextOffset: number; totalBooks: number;
        }>(`/api/admin/normalize-books?limit=500&offset=${offset}`, { method: 'POST' });

        totalUpdated += result.updated;
        totalBooks = result.totalBooks;

        if (result.processed < 500) break;
        offset = result.nextOffset;
      }

      setMessage(t('toast.normalizedAll', { updated: totalUpdated, total: totalBooks }));
      if (totalUpdated > 0) await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Rebuild the full-text search index. Recomputes the diacritic folds for every
  // book so accent-insensitive search is correct again after a catalog import.
  // Loops the paginated endpoint until the server reports `done`.
  async function rebuildSearchIndex() {
    clearStatus();
    try {
      let offset = 0;
      let totalRebuilt = 0;
      let totalBooks = 0;

      while (true) {
        const result = await apiRequest<{
          processed: number; rebuilt: number; offset: number; nextOffset: number | null; totalBooks: number; done: boolean;
        }>(`/api/admin/rebuild-search-index?limit=500&offset=${offset}`, { method: 'POST' });

        totalRebuilt += result.rebuilt;
        totalBooks = result.totalBooks;

        if (result.done || result.nextOffset === null) break;
        offset = result.nextOffset;
      }

      setMessage(t('toast.rebuiltSearchIndex', { rebuilt: totalRebuilt, total: totalBooks }));
      if (totalRebuilt > 0) await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /*
   * What the record looked like when the editor opened.
   *
   * A ref rather than state: nothing renders from it, and it must not be captured by a stale
   * closure in saveBookEdit. Kept so the save can send only what the librarian actually
   * changed — see the note there.
   */
  const editBaselineRef = useRef<{ form: Record<string, unknown>; attrs: Record<string, unknown> } | null>(null);

  function beginEdit(book: Book) {
    setEditForm({ id: book.id, version: book.version, ...editFieldsFromBook(book) });
    setCurrentSection('books');
    setAttributeEditorValues(book.customFields ?? {});
    editBaselineRef.current = editBaselineFromBook(book);
    void loadBookHistory(book.id);
    // Only for a serial: a monograph has no run, and this would be a wasted
    // request on all 12,675 of them.
    setSerialHoldings([]);
    if (book.bibLevel === 'serial') void loadSerialHoldings(book.id);
  }

  // The run of a periodical. Fetched on demand rather than embedded in the book
  // payload: it is only ever shown for a serial, and 12,675 monographs should
  // not pay a join for it on every page of the list.
  async function loadSerialHoldings(bookId: string) {
    try {
      const res = await apiRequest<{ holdings: SerialHolding[] }>(`/api/books/${bookId}/serial-holdings`);
      setSerialHoldings(res.holdings ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadBookHistory(bookId: string, offset = 0) {
    if (!bookId) {
      return;
    }
    // Viewers don't have circulation access; skip the fetch (also avoids
    // surfacing a 403 toast when opening a book detail).
    if (!canSeeCirculation) {
      setBookHistory([]);
      setBookHistoryHasMore(false);
      return;
    }

    // Drop responses for books the user has already navigated away from.
    // Without this guard, switching detail panes quickly can leave the wrong
    // book's history rendered against a different book's data.
    const seq = ++bookHistorySeqRef.current;
    try {
      const response = await apiRequest<{ bookId: string; items: BorrowHistoryItem[]; hasMore?: boolean }>(
        `/api/books/${bookId}/history?limit=20&offset=${offset}`
      );
      if (seq !== bookHistorySeqRef.current) return;
      // offset 0 replaces (fresh open); a later offset appends (load more).
      setBookHistory((prev) => (offset > 0 ? [...prev, ...(response.items ?? [])] : (response.items ?? [])));
      setBookHistoryHasMore(Boolean(response.hasMore));
    } catch {
      if (seq !== bookHistorySeqRef.current) return;
      if (offset === 0) setBookHistory([]);
      setBookHistoryHasMore(false);
    }
  }

  async function saveBookEdit(event: FormEvent) {
    event.preventDefault();
    if (!editForm.id) return;
    clearStatus();

    // Same required-field gate as the add form: never let an edit blank out the
    // title or clear a required custom field.
    const errorKeys = new Set<string>();
    const missingLabels: string[] = [];
    if (!editForm.title.trim()) {
      errorKeys.add('title');
      missingLabels.push(t('detail.title'));
    }
    for (const field of customFields) {
      if (!field.required) continue;
      const raw = attributeEditorValues[field.key];
      if (raw === undefined || raw === null || raw === '') {
        errorKeys.add(`cf:${field.key}`);
        missingLabels.push(field.label);
      }
    }
    setEditFieldErrors(errorKeys);
    if (missingLabels.length > 0) {
      setError(t('toast.requiredFields', { list: missingLabels.join(', ') }));
      // Same as the create gate: the title has an exact ref, everything else is found on screen.
      // In this form it matters more — the field can be below the fold INSIDE the detail modal's
      // own scroll box, so it is not merely off-screen, it is off-screen within a box.
      if (errorKeys.has('title')) editTitleInputRef.current?.focus();
      else focusFirstInvalidField();
      return;
    }

    try {
      const customFieldsValue = buildCustomFieldsPayload(attributeEditorValues);
      const dateEdtf = editForm.publicationYear.trim() || null;
      /*
       * ONLY WHAT CHANGED, and attributes as a PATCH.
       *
       * This used to send a full snapshot of all fifteen fields plus the whole attribute map
       * on every save, which is lossy the moment the form's view of the record is out of date —
       * and the 409 handler below guaranteed that it would be. It re-fetched the record,
       * copied the fresh VERSION into the form, and left every stale field in place, so the
       * librarian's second click sailed past the concurrency check and wrote their old
       * snapshot over a colleague's edit. The version guard was defeated by its own error
       * handler, silently, on the app's main editing path.
       *
       * UpdateBookSchema is already built for this: every core field is optional, so an
       * omitted field keeps its stored value, and `customFieldsPatch` MERGES instead of
       * replacing. Its own comment explains why the wholesale form is "catastrophic for a bulk
       * edit" — the same is true of this editor after a conflict, just for one record at a
       * time.
       *
       * So two librarians editing DIFFERENT fields of the same record no longer collide at
       * all, and after a 409 the retry applies only the fields this librarian actually touched.
       * If both edited the same field, the retrying one wins — unavoidable without a merge UI,
       * but now it is limited to the field they really changed rather than all fifteen.
       */
      const base = editBaselineRef.current;
      const nextCore: Record<string, unknown> = {
        title: editForm.title.trim(),
        author: editForm.author.trim(),
        isbn: editForm.isbn.trim() || null,
        shelfCode: editForm.shelfCode.trim() || null,
        publisher: editForm.publisher.trim() || null,
        language: editForm.language.trim() || null,
        description: editForm.description.trim() || null,
        titleRomanized: editForm.titleRomanized.trim() || null,
        authorRomanized: editForm.authorRomanized.trim() || null,
        publisherRomanized: editForm.publisherRomanized.trim() || null,
        ddc: editForm.ddc.trim() || null,
        bibLevel: editForm.bibLevel,
        dateEdtf,
        status: editForm.status
      };
      // The baseline stores the raw record; compare on the same normalisation the payload
      // uses, or an untouched empty field reads as a change from '' to null and gets sent.
      const baseCore: Record<string, unknown> = base ? {
        title: String(base.form.title ?? '').trim(),
        author: String(base.form.author ?? '').trim(),
        isbn: String(base.form.isbn ?? '').trim() || null,
        shelfCode: String(base.form.shelfCode ?? '').trim() || null,
        publisher: String(base.form.publisher ?? '').trim() || null,
        language: String(base.form.language ?? '').trim() || null,
        description: String(base.form.description ?? '').trim() || null,
        titleRomanized: String(base.form.titleRomanized ?? '').trim() || null,
        authorRomanized: String(base.form.authorRomanized ?? '').trim() || null,
        publisherRomanized: String(base.form.publisherRomanized ?? '').trim() || null,
        ddc: String(base.form.ddc ?? '').trim() || null,
        bibLevel: base.form.bibLevel,
        dateEdtf: String(base.form.publicationYear ?? '').trim() || null,
        status: base.form.status
      } : {};
      const payload: Record<string, unknown> = { version: editForm.version };
      for (const [k, v] of Object.entries(nextCore)) {
        // With no baseline (an edit opened by a path that did not set one) fall back to
        // sending everything, which is the previous behaviour rather than a silent no-op.
        if (!base || v !== baseCore[k]) payload[k] = v;
      }
      // Attributes as a patch: only the keys that changed, with null to clear one. An
      // attribute a colleague added while this form was open is left alone.
      const attrPatch: Record<string, unknown> = {};
      const attrKeys = new Set([...Object.keys(customFieldsValue), ...Object.keys(base?.attrs ?? {})]);
      for (const k of attrKeys) {
        const now = (customFieldsValue as Record<string, unknown>)[k] ?? null;
        const was = (base?.attrs ?? {})[k] ?? null;
        if (!base || now !== was) attrPatch[k] = now;
      }
      if (Object.keys(attrPatch).length > 0) payload.customFieldsPatch = attrPatch;
      const result = await runAction(() => apiRequest<{ id: string; version: number }>(`/api/books/${editForm.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...payload,
          version: editForm.version
        })
      }));

      setEditForm((prev) => ({ ...prev, version: result.version }));
      // The save landed, so the record now equals what the form shows: re-baseline, or a
      // second save in the same sitting would re-send the first save's diff.
      editBaselineRef.current = { form: { ...nextCore, publicationYear: editForm.publicationYear }, attrs: { ...(customFieldsValue as Record<string, unknown>) } };
      setEditFieldErrors(new Set());
      setMessage(t('toast.bookUpdated'));
      setDetailBook((prev) =>
        prev && prev.id === editForm.id
          ? {
              ...prev,
              title: editForm.title.trim(),
              author: editForm.author.trim(),
              isbn: editForm.isbn.trim() || null,
              shelfCode: editForm.shelfCode.trim() || null,
              publisher: editForm.publisher.trim() || null,
              language: editForm.language.trim() || null,
              description: editForm.description.trim() || null,
              // The server derives the sortable years from the EDTF value, so
              // mirror that here rather than guess — an unparseable expression
              // leaves the previous years alone, exactly as the server does.
              dateEdtf,
              publicationYear: dateEdtf ? (parseEdtf(dateEdtf)?.start ?? prev.publicationYear ?? null) : null,
              publicationYearEnd: dateEdtf ? (parseEdtf(dateEdtf)?.end ?? prev.publicationYearEnd ?? null) : null,
              customFields: customFieldsValue as Record<string, string | number | boolean | null>,
              status: editForm.status,
              version: result.version,
            }
          : prev
      );
      setDetailMode('view');
      await Promise.all([loadBooks(), loadFacet(facetField), loadNeedsReviewCount(), loadRoomSummary()]);
    } catch (e) {
      /*
       * Version conflict: the book changed since it was opened. Re-fetch the latest and take
       * its version so a second save succeeds rather than dead-ending on a stale version.
       *
       * The BASELINE IS DELIBERATELY NOT REFRESHED. It records what this librarian saw when
       * they opened the form, which is exactly what makes the diff above mean "what I
       * changed" — refresh it to the server's current row and every field the colleague just
       * edited would suddenly differ from this form's stale copy and be sent back, which is
       * the clobber this whole change exists to stop. Only the version moves.
       */
      if (e instanceof ApiRequestError && e.status === 409 && editForm.id) {
        try {
          const fresh = await apiRequest<Book>(`/api/books/${editForm.id}`);
          setDetailBook((prev) => (prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
          setEditForm((prev) => (prev.id === fresh.id ? { ...prev, version: fresh.version } : prev));
          setError(t('toast.versionConflictReloaded'));
          await loadBooks();
          return;
        } catch {
          /* fall through to the generic error below */
        }
      }
      setError((e as Error).message);
    }
  }

  // One-click resolve for the needs-review queue: strip the needs_review flag
  // from the book's stored custom fields and PUT the book. We send the book's
  // persisted customFields as-is (not buildCustomFieldsPayload, so we don't
  // invent values). NOTE: because the server enforces required custom fields
  // whenever a customFields payload is present, resolving is blocked if the book
  // is missing an admin-added required field — the user then gets the server's
  // actionable "Required custom field missing" error and fills it via Edit
  // first. This is rare (the default catalog fields are all optional).
  async function markReviewed(book: Book) {
    clearStatus();
    const cf: Record<string, unknown> = { ...(book.customFields ?? {}) };
    delete cf.needs_review;
    try {
      const result = await runAction(() => apiRequest<{ id: string; version: number }>(`/api/books/${book.id}`, {
        method: 'PUT',
        body: JSON.stringify({ customFields: cf, version: book.version })
      }));
      setMessage(t('toast.markedReviewed'));
      setDetailBook((prev) => (prev && prev.id === book.id
        ? { ...prev, customFields: cf as Record<string, string | number | boolean | null>, version: result.version }
        : prev));
      await Promise.all([loadBooks(), loadNeedsReviewCount()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBook(book: Book) {
    const ok = await confirm({
      title: t('confirm.deleteBookTitle', { title: book.title }),
      body: t('confirm.deleteBookBody'),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!ok) return;

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(`/api/books/${book.id}`, { method: 'DELETE' }));
      setSelectedBookIds((prev) => prev.filter((id) => id !== book.id));
      setMessage(t('toast.bookRemoved', { title: book.title }));
      if (detailBook?.id === book.id) {
        setDetailBook(null);
        setDetailMode('view');
      }
      await Promise.all([loadBooks(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function borrowBook(book: Book) {
    clearStatus();

    // Trim so a whitespace-only name can't create an anonymous loan (the server
    // schema's min(1) would otherwise accept "   ").
    const trimmedBorrowerName = borrowerName.trim();
    if (!selectedBorrowerId && !trimmedBorrowerName) {
      setError(t('toast.borrowerRequired'));
      return;
    }

    try {
      // An empty due date is not an omission: it means "apply the library's
      // rule", which the server resolves from the borrower's category and the
      // copy's type. A typed date is an override the librarian is entitled to.
      const body: Record<string, unknown> = { dueAt: dueAt || null, notes: null };
      if (selectedBorrowerId) {
        body.borrowerId = selectedBorrowerId;
      } else {
        body.borrowerName = trimmedBorrowerName;
        body.borrowerContact = borrowerContact.trim() || null;
      }
      const res = await runAction(() => apiRequest<{ dueAt: string; copyNumber: number; shelfCode: string | null; copiesAvailable: number; holdFulfilled?: boolean }>(
        `/api/books/${book.id}/borrow`,
        { method: 'POST', body: JSON.stringify(body) }
      ));

      // Say which copy went and when it is due — with several copies on the
      // shelf, "borrowed" alone no longer tells the operator what happened.
      setMessage(t('toast.bookBorrowedCopy', {
        title: book.title,
        copy: res.copyNumber,
        date: new Date(res.dueAt).toLocaleDateString()
      }));
      // Reset borrower form so the next borrow starts fresh.
      setBorrowerName('');
      setBorrowerContact('');
      setSelectedBorrowerId('');
      setBorrowerQuery('');
      setBorrowerSuggestions([]);
      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary(), loadHolds()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ── Renewals, holds and loan policies ─────────────────────────────────────

  async function renewLoan(loan: ActiveBorrow) {
    clearStatus();
    try {
      const res = await runAction(() => apiRequest<{ dueAt: string; renewalCount: number; renewalsLeft: number }>(
        `/api/loans/${loan.id}/renew`,
        {
          method: 'POST',
          // The renewal count is the precondition that makes a retried request
          // safe: it strictly increases, so a replay cannot match. The due date
          // alone cannot do it — renewing a fresh loan lands on the same date.
          body: JSON.stringify({ expectedRenewalCount: loan.renewalCount ?? 0, expectedDueAt: loan.dueAt })
        }
      ));
      setMessage(t('toast.loanRenewed', {
        date: new Date(res.dueAt).toLocaleDateString(),
        n: res.renewalsLeft
      }));
      await Promise.all([loadActiveBorrows(), loadBooks()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runIso2789() {
    clearStatus();
    setIsoBusy(true);
    try {
      const qs = `from=${encodeURIComponent(isoFrom + 'T00:00:00.000Z')}&to=${encodeURIComponent(isoTo + 'T23:59:59.999Z')}`;
      setIsoReport(await apiRequest<Iso2789Report>(`/api/reports/iso2789?${qs}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsoBusy(false);
    }
  }

  // Same argument as loadActiveBorrows: bootstrap must pass the permission in,
  // because the state it is derived from is still null while this runs.
  async function loadHolds(maySee: boolean = canSeeCirculation) {
    if (!maySee) return;
    try {
      const res = await apiRequest<{ items: Hold[] }>('/api/holds');
      setHolds(res.items ?? []);
    } catch {
      // A failed hold-shelf read must not blank the loans screen.
    }
  }

  async function placeHold(book: Book) {
    clearStatus();
    const name = window.prompt(t('holds.promptBorrower'));
    if (!name || !name.trim()) return;
    try {
      const res = await runAction(() => apiRequest<{ position: number; status: string }>(
        `/api/books/${book.id}/holds`,
        { method: 'POST', body: JSON.stringify({ borrowerName: name.trim() }) }
      ));
      setMessage(res.status === 'ready'
        ? t('toast.holdReady', { name: name.trim() })
        : t('toast.holdPlaced', { name: name.trim(), n: res.position }));
      await Promise.all([loadHolds(), loadBookHolds(book.id)]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function cancelHold(hold: Hold) {
    clearStatus();
    try {
      const res = await runAction(() => apiRequest<{ passedOnTo: string | null }>(
        `/api/holds/${hold.id}`, { method: 'DELETE' }
      ));
      setMessage(res.passedOnTo
        ? t('toast.holdCancelledPassed', { name: res.passedOnTo })
        : t('toast.holdCancelled'));
      await Promise.all([loadHolds(), hold.bookId ? loadBookHolds(hold.bookId) : Promise.resolve()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadBookHolds(bookId: string) {
    if (!canSeeCirculation) { setDetailHolds([]); return; }
    try {
      const res = await apiRequest<{ holds: Hold[] }>(`/api/books/${bookId}/holds`);
      setDetailHolds(res.holds ?? []);
    } catch {
      setDetailHolds([]);
    }
  }

  async function loadLoanPolicies() {
    try {
      const res = await apiRequest<{ policies: LoanPolicy[]; borrowerCategories: Array<{ category: string }>; itemTypes: string[] }>(
        '/api/loan-policies'
      );
      setLoanPolicies(res.policies ?? []);
      setPolicyCategories((res.borrowerCategories ?? []).map((r) => r.category));
      setPolicyItemTypes(res.itemTypes ?? []);
      setPoliciesLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveLoanPolicies() {
    clearStatus();
    try {
      await runAction(() => apiRequest('/api/loan-policies', {
        method: 'PUT',
        body: JSON.stringify({ policies: loanPolicies.map(({ id: _id, ...p }) => p) })
      }));
      setMessage(t('toast.policiesSaved', { n: loanPolicies.length }));
      await loadLoanPolicies();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function returnBook(book: Book) {
    clearStatus();

    try {
      await runAction(() => apiRequest(`/api/books/${book.id}/return`, {
        method: 'POST',
        body: JSON.stringify({ notes: null })
      }));

      setMessage(t('toast.bookReturned', { title: book.title }));
      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary(), loadHolds()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // `transactionId` is the loan this screen was showing. The server refuses the
  // return if a different loan is open now, so a list left open while someone
  // else returned and re-lent the book can't close the new borrower's loan.
  async function quickReturnByBookId(bookId: string, title: string, transactionId?: string) {
    clearStatus();

    try {
      await runAction(() => apiRequest(`/api/books/${bookId}/return`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Returned from active loans list', transactionId: transactionId ?? null })
      }));
      setMessage(t('toast.bookReturned', { title }));
      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary(), loadHolds()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function returnAllOverdue() {
    clearStatus();

    try {
      const overdueItems = activeBorrows.filter((item) => item.isOverdue);
      if (overdueItems.length === 0) {
        setMessage(t('toast.noOverdue'));
        return;
      }

      const results = await runAction(() =>
        Promise.allSettled(
          overdueItems.map((item) =>
            apiRequest(`/api/books/${item.bookId}/return`, {
              method: 'POST',
              body: JSON.stringify({ notes: 'Bulk returned from overdue list', transactionId: item.id })
            })
          )
        )
      );

      const failed = results.filter((entry) => entry.status === 'rejected').length;
      const success = results.length - failed;
      if (failed > 0) {
        setMessage(t('toast.returnedOverdueMixed', { success, failed }));
      } else {
        setMessage(t('toast.returnedOverdueAll', { n: success }));
      }

      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary(), loadHolds()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function setDueInDays(days: number) {
    const target = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    target.setHours(23, 59, 59, 999);
    setDueAt(target.toISOString());
  }

  async function generateCode(book: Book, type: 'qr' | 'barcode') {
    clearStatus();

    try {
      const response = await runAction(() => apiRequest<{ value: string }>(`/api/books/${book.id}/codes`, {
        method: 'POST',
        body: JSON.stringify({ type, label: `auto-${type}` })
      }));
      try {
        await navigator.clipboard.writeText(response.value);
        setMessage(t('toast.codeCreatedCopied', { type: type.toUpperCase(), value: response.value }));
      } catch {
        setMessage(t('toast.codeCreated', { type: type.toUpperCase(), value: response.value }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggleBookSelection(bookId: string) {
    setSelectedBookIds((prev) => {
      if (prev.includes(bookId)) {
        return prev.filter((id) => id !== bookId);
      }

      return [...prev, bookId];
    });
  }

  // ADD every book on the current page to the selection (never replace it) — a
  // selection is cumulative across pages and searches.
  function selectAllOnPage() {
    setSelectedBookIds((prev) => {
      const next = new Set(prev);
      for (const book of books) next.add(book.id);
      return [...next];
    });
  }

  // Remove just the current page's books, leaving the rest of the selection.
  function deselectAllOnPage() {
    setSelectedBookIds((prev) => {
      const onPage = new Set(books.map((b) => b.id));
      return prev.filter((id) => !onPage.has(id));
    });
  }

  // The ONLY thing that empties the selection (besides sign-out).
  function clearSelectedBooks() {
    setSelectedBookIds([]);
  }

  // ── Criteria-based selection ──────────────────────────────────────────────
  // Add every book matching a server-side query to the selection. Union, never
  // replace, and report how many were newly added so the librarian can see the
  // effect even when most were already selected.
  async function addMatchingToSelection(query: URLSearchParams, what: string) {
    try {
      const res = await runAction(() => apiRequest<{ ids: string[]; total: number }>(`/api/books/ids?${query.toString()}`));
      const ids = res.ids ?? [];
      let added = 0;
      setSelectedBookIds((prev) => {
        const next = new Set(prev);
        const before = next.size;
        for (const id of ids) next.add(id);
        added = next.size - before;
        return [...next];
      });
      // setState is async; recompute for the message from the same data.
      const alreadyHad = ids.filter((id) => selectedBookIds.includes(id)).length;
      setMessage(t('toast.selectedMatching', { n: ids.length - alreadyHad, what }));
      if (ids.length > 0 && !selectionMode) setSelectionMode(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // "Select everything matching what I'm looking at" — reuses the exact filter
  // params the grid is showing, so the selection is always what's on screen.
  function selectAllMatchingFilters() {
    const query = buildBookFilterParams({
      q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
      status, filterLanguage, filterYear, facetField, facetValue, facetEmpty,
      needsReviewFilter, shelfFilter, smartListKey, smartLists: SMART_LISTS
    });
    void addMatchingToSelection(query, t('library.bulk.criteria.currentView'));
  }

  // "Select every book by this author / on this shelf / from this publisher."
  function selectByCriterion(kind: 'authorExact' | 'shelfExact' | 'publisherExact', value: string, what: string) {
    const query = new URLSearchParams();
    query.set(kind, value);
    void addMatchingToSelection(query, what);
  }

  // Resolve the selected ids to their live rows so a bulk action can span pages.
  // Always fetched fresh (never from the loaded page) so each book carries its
  // CURRENT version for the per-row concurrency check. Chunked to keep the query
  // string short. Ids that no longer exist (deleted elsewhere) simply drop out,
  // and the caller reports them.
  async function resolveSelectedBooks(ids: string[]): Promise<Book[]> {
    const found = new Map<string, Book>();
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const res = await apiRequest<{ items: Book[] }>(`/api/books/by-ids?ids=${chunk.map(encodeURIComponent).join(',')}`);
      for (const b of res.items ?? []) found.set(b.id, b);
    }
    // Preserve the order the librarian selected in.
    return ids.map((id) => found.get(id)).filter((b): b is Book => Boolean(b));
  }

  // Batch a set of book mutations into ONE /api/sync/push request instead of
  // firing N separate PUT/DELETE calls. On the free Cloudflare tier the tightest
  // limit is KV writes (1,000/day) and every book write bumps the cache version
  // = 1 KV write; N direct calls = N KV writes, whereas the whole sync batch
  // bumps the version exactly once. Each mutation carries a FRESH clientMutationId
  // so the server dedups per-row on retry (the body is built once, so ids stay
  // stable across apiRequest's internal retries). Returns per-row success/fail.
  async function pushBulkMutations(
    mutations: Array<{ operation: 'update_book' | 'delete_book'; payload: Record<string, unknown> }>
  ): Promise<{ success: number; failed: number; okIds: string[] }> {
    const clientTimestamp = new Date().toISOString();
    let success = 0;
    let failed = 0;
    const okIds: string[] = [];
    // Batch size is bounded by the Workers FREE plan's 1,000-subrequest limit
    // per invocation, not by the endpoint's 200-mutation schema cap: each
    // mutation costs several D1 calls, so a 200-mutation request dies partway
    // through with a 500 *after* writing some books. 40 keeps a request well
    // inside the budget.
    const BATCH = 40;
    for (let i = 0; i < mutations.length; i += BATCH) {
      const batch = mutations.slice(i, i + BATCH);
      try {
        const res = await runAction(() =>
          apiRequest<{ results: Array<{ status: string; result?: { id?: string } }> }>(`/api/sync/push`, {
            method: 'POST',
            body: JSON.stringify({
              mutations: batch.map((m) => ({
                operation: m.operation,
                payload: m.payload,
                clientMutationId: newMutationId(),
                clientTimestamp
              }))
            })
          })
        );
        res.results.forEach((r, idx) => {
          if (r.status === 'success') {
            success += 1;
            const id = (r.result?.id ?? (batch[idx].payload as { id?: string }).id);
            if (id) okIds.push(id);
          } else {
            failed += 1;
          }
        });
      } catch {
        // A transport failure on ONE batch must not discard the batches that
        // already succeeded — otherwise the caller reports total failure, never
        // prunes the selection, and the librarian re-runs an action that has
        // partly landed. Count this batch as failed and carry on.
        failed += batch.length;
      }
    }
    return { success, failed, okIds };
  }

  // The core book columns a bulk edit may set. Deliberately excludes title,
  // author, ISBN and description: those identify a specific book, and setting
  // them across a selection is never what the librarian meant. Status is handled
  // separately (it has a fixed option list and a circulation guard).
  const BULK_CORE_FIELDS: Array<{
    key: 'shelfCode' | 'roomCode' | 'publisher' | 'language' | 'publicationYear';
    labelKey: string;
    type: 'text' | 'number';
    listId?: string;
  }> = [
    { key: 'shelfCode', labelKey: 'library.bulk.field.shelfCode', type: 'text', listId: 'suggest-shelf' },
    // No listId: there is no room-code facet, so there is no datalist to point at.
    { key: 'roomCode', labelKey: 'library.bulk.field.roomCode', type: 'text' },
    { key: 'publisher', labelKey: 'library.bulk.field.publisher', type: 'text', listId: 'suggest-publisher' },
    { key: 'language', labelKey: 'library.bulk.field.language', type: 'text', listId: 'suggest-language' },
    { key: 'publicationYear', labelKey: 'library.bulk.field.publicationYear', type: 'number' }
  ];

  function resetBulkEditor() {
    setBulkEditValues({});
    setBulkEditClears(new Set());
    setBulkTagsAdd('');
    setBulkTagsRemove('');
    setBulkStatus('');
  }

  // Dismissing the panel DISCARDS what was typed in it. Merely hiding it left
  // the values armed while the bar showed only status + shelf, so the next
  // click of the bar's Apply silently wrote fields the librarian had backed out
  // of — to every selected book. "Cancel" has to mean cancel.
  function closeBulkEditor() {
    setBulkEditOpen(false);
    resetBulkEditor();
  }

  function setBulkEditValue(fieldId: string, value: string) {
    setBulkEditValues((prev) => {
      const next = { ...prev };
      if (value === '') delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });
    // Typing a value and asking to clear the same field are contradictory;
    // the last action wins.
    if (value !== '') {
      setBulkEditClears((prev) => {
        if (!prev.has(fieldId)) return prev;
        const next = new Set(prev);
        next.delete(fieldId);
        return next;
      });
    }
  }

  function toggleBulkEditClear(fieldId: string) {
    const willClear = !bulkEditClears.has(fieldId);
    setBulkEditClears((prev) => {
      const next = new Set(prev);
      if (willClear) next.add(fieldId);
      else next.delete(fieldId);
      return next;
    });
    // Separate call, not nested inside the updater above: React may invoke an
    // updater more than once, and queueing a second setState from inside one is
    // not guaranteed to run.
    if (willClear) {
      setBulkEditValues((vals) => {
        if (!(fieldId in vals)) return vals;
        const next = { ...vals };
        delete next[fieldId];
        return next;
      });
    }
  }

  // How many distinct fields the current bulk edit would write. Drives the
  // confirmation copy and disables Apply when nothing is pending.
  const bulkEditPendingCount =
    Object.keys(bulkEditValues).length +
    bulkEditClears.size +
    (bulkStatus ? 1 : 0) +
    (bulkTagsAdd.trim() ? 1 : 0) +
    (bulkTagsRemove.trim() ? 1 : 0);

  // One custom attribute inside the bulk editor. Mirrors the book form's input
  // types so a value set in bulk is the same shape as one typed on a book — but
  // every control additionally supports "leave unchanged", which the single-book
  // form has no need for.
  function renderBulkCustomField(field: CustomField): React.ReactNode {
    const fieldId = `cf:${field.key}`;
    const cleared = bulkEditClears.has(fieldId);
    const raw = bulkEditValues[fieldId] ?? '';
    const inputId = `bulk-${fieldId}`;

    // A required attribute cannot be cleared — the server refuses it, because
    // the book form enforces required and those books would stop saving. Don't
    // offer a control that can only fail; mark the field instead.
    const clearToggle = field.required ? null : (
      <label className="checkbox-label bulk-clear">
        <input type="checkbox" checked={cleared} onChange={() => toggleBulkEditClear(fieldId)} />
        <span className="muted small">{t('library.bulk.clear2')}</span>
      </label>
    );
    const requiredMark = field.required ? <span className="required-mark"> *</span> : null;

    // Booleans need a third state the book form doesn't: "don't touch this".
    // A plain checkbox can only say true/false, and defaulting to false would
    // silently set the attribute on every selected book.
    if (field.type === 'boolean') {
      return (
        <div key={fieldId} className="form-field bulk-field">
          <label htmlFor={inputId}>{field.label}{requiredMark}</label>
          <select
            id={inputId}
            value={raw}
            disabled={cleared}
            onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
          >
            <option value="">{t('library.bulk.unchanged')}</option>
            <option value="true">{t('common.yes')}</option>
            <option value="false">{t('common.no')}</option>
          </select>
          {clearToggle}
        </div>
      );
    }

    if (field.type === 'enum') {
      return (
        <div key={fieldId} className="form-field bulk-field">
          <label htmlFor={inputId}>{field.label}{requiredMark}</label>
          <select
            id={inputId}
            value={raw}
            disabled={cleared}
            onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
          >
            <option value="">{t('library.bulk.unchanged')}</option>
            {field.enumOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
          {clearToggle}
        </div>
      );
    }

    return (
      <div key={fieldId} className="form-field bulk-field">
        <label htmlFor={inputId}>{field.label}{requiredMark}</label>
        <input
          id={inputId}
          type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          value={raw}
          disabled={cleared}
          onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
          placeholder={cleared ? t('library.bulk.willClear') : t('library.bulk.unchanged')}
          list={field.type === 'text' ? `suggest-cf-${field.key}` : undefined}
        />
        {clearToggle}
      </div>
    );
  }

  async function applyBulkBookChanges() {
    clearStatus();

    try {
      if (selectedBookIds.length === 0) {
        throw new Error(t('toast.bulkSelectAtLeastOne'));
      }

      const updates: Record<string, unknown> = {};
      if (bulkStatus) {
        updates.status = bulkStatus;
      }
      // Core columns from the full editor. A field is written only if the
      // librarian typed a value or explicitly asked to blank it.
      for (const field of BULK_CORE_FIELDS) {
        const fieldId = `core:${field.key}`;
        if (bulkEditClears.has(fieldId)) {
          updates[field.key] = null;
          continue;
        }
        const raw = bulkEditValues[fieldId];
        if (raw === undefined || raw.trim() === '') continue;
        if (field.type === 'number') {
          const n = Number(raw.trim());
          if (!Number.isFinite(n)) {
            throw new Error(t('toast.bulkBadNumber', { label: t(field.labelKey) }));
          }
          updates[field.key] = n;
        } else {
          updates[field.key] = raw.trim();
        }
      }

      // Custom attributes go through customFieldsPatch, NOT customFields: the
      // latter replaces the whole attribute map, so setting one attribute would
      // erase every other attribute on every selected book. `null` in the patch
      // clears exactly that one key.
      const customFieldsPatch: Record<string, string | number | boolean | null> = {};
      for (const field of customFields) {
        const fieldId = `cf:${field.key}`;
        if (bulkEditClears.has(fieldId)) {
          customFieldsPatch[field.key] = null;
          continue;
        }
        const raw = bulkEditValues[fieldId];
        // `.trim()` like the core columns above: a box holding only spaces is
        // an untouched box, not an instruction to write blanks (and not a
        // clear either — that is the explicit tick).
        if (raw === undefined || raw.trim() === '') continue;
        if (field.type === 'number') {
          const n = Number(raw.trim());
          if (!Number.isFinite(n)) {
            throw new Error(t('toast.bulkBadNumber', { label: field.label }));
          }
          customFieldsPatch[field.key] = n;
        } else if (field.type === 'boolean') {
          customFieldsPatch[field.key] = raw === 'true';
        } else {
          customFieldsPatch[field.key] = raw.trim();
        }
      }
      if (Object.keys(customFieldsPatch).length > 0) {
        updates.customFieldsPatch = customFieldsPatch;
      }

      // Tags are added/removed rather than replaced, so bulk-tagging a
      // selection never strips the tags each book already carries.
      const tagsAdd = parseStringArray(bulkTagsAdd);
      const tagsRemove = parseStringArray(bulkTagsRemove);
      if (tagsAdd.length > 0) updates.tagsAdd = tagsAdd;
      if (tagsRemove.length > 0) updates.tagsRemove = tagsRemove;

      if (Object.keys(updates).length === 0) {
        throw new Error(t('toast.bulkRequireValue'));
      }

      // Resolve the WHOLE selection (not just the loaded page) to live rows so
      // every selected book is edited and carries its current version.
      const selectedBooks = await resolveSelectedBooks(selectedBookIds);
      const vanished = selectedBookIds.length - selectedBooks.length;
      const { success, failed } = await pushBulkMutations(
        selectedBooks.map((book) => ({
          operation: 'update_book',
          // sync update_book expects { id, data } and enforces the same version
          // check + borrowed-status guard as the direct PUT.
          payload: { id: book.id, data: { ...updates, version: book.version } }
        }))
      );

      if (failed + vanished > 0) {
        setMessage(t('toast.bulkPartial', { success, failed: failed + vanished }));
      } else {
        setMessage(t('toast.bulkAll', { n: success }));
      }

      resetBulkEditor();
      setBulkEditOpen(false);
      // The selection deliberately survives the action — only the user clears it.
      await Promise.all([loadBooks(), loadRoomSummary(), loadFacets()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportFilteredBooksCsv() {
    clearStatus();
    try {
      if (books.length === 0) {
        throw new Error(t('toast.noBooksToExport'));
      }

      // The SHARED cell escaper, not a local one.
      //
      // This hand-rolled escape quoted commas and quotes and stopped there, while
      // the Worker's export neutralised formula injection — same data, same
      // librarian, same spreadsheet, one path defended. A title like
      // `=HYPERLINK(...)` opened from this button would execute. Both paths now
      // call csvCell, so they cannot drift apart again.
      const escape = csvCell;

      const columns = ['id', 'title', 'author', 'isbn', 'status', 'roomCode', 'shelfCode', 'publicationYear'];
      const lines = [columns.join(',')];
      for (const book of books) {
        lines.push(
          [
            book.id,
            book.title,
            book.author,
            book.isbn ?? '',
            book.status,
            book.roomCode ?? '',
            book.shelfCode ?? '',
            book.publicationYear ?? ''
          ]
            .map(escape)
            .join(',')
        );
      }

      const csv = lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'books-filtered.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(t('toast.csvFiltered', { n: books.length }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resolveScanCode(event: FormEvent) {
    event.preventDefault();
    clearStatus();
    setScanResult('');
    setScanHit(null);

    try {
      const value = scanCode.trim();
      if (!value) {
        throw new Error(t('toast.scanRequired'));
      }

      const response = await runAction(() => apiRequest<ScanHit>(`/api/scan/${encodeURIComponent(value)}`));
      // Localized, blank-safe: show the title and append the author only when
      // there is a real one (no hardcoded English "by", no dangling separator).
      const scanTitle = displayTitle(response.book, t('common.untitled'));
      const scanAuthor = displayAuthor(response.book, '');
      setScanResult(scanAuthor ? `${scanTitle} — ${scanAuthor}` : scanTitle);
      setScanHit(response);
      // A scanner fires a whole string then Enter, so the operator's hands never
      // leave it — clearing the box is what makes scanning a second copy work
      // without reaching for the mouse.
      setScanCode('');
    } catch (e) {
      setError(String((e as Error).message).includes('404') ? t('scan.notFound') : (e as Error).message);
    }
  }

  // Assign a Code 128 barcode to every copy that lacks one. Paged like the
  // other catalogue-wide sweeps: 12.5K writes do not fit in one Workers
  // invocation, so the endpoint reports what is left and this loops.
  async function assignBarcodes() {
    clearStatus();
    setBarcodeBusy(true);
    let total = 0;
    try {
      for (let page = 0; page < 200; page += 1) {
        const res = await apiRequest<{ assigned: number; remaining: number; complete: boolean }>(
          '/api/items/assign-barcodes',
          { method: 'POST', body: JSON.stringify({ limit: 200 }) }
        );
        total += res.assigned;
        if (res.complete || res.assigned === 0) break;
        setMessage(t('barcodes.progress', { n: total, left: res.remaining }));
      }
      setMessage(t('barcodes.done', { n: total }));
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBarcodeBusy(false);
    }
  }

  /** Fetch a CSV through the authenticated client and save it. */
  async function downloadWithAuth(path: string, filename: string) {
    clearStatus();
    try {
      const csv = await runAction(() => apiRequest<string>(path, undefined, true));
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(t('toast.csvDownloaded'));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportCsv() {
    clearStatus();

    try {
      const csv = await runAction(() => apiRequest<string>('/api/export/books.csv', undefined, true));
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'books.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(t('toast.csvDownloaded'));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The server already returns pinned-first; splitting the list here lets the
  // UI show the two groups distinctly without re-sorting (and therefore without
  // any risk of the settings list and the book form disagreeing on order).
  const pinnedCustomFields = useMemo(() => customFields.filter((f) => f.pinned), [customFields]);
  const unpinnedCustomFields = useMemo(() => customFields.filter((f) => !f.pinned), [customFields]);

  // The attributes to show on the open book, grouped for display.
  //
  // Walks the DEFINITIONS (server-ordered pinned-first) and looks each value up,
  // rather than walking the book's own keys. That is what gives the read view
  // the attribute's real label and the same everyday-first order as the edit
  // form. Anything left on the book without a matching definition — an
  // attribute that was deleted after books were tagged with it — is collected
  // as an orphan and still rendered, because hiding it would make real data
  // unreachable from the UI.
  const detailAttributeGroups = useMemo(() => {
    const values = detailBook?.customFields ?? {};
    const yes = t('common.yes');
    const no = t('common.no');
    const toEntry = (f: CustomField) => ({
      key: f.key,
      label: f.label,
      value: formatCustomValue(f, values[f.key], yes, no)
    });
    const keep = (e: { value: string }) => e.value !== '';

    const pinned = pinnedCustomFields.map(toEntry).filter(keep);
    const other = unpinnedCustomFields.map(toEntry).filter(keep);

    const known = new Set(customFields.map((f) => f.key));
    const orphans = Object.entries(values)
      .filter(([key, v]) => !known.has(key) && hasCustomValue(v))
      .map(([key, v]) => ({
        key,
        // No definition means no label to show, so fall back to the old derived
        // spelling — it is the only name this value has ever had.
        label: key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim(),
        value: formatCustomValue(undefined, v, yes, no)
      }));

    return { pinned, other, orphans, total: pinned.length + other.length + orphans.length };
  }, [detailBook, customFields, pinnedCustomFields, unpinnedCustomFields, t]);

  // Pin/unpin in one click. A newly pinned field goes to the END of the pinned
  // group rather than the top, so pinning one attribute never reshuffles the
  // ones the librarian has already arranged.
  async function toggleCustomFieldPin(field: CustomField) {
    clearStatus();
    try {
      const nextPinned = !field.pinned;
      const nextOrder = nextPinned
        ? Math.max(0, ...pinnedCustomFields.map((f) => f.sortOrder ?? 0)) + 1
        : 0;
      await runAction(() => apiRequest(`/api/custom-fields/${field.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          pinned: nextPinned,
          sortOrder: nextOrder,
          enumOptions: field.enumOptions
        })
      }));
      await loadCustomFields();
      setMessage(nextPinned
        ? t('toast.customFieldPinned', { label: field.label })
        : t('toast.customFieldUnpinned', { label: field.label }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Move a pinned field one place up or down by SWAPPING sort orders with its
  // neighbour. Swapping (rather than renumbering the whole group) keeps this to
  // two writes no matter how many attributes are pinned.
  async function moveCustomField(field: CustomField, direction: -1 | 1) {
    clearStatus();
    try {
      const group = pinnedCustomFields;
      const index = group.findIndex((f) => f.id === field.id);
      const swapWith = group[index + direction];
      if (index < 0 || !swapWith) return;

      const save = (f: CustomField, sortOrder: number) =>
        apiRequest(`/api/custom-fields/${f.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            pinned: f.pinned,
            sortOrder,
            enumOptions: f.enumOptions
          })
        });

      // If two fields share a sort order (e.g. both freshly pinned) a naive swap
      // is a no-op, so fall back to explicit consecutive positions.
      const a = field.sortOrder ?? 0;
      const b = swapWith.sortOrder ?? 0;
      // Clamp: the schema's minimum is 0, so moving the first field up from a
      // tied order would otherwise send -1 and 400.
      const [nextA, nextB] = a === b ? [Math.max(0, b + direction), b] : [b, a];

      await runAction(async () => {
        await save(field, nextA);
        await save(swapWith, nextB);
      });
      await loadCustomFields();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function resetCustomFieldForm() {
    setFieldForm({ key: '', label: '', type: 'text', required: false, pinned: false, sortOrder: 0, enumOptionsCsv: '' });
    setEditingCustomFieldId(null);
  }

  function beginCustomFieldEdit(field: CustomField) {
    setEditingCustomFieldId(field.id);
    setFieldForm({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      pinned: field.pinned ?? false,
      sortOrder: field.sortOrder ?? 0,
      enumOptionsCsv: field.enumOptions.join(', ')
    });
  }

  async function saveCustomField(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      const normalizedKey = fieldForm.key.trim();
      if (RESERVED_ATTRIBUTE_KEYS.has(normalizedKey)) {
        throw new Error(t('toast.customFieldKeyReserved'));
      }

      if (!/^[a-zA-Z0-9_]+$/.test(normalizedKey)) {
        throw new Error(t('toast.customFieldKeyInvalid'));
      }

      const enumOptions = fieldForm.enumOptionsCsv
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

      const normalizedOptions = Array.from(new Set(enumOptions));

      if (fieldForm.type === 'enum' && normalizedOptions.length === 0) {
        throw new Error(t('toast.customFieldEnumRequired'));
      }

      if (fieldForm.type !== 'enum' && normalizedOptions.length > 0) {
        throw new Error(t('toast.customFieldEnumOnly'));
      }

      const keyConflict = customFields.some((field) => {
        if (editingCustomFieldId && field.id === editingCustomFieldId) {
          return false;
        }
        return field.key.toLowerCase() === normalizedKey.toLowerCase();
      });

      if (keyConflict) {
        throw new Error(t('toast.customFieldKeyConflict'));
      }

      const path = editingCustomFieldId ? `/api/custom-fields/${editingCustomFieldId}` : '/api/custom-fields';
      const method = editingCustomFieldId ? 'PUT' : 'POST';
      const body = JSON.stringify({
        key: normalizedKey,
        label: fieldForm.label.trim(),
        type: fieldForm.type,
        required: fieldForm.required,
        pinned: fieldForm.pinned,
        sortOrder: fieldForm.sortOrder,
        enumOptions: normalizedOptions
      });

      // Renaming a key or changing a type rewrites every book that carries the
      // attribute. The server does that in PAGES so one request can't exceed the
      // Workers subrequest budget on a 12.5K-book catalogue, and reports
      // `sweepComplete: false` while rows remain. Drive it to completion here —
      // stopping early would leave half the catalogue on the old key/type. The
      // definition row is only written on the final page, so an interrupted loop
      // is resumable rather than corrupting.
      let sweepOffset = 0;
      let restored = false;
      for (let guard = 0; guard < 500; guard += 1) {
        const query = sweepOffset > 0 ? `?sweepOffset=${sweepOffset}` : '';
        const res = await runAction(() => apiRequest<{
          id: string;
          /* The server answers `restored: true` when the key belonged to a DELETED
             attribute and it revived that definition instead of creating one. The values
             those books still hold come back with it, which is a materially different
             outcome from adding a new attribute and has to be reported as one. */
          restored?: boolean;
          sweepComplete?: boolean;
          nextSweepOffset?: number;
        }>(`${path}${query}`, { method, body }));
        restored = Boolean(res?.restored);
        if (res?.sweepComplete !== false) break;
        sweepOffset = res.nextSweepOffset ?? sweepOffset;
        setMessage(t('toast.customFieldMigrating', { n: fmt(sweepOffset) }));
      }

      resetCustomFieldForm();
      await loadCustomFields();
      await loadBooks();
      setMessage(
        editingCustomFieldId ? t('toast.customFieldUpdated')
        : restored ? t('toast.customFieldRestored')
        : t('toast.customFieldAdded')
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteCustomField(field: CustomField) {
    const ok = await confirm({
      title: t('confirm.deleteFieldTitle', { key: field.key }),
      body: t('confirm.deleteFieldBody'),
      confirmLabel: t('confirm.deleteFieldAction'),
      danger: true
    });
    if (!ok) return;

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(`/api/custom-fields/${field.id}`, { method: 'DELETE' }));
      if (editingCustomFieldId === field.id) {
        resetCustomFieldForm();
      }
      await loadCustomFields();
      setMessage(t('toast.customFieldRemoved', { key: field.key }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function isCatalogFormat(headers: string[]): boolean {
    // Catalogue exports use snake_case columns. Detection is conservative: we
    // require `id` plus at least one other catalog-distinct field so we don't
    // mistakenly route a legacy mixed-case file through this path.
    const set = new Set(headers.map((h) => h.trim().toLowerCase()));
    if (!set.has('id')) return false;
    const catalogMarkers = [
      'authors', 'place_of_publication', 'category_code', 'source_sheet',
      'isbn_13', 'shelf_location', 'cover_type', 'has_illustrations'
    ];
    return catalogMarkers.some((m) => set.has(m));
  }

  function toCatalogText(value: unknown, max = 1000): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max) : text;
  }

  function toCatalogBoolean(value: unknown): boolean | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    if (['true', 'yes', '1', 'y'].includes(text)) return true;
    if (['false', 'no', '0', 'n'].includes(text)) return false;
    return null;
  }

  function toCatalogNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/[^0-9.\-]/g, '');
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  function pickIsbn(row: Record<string, unknown>): string | null {
    const isbn13 = toCatalogText(row.isbn_13, 32);
    if (isbn13) return isbn13;
    const isbn10 = toCatalogText(row.isbn_10, 32);
    if (isbn10) return isbn10;
    return null;
  }

  function buildCatalogRow(raw: Record<string, unknown>, reviewIds: Set<string>): CatalogRow | null {
    // Lowercase-key the row so column casing doesn't matter.
    const row = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), v])
    ) as Record<string, unknown>;

    // Skip fully-empty rows.
    if (Object.values(row).every((v) => toCatalogText(v) === null)) {
      return null;
    }

    const legacyId = toCatalogText(row.id, 64);
    const title = toCatalogText(row.title, 300);
    const author = toCatalogText(row.authors, 300);
    const yearRaw = toCatalogNumber(row.published_year);
    const publicationYear = yearRaw && yearRaw >= 1000 && yearRaw <= 3000 ? yearRaw : null;

    const customFields: Record<string, string | number | boolean | null> = {};
    const setField = (key: string, value: string | number | boolean | null) => {
      if (value === null || value === undefined || value === '') return;
      customFields[key] = value;
    };
    setField('series', toCatalogText(row.series, 300));
    setField('volume_label', toCatalogText(row.volume_label, 300));
    setField('volume_num', toCatalogText(row.volume_num, 50));
    setField('editor', toCatalogText(row.editor, 300));
    setField('translator', toCatalogText(row.translator, 300));
    setField('place_of_publication', toCatalogText(row.place_of_publication, 200));
    setField('edition', toCatalogText(row.edition, 50));
    setField('category_code', toCatalogText(row.category_code, 32));
    setField('category_label', toCatalogText(row.category_label, 200));
    setField('cover_type', toCatalogText(row.cover_type, 50));
    const pages = toCatalogNumber(row.pages);
    if (pages !== null) setField('pages', pages);
    setField('condition', toCatalogText(row.condition, 200));
    setField('isbn_10', toCatalogText(row.isbn_10, 32));
    setField('issn', toCatalogText(row.issn, 32));
    setField('additional_isbns', toCatalogText(row.additional_isbns, 500));
    const hasIllus = toCatalogBoolean(row.has_illustrations);
    if (hasIllus !== null) setField('has_illustrations', hasIllus);
    setField('illustration_type', toCatalogText(row.illustration_type, 200));
    const signed = toCatalogBoolean(row.signed_copy);
    if (signed !== null) setField('signed_copy', signed);
    setField('signature_notes', toCatalogText(row.signature_notes, 500));
    const copies = toCatalogNumber(row.copies_count);
    if (copies !== null) setField('copies_count', copies);
    setField('source_sheet', toCatalogText(row.source_sheet, 50));
    setField('original_id', toCatalogText(row.original_id, 64));
    setField('transformations_applied', toCatalogText(row.transformations_applied, 1000));
    setField('cleanup_notes', toCatalogText(row.cleanup_notes, 1000));

    const needsReview = legacyId ? reviewIds.has(legacyId) : false;

    return {
      legacyId,
      title,
      author,
      isbn: pickIsbn(row),
      publicationYear,
      publisher: toCatalogText(row.publisher, 200),
      language: toCatalogText(row.language, 120),
      description: toCatalogText(row.description, 4000),
      shelfCode: toCatalogText(row.shelf_location, 64),
      needsReview,
      customFields
    };
  }

  async function setupLibraryCatalog() {
    clearStatus();
    try {
      const result = await runAction(() =>
        apiRequest<{ ok: boolean; created: number; updated: number; total: number }>(
          '/api/setup/library-catalog',
          { method: 'POST' }
        )
      );
      await loadCustomFields();
      setMessage(
        t('toast.libraryCatalogReady', { created: result.created, updated: result.updated, total: result.total })
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importCatalogRows(rows: CatalogRow[], dryRun: boolean) {
    const CHUNK = 500;
    let cursor = 0;
    let totalInsert = 0;
    let totalUpdate = 0;
    let totalAccepted = 0;
    const allSkipped: Array<{ index: number; reason: string }> = [];

    while (cursor < rows.length) {
      const end = Math.min(cursor + CHUNK, rows.length);
      const chunk = rows.slice(cursor, end);
      const chunkNum = Math.floor(cursor / CHUNK) + 1;
      const chunkTotal = Math.ceil(rows.length / CHUNK);
      setMessage(
        t(dryRun ? 'toast.catalogPreviewing' : 'toast.catalogImportingChunk', { chunk: chunkNum, total: chunkTotal, from: cursor + 1, to: end, n: rows.length })
      );

      const result = await runAction(() =>
        apiRequest<{
          dryRun: boolean;
          acceptedRows?: number;
          willInsert?: number;
          willUpdate?: number;
          inserted?: number;
          updated?: number;
          skippedRows?: Array<{ index: number; reason: string }>;
        }>('/api/import/books-catalog', {
          method: 'POST',
          body: JSON.stringify({ dryRun, rows: chunk })
        })
      );

      if (dryRun) {
        totalAccepted += result.acceptedRows ?? 0;
        totalInsert += result.willInsert ?? 0;
        totalUpdate += result.willUpdate ?? 0;
      } else {
        totalInsert += result.inserted ?? 0;
        totalUpdate += result.updated ?? 0;
      }
      if (result.skippedRows) allSkipped.push(...result.skippedRows);
      cursor = end;
    }

    return { totalInsert, totalUpdate, totalAccepted, allSkipped };
  }

  async function importFromXlsx(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    const form = event.target as HTMLFormElement;
    const fileInput = form.elements.namedItem('xlsxFile') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];

    if (!file) {
      setError(t('toast.xlsxSelectFile'));
      return;
    }

    setImportFileName(file.name);

    try {
      const XLSX = await loadXlsx();
      /*
       * CSV is accepted because the app's own export IS a CSV, and the code that writes it calls
       * it "this library's off-site backup" — while this picker accepted only .xlsx, so the file
       * a librarian was told to keep could not be chosen at all. It is read as text and handed to
       * the CSV parser explicitly rather than left to format sniffing, and the BOM the export
       * prepends for Excel is stripped, since it would otherwise become part of the first header.
       */
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      const workbook = isCsv
        ? XLSX.read((await file.text()).replace(/^\uFEFF/, ''), { type: 'string', raw: false })
        : XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new Error(t('toast.xlsxNoSheet'));
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: null,
        raw: false
      });

      if (rawRows.length === 0) {
        throw new Error(t('toast.xlsxEmpty'));
      }

      // ── Catalog-format fast path ─────────────────────────────────────────
      // Detect the LIBRARY_normalized.xlsx-style snake_case schema and use
      // the upsert endpoint, which is idempotent on `id` (legacy_id).
      const headers = Object.keys(rawRows[0] ?? {});
      if (isCatalogFormat(headers)) {
        // Build the "needs review" overlay from the optional `review` sheet.
        const reviewIds = new Set<string>();
        const reviewSheetName = workbook.SheetNames.find((n) => n.trim().toLowerCase() === 'review');
        if (reviewSheetName) {
          const reviewRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[reviewSheetName], {
            defval: null,
            raw: false
          });
          for (const r of reviewRows) {
            const idVal = r.id ?? r.ID ?? null;
            if (idVal) reviewIds.add(String(idVal).trim());
          }
        }

        // Use the FIRST sheet as canonical (typically named "library").
        const catalogRows: CatalogRow[] = [];
        let blankSkipped = 0;
        for (const raw of rawRows) {
          const row = buildCatalogRow(raw, reviewIds);
          if (!row) { blankSkipped += 1; continue; }
          catalogRows.push(row);
        }
        if (catalogRows.length === 0) {
          throw new Error(t('toast.xlsxNoCatalog'));
        }

        const reviewMatched = catalogRows.filter((r) => r.needsReview).length;
        const noTitle = catalogRows.filter((r) => !r.title).length;
        const noAuthor = catalogRows.filter((r) => !r.author).length;

        if (importDryRun) {
          const result = await importCatalogRows(catalogRows, true);
          setMessage(
            t('toast.catalogDryRun', {
              accepted: result.totalAccepted,
              insert: result.totalInsert,
              update: result.totalUpdate,
              review: reviewMatched,
              noTitle,
              noAuthor,
              blank: blankSkipped
            })
          );
          // The dry-run is a safety check — don't hide the rows the server would
          // reject. Surface the count so it's visible before the real import.
          if (result.allSkipped.length > 0) pushAppToast('error', t('toast.importServerSkipped', { n: result.allSkipped.length }));
        } else {
          const result = await importCatalogRows(catalogRows, false);
          setMessage(
            t('toast.catalogImport', {
              insert: result.totalInsert,
              update: result.totalUpdate,
              review: reviewMatched,
              skipped: result.allSkipped.length
            })
          );
        }

        await Promise.all([loadBooks(1), loadRoomSummary()]);
        return;
      }
      // ── End catalog fast path ────────────────────────────────────────────

      const unknownColumns = findUnknownSpreadsheetColumns(rawRows);
      if (unknownColumns.length > 0) {
        const listed = unknownColumns.slice(0, 12).join(', ');
        const extra = unknownColumns.length > 12 ? `, and ${unknownColumns.length - 12} more` : '';
        const proceed = await confirm({
          title: t('toast.unmappedTitle'),
          body: t('toast.unmappedBody', { listed, extra }),
          confirmLabel: t('toast.unmappedConfirm'),
          cancelLabel: t('toast.unmappedCancel')
        });

        if (!proceed) {
          setError(
            t('toast.unmappedCanceled')
          );
          return;
        }

        setMessage(t('toast.unmappedContinuing', { listed, extra }));
      }

      const rows: Record<string, unknown>[] = [];
      const skippedBlankRows: number[] = [];
      const skippedInvalidRows: number[] = [];

      for (let index = 0; index < rawRows.length; index += 1) {
        try {
          const normalized = normalizeSpreadsheetRow(rawRows[index], index);
          if (!normalized) {
            skippedBlankRows.push(index + 2);
            continue;
          }

          rows.push(normalized);
        } catch (error) {
          // Locale-safe: detect the row-missing case by class, not by
          // matching a translated string.
          if (error instanceof SpreadsheetRowMissingError) {
            skippedInvalidRows.push(index + 2);
            continue;
          }
          throw error;
        }
      }

      if (rows.length === 0) {
        throw new Error(t('toast.xlsxNoValid'));
      }

      const skippedCount = skippedBlankRows.length + skippedInvalidRows.length;
      const skippedInvalidPreview = skippedInvalidRows.slice(0, 8).join(', ');
      const examples = skippedInvalidRows.length > 0 ? t('toast.skippedExamples', { list: skippedInvalidPreview }) : '';
      const skippedNote =
        skippedCount > 0
          ? t('toast.skippedNote', { count: skippedCount, blank: skippedBlankRows.length, invalid: skippedInvalidRows.length, examples })
          : '';

      if (importDryRun) {
        let chunkSize = IMPORT_CHUNK_SIZE;
        let cursor = 0;
        let totalAccepted = 0;
        let serverSkipped = 0;

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = t('toast.chunkLabel', { n: Math.floor(cursor / chunkSize) + 1 });
          setMessage(t('toast.dryRunChunk', { progress: chunkProgress, from: cursor + 1, to: end, n: rows.length }));

          try {
            const result = await runAction(() =>
              apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number; skippedRows?: Array<{ index: number; reason: string }> }>('/api/import/books', {
                method: 'POST',
                body: JSON.stringify({ dryRun: true, rows: chunk })
              })
            );

            totalAccepted += result.acceptedRows ?? chunk.length;
            serverSkipped += result.skippedRows?.length ?? 0;
            cursor = end;
          } catch (error) {
            if (isPayloadTooLargeError(error) && chunkSize > IMPORT_MIN_CHUNK_SIZE) {
              chunkSize = Math.max(IMPORT_MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
              continue;
            }
            throw error;
          }
        }

        setMessage(t('toast.xlsxDryRunDone', { n: totalAccepted, skippedNote }));
        // Rows the SERVER rejected (missing title, bad custom field) are separate
        // from client-side parse skips — surface them so the count isn't silently
        // inflated.
        if (serverSkipped > 0) pushAppToast('error', t('toast.importServerSkipped', { n: serverSkipped }));
      } else {
        let chunkSize = IMPORT_CHUNK_SIZE;
        let cursor = 0;
        let totalImported = 0;
        let serverSkipped = 0;
        const uploadSkippedRows: number[] = [];

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = t('toast.chunkLabel', { n: Math.floor(cursor / chunkSize) + 1 });
          setMessage(t('toast.importingChunk', { progress: chunkProgress, from: cursor + 1, to: end, n: rows.length }));

          try {
            const result = await runAction(() =>
              apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number; skippedRows?: Array<{ index: number; reason: string }> }>('/api/import/books', {
                method: 'POST',
                body: JSON.stringify({ dryRun: false, rows: chunk })
              })
            );

            totalImported += result.importedRows ?? 0;
            serverSkipped += result.skippedRows?.length ?? 0;
            cursor = end;
          } catch (error) {
            if (isPayloadTooLargeError(error)) {
              if (chunkSize > IMPORT_MIN_CHUNK_SIZE) {
                chunkSize = Math.max(IMPORT_MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
                continue;
              }

              uploadSkippedRows.push(cursor + 2);
              cursor += 1;
              continue;
            }

            // Anything else is fatal for this run, but rows already written are
            // IN the database. Saying only "request failed" invites the
            // librarian to re-upload the whole sheet on top of a partial one.
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              t('toast.importPartialFailure', { imported: totalImported, row: cursor + 2, detail })
            );
          }
        }

        const uploadSkippedNote =
          uploadSkippedRows.length > 0
            ? t('toast.uploadSkipped', { n: uploadSkippedRows.length })
            : '';

        setMessage(
          t('toast.xlsxImportDone', { n: totalImported, skippedNote, uploadSkippedNote })
        );
        if (serverSkipped > 0) pushAppToast('error', t('toast.importServerSkipped', { n: serverSkipped }));
      }

      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }


  // ─── helper functions for the detail modal ──────────────────────────────
  function openBookDetail(book: Book) {
    setDetailBook(book);
    setDetailMode('view');
    setBookHistory([]);
    setDetailHolds([]);
    void loadBookHistory(book.id);
    // Only for a serial: a monograph has no run, and this would be a wasted
    // request on all 12,675 of them.
    setSerialHoldings([]);
    if (book.bibLevel === 'serial') void loadSerialHoldings(book.id);
    void loadBookHolds(book.id);
  }

  // Core fields plus every custom attribute, everyday-first (the definitions
  // already arrive in that order).
  const facetChoices = useMemo(
    () => [
      { key: RAIL_SETS, label: t('library.sets.mode') },
      ...CORE_FACET_CHOICES.map((f) => ({ key: f.key, label: t(f.labelKey) })),
      ...customFields.map((f) => ({ key: `custom:${f.key}`, label: f.label }))
    ],
    [customFields, t]
  );

  // Refetch when the browsed field changes. Writes trigger an explicit reload
  // at each mutation site, the way the category rail already did.
  useEffect(() => {
    if (!loggedIn) return;
    if (facetField === RAIL_SETS) void loadBookSets(setsGapsOnly);
    else void loadFacet(facetField);
  }, [loggedIn, facetField, setsGapsOnly, loadFacet, loadBookSets]);

  // Add a copy of each selected record.
  //
  // Request #7: 29 volumes were catalogued twice because each also sits on
  // "19-000 πίσω". This adds a second copy instead — the record stays one
  // record, and both shelves find it.
  async function addCopiesToSelection() {
    const copies = Math.max(1, Math.min(10, Number(addCopiesCount) || 1));
    const ok = await confirm({
      title: t('confirm.addCopiesTitle', { n: fmt(selectedBookIds.length * copies) }),
      body: addCopiesShelf.trim()
        ? t('confirm.addCopiesBodyShelf', { shelf: addCopiesShelf.trim() })
        : t('confirm.addCopiesBody'),
      confirmLabel: t('library.bulk.addCopies')
    });
    if (!ok) return;
    clearStatus();
    setAddCopiesBusy(true);
    try {
      // Chunked because the endpoint caps a request at 500 books, and each copy
      // is a D1 write.
      const CHUNK = 200;
      let created = 0;
      for (let i = 0; i < selectedBookIds.length; i += CHUNK) {
        const res = await runAction(() => apiRequest<{ created: number }>('/api/items/add-copies', {
          method: 'POST',
          body: JSON.stringify({
            bookIds: selectedBookIds.slice(i, i + CHUNK),
            copies,
            shelfCode: addCopiesShelf.trim() || null
          })
        }));
        created += res?.created ?? 0;
      }
      setAddCopiesOpen(false);
      setAddCopiesShelf('');
      setAddCopiesCount('1');
      await Promise.all([loadBooks(), loadFacet(facetField)]);
      setMessage(t('toast.copiesAdded', { n: fmt(created) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAddCopiesBusy(false);
    }
  }

  // ─── table view ──────────────────────────────────────────────────────────
  // Every column the table COULD show: the core book fields plus one per custom
  // attribute, generated from the definitions so the list stays in the same
  // everyday-first order as the forms. Built as data rather than JSX because
  // the next columns to arrive (holdings, volumes, subjects) then cost one
  // entry each instead of another pass over the markup.
  const allTableColumns = useMemo<BookColumn[]>(() => {
    const yes = t('common.yes');
    const no = t('common.no');
    const core = CORE_TABLE_COLUMNS.map((c) => ({ ...c, label: t(c.labelKey as string) }));
    const custom = customFields.map((f) => ({
      key: `cf:${f.key}`,
      label: f.label,
      width: 150,
      get: (b: Book) => formatCustomValue(f, (b.customFields ?? {})[f.key], yes, no)
    }));
    return [...core, ...custom];
  }, [customFields, t]);

  // The columns actually rendered, in the order the model defines them (never
  // the order they were ticked, which would drift from the forms).
  const visibleTableColumns = useMemo<BookColumn[]>(() => {
    const chosen = tableColumns
      ?? [...DEFAULT_TABLE_COLUMNS, ...pinnedCustomFields.map((f) => `cf:${f.key}`)];
    const want = new Set(chosen);
    return allTableColumns.filter((c) => want.has(c.key));
  }, [allTableColumns, tableColumns, pinnedCustomFields]);

  function toggleTableColumn(key: string) {
    setTableColumns((prev) => {
      const base = prev ?? [...DEFAULT_TABLE_COLUMNS, ...pinnedCustomFields.map((f) => `cf:${f.key}`)];
      return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    });
  }

  // Selection, context menu and row activation are identical in every layout,
  // so they are produced once and spread into both the card and the table row.
  // Branching them per layout is how the two silently drift apart.
  /**
   * Row BEHAVIOUR — click, right-click, Enter/Space — shared by the card layout
   * and the table so the two cannot drift apart.
   *
   * Deliberately NOT the ARIA semantics. Spreading `role="button" tabIndex={0}`
   * onto a `<tr>` stops it being a row: `<tbody>` then has children that are not
   * rows, row/column navigation is gone, and the "button" name becomes the
   * concatenation of all ~18 cells. The card `<div>` genuinely is a button and
   * gets the role from `bookCardHandlers` below; the table row keeps its row
   * semantics and puts the affordance on a cell instead.
   */
  function bookRowHandlers(book: Book) {
    const activate = () => {
      // In selection mode the whole row acts as the checkbox so users don't
      // have to aim for a tiny target.
      if (selectionMode && canWrite) toggleBookSelection(book.id);
      else openBookDetail(book);
    };
    return {
      // tabIndex, so the onKeyDown below can actually happen.
      //
      // The table layout spreads these onto a <tr>. Without tabIndex the row cannot take
      // focus, so the Enter/Space handler sitting right here was unreachable: in table
      // density — the view a librarian uses to work down a shelf — no book could be
      // opened, and in selection mode no book could be ticked, without a mouse. The card
      // and list layouts were fine because `bookCardHandlers` adds tabIndex on top.
      //
      // NOT `role: 'button'`, which is what the card version adds: that would stop the
      // <tr> being a row for a screen reader, losing the column associations that make a
      // 7-column table readable at all. The gate asserts that too. A focusable row with a
      // key handler is what a grid row is supposed to be.
      tabIndex: 0,
      onClick: activate,
      onContextMenu: (e: React.MouseEvent) =>
        openContextMenu(e, buildBookMenu(book), displayTitle(book, t('common.untitled'))),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate();
      }
    };
  }

  /** The card layout: a div that really is a button, so it says so. */
  function bookCardHandlers(book: Book) {
    // tabIndex now comes from bookRowHandlers, which every layout needs; only the ROLE is
    // specific to the card, where the element really is a button rather than a table row.
    return { role: 'button' as const, ...bookRowHandlers(book) };
  }

  // Open a book we only hold an id for — the title-duplicate warning carries a
  // trimmed row, not a full record, and the detail modal needs the whole thing
  // (version included, or the first edit would 409).
  // Reports whether it opened, so a caller that also wants to move the user
  // somewhere (the dashboard's recent-activity list) doesn't do it for a record
  // that never loaded.
  async function openBookDetailById(id: string): Promise<boolean> {
    try {
      const book = await apiRequest<Book>(`/api/books/${id}`);
      openBookDetail(book);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  function closeDetail() {
    setDetailBook(null);
    setDetailMode('view');
    setBookHistory([]);
    setCoverZoom(null); // never leave the cover lightbox open without its book
  }

  function renderCustomFieldsForm(
    values: Record<string, unknown>,
    setValue: (key: string, value: unknown) => void,
    errorKeys?: Set<string>
  ): React.ReactNode {
    if (customFields.length === 0) {
      return (
        <p className="muted small">{t('settings.customFieldsEmpty')}</p>
      );
    }
    // Render one field. Shared by the pinned group and the rest so the two
    // groups can never drift apart in behaviour — only in presentation.
    const renderField = (field: CustomField) => {
      const v = values[field.key];
      const idAttr = `cf-${field.key}`;
      const hasError = errorKeys?.has(`cf:${field.key}`) ?? false;
      const mark = field.required ? <span className="required-mark"> *</span> : null;
      /*
       * The error said BESIDE THE FIELD, not only in a corner toast.
       *
       * A missing required attribute set aria-invalid and a red border, and put the label in a
       * toast bottom-right — so a screen reader announced "invalid" with nothing saying why, and
       * a sighted librarian read a label in the corner and then hunted a form of two dozen
       * attributes for it. With the catalogue preset the offending field is usually several
       * screens below the fold, and inside the detail modal it is below the fold of a
       * `max-height: 90vh` scroll box, so the red border was not even on screen.
       *
       * WCAG 2.1 3.3.1 asks for the error to be identified in text; a live region the eye never
       * lands on is not that.
       */
      const errId = `${idAttr}-err`;
      const errText = hasError
        ? <p id={errId} className="field-error">{t('validation.requiredField')}</p>
        : null;
      if (field.type === 'boolean') {
        const checked = v === true || v === 'true';
        return (
          <label key={field.key} className="checkbox-label cf-bool">
            <input
              id={idAttr}
              type="checkbox"
              checked={checked}
              onChange={(e) => setValue(field.key, e.target.checked)}
            />
            <span>{field.label}{mark}</span>
            {errText}
          </label>
        );
      }
      if (field.type === 'enum') {
        return (
          <div key={field.key} className="form-field">
            <label htmlFor={idAttr}>{field.label}{mark}</label>
            <select
              id={idAttr}
              className={hasError ? 'input-error' : undefined}
              aria-required={field.required || undefined}
              aria-invalid={hasError || undefined}
              aria-describedby={hasError ? errId : undefined}
              value={(v as string) ?? ''}
              onChange={(e) => setValue(field.key, e.target.value || null)}
            >
              <option value="">{t('common.none')}</option>
              {field.enumOptions.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
            {errText}
          </div>
        );
      }
      const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
      // Date inputs need YYYY-MM-DD; truncate any ISO timestamp before binding.
      const displayValue =
        field.type === 'date' && typeof v === 'string' && v.length >= 10
          ? v.slice(0, 10)
          : (v as string | number | null | undefined) ?? '';
      return (
        <div key={field.key} className="form-field">
          <label htmlFor={idAttr}>{field.label}{mark}</label>
          <input
            id={idAttr}
            type={inputType}
            className={hasError ? 'input-error' : undefined}
            aria-required={field.required || undefined}
            aria-invalid={hasError || undefined}
            aria-describedby={hasError ? errId : undefined}
            value={displayValue === null || displayValue === undefined ? '' : String(displayValue)}
            onChange={(e) => setValue(field.key, e.target.value)}
            placeholder={field.key}
            // Predictive autocomplete for free-text custom fields, drawn from
            // existing values for this field (title-like uniqueness aside).
            list={field.type === 'text' ? `suggest-cf-${field.key}` : undefined}
          />
          {errText}
        </div>
      );
    };

    // The everyday attributes get their own boxed group at the top. The
    // librarian fills these on nearly every book; alphabetical ordering used to
    // scatter them through two dozen fields they rarely touch.
    return (
      <>
        {pinnedCustomFields.length > 0 && (
          <div className="cf-pinned-group">
            <p className="cf-group-heading">★ {t('settings.pinnedGroup', { n: pinnedCustomFields.length })}</p>
            <div className="custom-fields-grid">{pinnedCustomFields.map(renderField)}</div>
          </div>
        )}
        {unpinnedCustomFields.length > 0 && (
          <>
            {pinnedCustomFields.length > 0 && (
              <p className="cf-group-heading">{t('settings.otherGroup', { n: unpinnedCustomFields.length })}</p>
            )}
            <div className="custom-fields-grid">{unpinnedCustomFields.map(renderField)}</div>
          </>
        )}
      </>
    );
  }

  // Enter edit mode for a book. With no argument it edits the book already open
  // in the detail modal (the modal's Edit button); passing a book (e.g. from the
  // right-click menu on a card) opens that book straight into edit mode.
  function startEditFromDetail(src: Book | null = detailBook) {
    const b = src ?? detailBook;
    if (!b) return;
    if (!detailBook || detailBook.id !== b.id) {
      setDetailBook(b);
      setBookHistory([]);
      void loadBookHistory(b.id);
    }
    setDetailMode('edit');
    setEditForm({ id: b.id, version: b.version, ...editFieldsFromBook(b) });
    setAttributeEditorValues(b.customFields ?? {});
    editBaselineRef.current = editBaselineFromBook(b);
  }

  // ── Context-menu plumbing ─────────────────────────────────────────────────
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Open the custom menu at the cursor, suppressing the native one. Items are
  // pruned first so a permission-filtered menu never shows an empty section; if
  // nothing survives we let the native menu through (no preventDefault).
  function openContextMenu(e: React.MouseEvent, items: CtxItem[], title?: string) {
    const cleaned = pruneCtxItems(items);
    if (cleaned.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, items: cleaned, title });
  }

  function copyText(text: string, whatLabel: string) {
    if (!text) return;
    // Only claim success once the write actually resolves; in an insecure
    // context navigator.clipboard is undefined, so don't show a false "copied".
    const p = navigator.clipboard?.writeText(text);
    if (p) p.then(() => pushAppToast('success', t('ctx.copied', { what: whatLabel }))).catch(() => setError(t('toast.copyFailed')));
    else setError(t('toast.copyFailed'));
  }

  // Fire the hidden cover picker for a specific book (used by the menu item).
  function triggerCoverUpload(book: Book) {
    coverUploadBookRef.current = book;
    coverInputRef.current?.click();
  }

  // A loan row only carries a bookId; the current page of `books` may not hold
  // it, so fetch the full record before opening the detail modal.
  async function openBookById(bookId: string) {
    try {
      const book = await apiRequest<Book>(`/api/books/${bookId}`);
      setCurrentSection('books');
      openBookDetail(book);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function buildBookMenu(book: Book): CtxItem[] {
    const items: CtxItem[] = [];
    items.push({ label: t('ctx.view'), icon: '📖', onClick: () => openBookDetail(book) });
    if (canWrite) items.push({ label: t('ctx.edit'), icon: '✏️', onClick: () => startEditFromDetail(book) });
    if (canSeeCirculation && book.status === 'available') {
      // Mirror the detail-modal Borrow button, including closing the modal so the
      // circulation borrow form isn't hidden behind it.
      items.push({ label: t('ctx.borrow'), icon: '📤', onClick: () => { setSelectedBook(book); setCurrentSection('circulation'); if (detailBook) closeDetail(); } });
    }
    if (canSeeCirculation && book.status === 'borrowed') {
      items.push({ label: t('ctx.return'), icon: '📥', onClick: () => { void returnBook(book); if (detailBook) closeDetail(); } });
    }

    // Cover group.
    const cover: CtxItem[] = [];
    if (book.coverUrl) cover.push({ label: t('ctx.zoomCover'), icon: '🔍', onClick: () => setCoverZoom(joinApiUrl(book.coverUrl!)) });
    if (canWrite) cover.push({ label: book.coverUrl ? t('ctx.replaceCover') : t('ctx.addCover'), icon: '🖼️', onClick: () => triggerCoverUpload(book) });
    if (canWrite && book.coverUrl) cover.push({ label: t('ctx.removeCover'), icon: '🗑️', onClick: () => void deleteBookCover(book) });
    if (cover.length) { items.push({ sep: true }); items.push(...cover); }

    // Labels / codes group.
    if (canPrintLabels) {
      items.push({ sep: true });
      items.push({ label: t('ctx.printLabel'), icon: '🏷️', onClick: () => void printLabels([book]) });
      items.push({ label: t('ctx.genQr'), icon: '🔳', onClick: () => void generateCode(book, 'qr') });
      items.push({ label: t('ctx.genBarcode'), icon: '📊', onClick: () => void generateCode(book, 'barcode') });
    }

    // Copy group — only offer fields that actually have a value (so a menu item
    // never silently no-ops), and only show the group when something is copyable.
    const copy: CtxItem[] = [];
    if (book.title && !isPlaceholder(book.title, 'title')) copy.push({ label: t('ctx.copyTitle'), onClick: () => copyText(book.title, t('ctx.copyTitle')) });
    if (book.author && !isPlaceholder(book.author, 'author')) copy.push({ label: t('ctx.copyAuthor'), onClick: () => copyText(book.author, t('ctx.copyAuthor')) });
    if (book.isbn) copy.push({ label: t('ctx.copyIsbn'), onClick: () => copyText(book.isbn!, t('ctx.copyIsbn')) });
    if (book.shelfCode) copy.push({ label: t('ctx.copyShelf'), onClick: () => copyText(book.shelfCode!, t('ctx.copyShelf')) });
    if (book.legacyId) copy.push({ label: t('ctx.copyLegacy'), onClick: () => copyText(book.legacyId!, t('ctx.copyLegacy')) });
    if (copy.length) {
      items.push({ sep: true });
      items.push({ header: t('ctx.copyHeader') });
      items.push(...copy);
    }

    // Selection.
    if (canWrite) {
      const isSel = selectedBookIds.includes(book.id);
      items.push({ sep: true });
      items.push({
        label: isSel ? t('ctx.deselect') : t('ctx.select'),
        icon: isSel ? '☑️' : '⬜',
        onClick: () => { if (!selectionMode) setSelectionMode(true); toggleBookSelection(book.id); }
      });
      // Criteria-based selection: pick up every book sharing this book's author,
      // shelf or publisher — in one click, across the whole catalogue.
      const sameAuthor = book.author && !isPlaceholder(book.author, 'author') ? book.author : '';
      if (sameAuthor) {
        items.push({
          label: t('ctx.selectSameAuthor'),
          icon: '👤',
          onClick: () => selectByCriterion('authorExact', sameAuthor, t('ctx.selectSameAuthorWhat'))
        });
      }
      if (book.shelfCode) {
        items.push({
          label: t('ctx.selectSameShelf', { code: book.shelfCode }),
          icon: '🗄️',
          onClick: () => selectByCriterion('shelfExact', book.shelfCode!, t('ctx.selectSameShelfWhat'))
        });
      }
      if (book.publisher) {
        items.push({
          label: t('ctx.selectSamePublisher'),
          icon: '🏢',
          onClick: () => selectByCriterion('publisherExact', book.publisher!, t('ctx.selectSamePublisherWhat'))
        });
      }
    }

    // Delete (destructive, last).
    if (canDelete) {
      items.push({ sep: true });
      items.push({ label: t('ctx.delete'), icon: '🗑️', danger: true, onClick: () => void deleteBook(book) });
    }
    return items;
  }

  function buildFacetMenu(item: FacetItem): CtxItem[] {
    const items: CtxItem[] = [];
    const active = item.isEmpty ? facetEmpty : facetValue === item.value;
    const label = item.isEmpty ? t('library.facets.empty') : item.value;
    items.push({ label: t('ctx.filterCategory'), icon: '📂', disabled: active, onClick: () => selectFacet(item) });
    if (facetValue || facetEmpty) {
      items.push({ label: t('ctx.clearCategoryFilter'), icon: '✖️', onClick: clearFacetSelection });
    }
    items.push({ sep: true });
    items.push({ label: t('ctx.copyName'), onClick: () => copyText(label, t('ctx.copyName')) });
    return items;
  }

  function buildLoanMenu(loan: ActiveBorrow): CtxItem[] {
    const items: CtxItem[] = [];
    const title = displayTitle({ title: loan.title }, t('common.untitled'));
    if (canSeeCirculation) items.push({ label: t('ctx.returnLoan'), icon: '📥', onClick: () => void quickReturnByBookId(loan.bookId, title, loan.id) });
    items.push({ label: t('ctx.openBook'), icon: '📖', onClick: () => void openBookById(loan.bookId) });
    if (canSeeCirculation && activeBorrows.some((l) => l.isOverdue)) {
      items.push({ label: t('ctx.returnAllOverdue'), icon: '⏰', onClick: () => void returnAllOverdue() });
    }
    items.push({ sep: true });
    items.push({ label: t('ctx.copyBorrower'), onClick: () => copyText(loan.borrowerContact ? `${loan.borrowerName} · ${loan.borrowerContact}` : loan.borrowerName, t('ctx.copyBorrower')) });
    return items;
  }

  // The fallback menu for empty space / general areas, plus copy+search when
  // there is a text selection.
  function buildDefaultMenu(selection: string): CtxItem[] {
    const items: CtxItem[] = [];
    const sel = selection.trim();
    if (sel) {
      const short = sel.length > 30 ? `${sel.slice(0, 30)}…` : sel;
      items.push({ label: t('ctx.copySelection'), icon: '📋', onClick: () => copyText(sel, t('ctx.copySelectionWhat')) });
      items.push({ label: t('ctx.searchSelection', { q: short }), icon: '🔎', onClick: () => { setQ(sel); setCurrentSection('books'); setCurrentPage(1); } });
      items.push({ sep: true });
    }
    if (canWrite) items.push({ label: t('ctx.addBook'), icon: '➕', onClick: () => { setCurrentSection('books'); setShowAddBook(true); } });
    items.push({ label: t('ctx.refresh'), icon: '🔄', onClick: () => void refreshEverything() });
    if (canExportCsv) items.push({ label: t('ctx.exportCsv'), icon: '⬇️', onClick: () => void exportFilteredBooksCsv() });
    items.push({ sep: true });
    items.push({ label: t('ctx.toggleTheme'), icon: theme === 'dark' ? '☀️' : '🌙', onClick: () => setTheme((c) => (c === 'dark' ? 'light' : 'dark')) });
    return items;
  }

  // Root-level right-click: default menu for empty space, but never hijack the
  // native menu on editable fields (a librarian needs cut/copy/paste there).
  function handleRootContextMenu(e: React.MouseEvent) {
    if (!loggedIn) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const selection = window.getSelection()?.toString() ?? '';
    openContextMenu(e, buildDefaultMenu(selection));
  }

  return (
    <div className="app-shell" aria-busy={isWorking} onContextMenu={handleRootContextMenu}>

      {/* Autocomplete suggestions for the add/edit book forms, sourced from the
          catalog's existing values so a librarian rarely retypes a repeated
          title, author, publisher, language, or shelf code. Datalists render
          nothing themselves; inputs opt in via a matching `list` attribute.
          Memoized so keystrokes don't rebuild the option lists. */}
      <CatalogDatalists facets={facets} />

      {/* ═══ OFFLINE BANNER ═══ */}
      {netStatus === 'offline' && (
        <div className="offline-banner" role="status" aria-live="polite">
          {t('app.offlineBanner')}
        </div>
      )}

      {/* ═══ SPLASH SCREEN ═══ */}
      {showSplash && (
        <div className={`splash-overlay${splashHiding ? ' splash-hiding' : ''}`}>
          <div className="splash-content">
            <div className="splash-logo">📚</div>
            <h1 className="splash-title">{t('app.brand')}</h1>
            <div className="splash-spinner" />
          </div>
        </div>
      )}

      {serialsEditorOpen && detailBook && canWrite && (
        <SerialHoldingsEditor
          book={detailBook}
          holdings={serialHoldings}
          onClose={() => setSerialsEditorOpen(false)}
          onSaved={async () => {
            const fresh = await apiRequest<Book>(`/api/books/${detailBook.id}`);
            setDetailBook(fresh);
            await loadSerialHoldings(detailBook.id);
            await loadBooks();
          }}
        />
      )}

      <HandbookDrawer />

      {copiesEditorOpen && detailBook && canWrite && (
        <CopiesEditor
          book={detailBook}
          onClose={() => setCopiesEditorOpen(false)}
          onSaved={async () => {
            // The record's own shelf/room/status are DERIVED from its copies, so
            // both the detail panel and the list have to be refetched or the
            // header badge disagrees with the copies underneath it.
            const fresh = await apiRequest<Book>(`/api/books/${detailBook.id}`);
            setDetailBook(fresh);
            await loadBooks();
          }}
        />
      )}

      {/* ═══ BULK EDIT MODAL ═══ */}
      {/* Reaches every field a bulk edit may touch. The rule the whole panel is
          built around: a control the librarian did not touch writes NOTHING.
          An empty box means "leave it alone" — blanking a field across a
          selection is a separate, explicit "Clear" toggle. */}
      {addCopiesOpen && canWrite && (
        <Dialog onClose={() => setAddCopiesOpen(false)} labelledBy="dlg-addcopies" style={{ maxWidth: '32rem' }}>
          <div>
            <div className="modal-header">
              <div className="modal-title-block">
                <h2 id="dlg-addcopies">{t('library.bulk.addCopies')}</h2>
                <p className="muted small">{t('library.copies.subtitle', { n: fmt(selectedBookIds.length) })}</p>
              </div>
            </div>
            <div style={{ padding: '1rem 1.5rem 1.5rem' }}>
              <p className="muted small" style={{ marginBottom: '1rem' }}>{t('library.copies.hint')}</p>
              <div className="form-row">
                <div>
                  <label htmlFor="fld-library-copies-count">{t('library.copies.count')}</label>
                  <input id="fld-library-copies-count"
                    type="number" min={1} max={10}
                    value={addCopiesCount}
                    onChange={(e) => setAddCopiesCount(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="fld-library-copies-shelf">{t('library.copies.shelf')}</label>
                  <input id="fld-library-copies-shelf"
                    value={addCopiesShelf}
                    onChange={(e) => setAddCopiesShelf(e.target.value)}
                    placeholder={t('library.copies.shelfPh')}
                    list="suggest-shelf"
                  />
                </div>
              </div>
              <div className="modal-actions" style={{ marginTop: '1rem' }}>
                <button className="secondary" onClick={() => setAddCopiesOpen(false)}>{t('common.cancel')}</button>
                <button
                  className="primary"
                  disabled={addCopiesBusy || selectedBookIds.length === 0}
                  onClick={() => void addCopiesToSelection()}
                >{addCopiesBusy ? t('app.working') : t('library.bulk.addCopies')}</button>
              </div>
            </div>
          </div>
        </Dialog>
      )}

      {bulkEditOpen && canWrite && (
        <Dialog onClose={closeBulkEditor} labelledBy="dlg-bulkedit" style={{ maxWidth: '46rem' }}>
          <div>
            <div className="modal-header">
              <div className="modal-title-block">
                <h2 id="dlg-bulkedit">{t('library.bulk.editTitle')}</h2>
                <p className="muted small">
                  {t('library.bulk.editSubtitle', { n: selectedBookIds.length })}
                </p>
              </div>
            </div>

            <div style={{ padding: '1rem 1.5rem 1.5rem' }}>
              <p className="muted small" style={{ marginBottom: '1rem' }}>
                {t('library.bulk.editHint')}
              </p>

              <h4 className="bulk-section-heading">{t('library.bulk.sectionCore')}</h4>
              <div className="custom-fields-grid">
                {/* Bound to the same state as the quick selector in the bar. */}
                <div className="form-field bulk-field">
                  <label htmlFor="bulk-status">{t('library.bulk.setStatusAria')}</label>
                  <select id="bulk-status" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                    <option value="">{t('library.bulk.unchanged')}</option>
                    <option value="available">{t('status.available')}</option>
                    {/* No 'borrowed' — lending goes through the borrow action. */}
                    <option value="lost">{t('status.lost')}</option>
                    <option value="maintenance">{t('status.maintenance')}</option>
                  </select>
                </div>
                {BULK_CORE_FIELDS.map((field) => {
                  const fieldId = `core:${field.key}`;
                  const cleared = bulkEditClears.has(fieldId);
                  return (
                    <div key={fieldId} className="form-field bulk-field">
                      <label htmlFor={`bulk-${fieldId}`}>{t(field.labelKey)}</label>
                      <input
                        id={`bulk-${fieldId}`}
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={bulkEditValues[fieldId] ?? ''}
                        disabled={cleared}
                        onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
                        placeholder={cleared ? t('library.bulk.willClear') : t('library.bulk.unchanged')}
                        list={field.listId}
                      />
                      <label className="checkbox-label bulk-clear">
                        <input
                          type="checkbox"
                          checked={cleared}
                          onChange={() => toggleBulkEditClear(fieldId)}
                        />
                        <span className="muted small">{t('library.bulk.clear2')}</span>
                      </label>
                    </div>
                  );
                })}
              </div>

              <h4 className="bulk-section-heading">{t('library.bulk.sectionTags')}</h4>
              <div className="custom-fields-grid">
                <div className="form-field">
                  <label htmlFor="bulk-tags-add">{t('library.bulk.tagsAdd')}</label>
                  <input
                    id="bulk-tags-add"
                    value={bulkTagsAdd}
                    onChange={(e) => setBulkTagsAdd(e.target.value)}
                    placeholder={t('library.bulk.tagsPh')}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="bulk-tags-remove">{t('library.bulk.tagsRemove')}</label>
                  <input
                    id="bulk-tags-remove"
                    value={bulkTagsRemove}
                    onChange={(e) => setBulkTagsRemove(e.target.value)}
                    placeholder={t('library.bulk.tagsPh')}
                  />
                </div>
              </div>

              {customFields.length > 0 && (
                <>
                  <h4 className="bulk-section-heading">{t('library.bulk.sectionAttrs')}</h4>
                  {pinnedCustomFields.length > 0 && (
                    <div className="cf-pinned-group">
                      <p className="cf-group-heading">★ {t('settings.pinnedGroup', { n: pinnedCustomFields.length })}</p>
                      <div className="custom-fields-grid">
                        {pinnedCustomFields.map(renderBulkCustomField)}
                      </div>
                    </div>
                  )}
                  {unpinnedCustomFields.length > 0 && (
                    <>
                      {pinnedCustomFields.length > 0 && (
                        <p className="cf-group-heading">{t('settings.otherGroup', { n: unpinnedCustomFields.length })}</p>
                      )}
                      <div className="custom-fields-grid">
                        {unpinnedCustomFields.map(renderBulkCustomField)}
                      </div>
                    </>
                  )}
                </>
              )}

              <div className="modal-actions" style={{ marginTop: '1.25rem' }}>
                <button className="secondary" onClick={resetBulkEditor}>
                  {t('library.bulk.resetFields')}
                </button>
                <button className="secondary" onClick={closeBulkEditor}>
                  {t('common.cancel')}
                </button>
                <button
                  className="primary"
                  disabled={bulkEditPendingCount === 0 || selectedBookIds.length === 0}
                  onClick={() => void applyBulkBookChanges()}
                >
                  {t('library.bulk.applyN', { fields: bulkEditPendingCount, books: selectedBookIds.length })}
                </button>
              </div>
            </div>
          </div>
        </Dialog>
      )}

      {/* ═══ PROFILE MODAL ═══ */}
      {profileOpen && currentUser && (
        <Dialog onClose={() => setProfileOpen(false)} labelledBy="dlg-profile" style={{ maxWidth: '32rem' }}>
          <div>
            <div className="modal-header">
              <div className="modal-title-block">
                <h2 id="dlg-profile">{t('profile.title')}</h2>
                <p className="muted small">{t('profile.subtitle')}</p>
              </div>
            </div>
            <div style={{ padding: '1rem 1.5rem 1.5rem' }}>
              {/* The course used to be reachable only from Settings, which needs
                  the `settings` permission — so the one person the course is FOR,
                  a librarian without it, could not re-read the thing they were
                  made to read. The profile dialog is behind nothing. */}
              <div style={{ marginBottom: '1rem' }}>
                <button
                  className="secondary small"
                  onClick={() => { setProfileOpen(false); setShowOnboarding(true); }}
                >
                  🎓 {t('profile.replayCourse')}
                </button>
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <span className="muted small" id="profile-uuid-label">{t('users.uuid')}</span>
                {/* A real <button>. It was a styled div with an onClick: not
                    focusable, not announced as interactive, and unreachable by
                    keyboard (SC 2.1.1 / 4.1.2). */}
                <button
                  type="button"
                  className="uuid-copy"
                  aria-describedby="profile-uuid-label"
                  title={t('users.uuidCopy')}
                  onClick={() => {
                    void navigator.clipboard?.writeText(currentUser.id);
                    toast.push('success', t('users.uuidCopied'));
                  }}
                >
                  {currentUser.id}
                </button>
                <p className="muted small" style={{ marginTop: '0.35rem' }}>{t('profile.uuidHint')}</p>
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <label className="muted small">{t('users.role')}</label>
                <div><code>{t(`users.role.${currentUser.role}` as never)}</code></div>
              </div>
              <form onSubmit={saveProfile} className="simple-form">
                <div>
                  <label htmlFor="fld-users-username">{t('users.username')}</label>
                  <input id="fld-users-username"
                    value={profileUsername}
                    onChange={(e) => setProfileUsername(e.target.value)}
                    minLength={3}
                    autoComplete="username"
                  />
                </div>
                <div>
                  <label htmlFor="fld-profile-newpassword">{t('profile.newPassword')}</label>
                  <input id="fld-profile-newpassword"
                    type="password"
                    value={profileNewPassword}
                    onChange={(e) => setProfileNewPassword(e.target.value)}
                    placeholder={t('profile.newPasswordPh')}
                    autoComplete="new-password"
                    minLength={8}
                  />
                  <p className="muted small">{t('users.passwordHint')}</p>
                </div>
                <div>
                  <label htmlFor="fld-profile-currentpassword">{t('profile.currentPassword')} *</label>
                  <input id="fld-profile-currentpassword"
                    type="password"
                    value={profileCurrentPassword}
                    onChange={(e) => setProfileCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <p className="muted small">{t('profile.currentHint')}</p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
                  <button type="button" className="secondary" onClick={() => setProfileOpen(false)} disabled={profileSubmitting}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="primary" disabled={profileSubmitting}>
                    {profileSubmitting ? t('common.loading') : t('profile.save')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </Dialog>
      )}

      {/* ═══ BOOK DETAIL MODAL ═══ */}
      {detailBook && (
        <Dialog onClose={closeDetail} labelledBy="dlg-detail-title">
          <div
            onContextMenu={(e) => {
              // Keep the native menu on the edit form's text fields.
              if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
              openContextMenu(e, buildBookMenu(detailBook), displayTitle(detailBook, t('common.untitled')));
            }}
          >

            {/* Header */}
            <div className="modal-header">
              <div className="modal-avatar" aria-hidden="true">{(displayTitle(detailBook, t('common.untitled')).charAt(0) || '?').toUpperCase()}</div>
              <div className="modal-title-block">
                <h2 id="dlg-detail-title" className={isPlaceholder(detailBook.title, 'title') || !detailBook.title ? 'is-placeholder' : ''}>
                  {displayTitle(detailBook, t('common.untitled'))}
                </h2>
                {/* The romanized reading sits UNDER the vernacular title, the
                    way a MARC 880 linked field is displayed — never in place
                    of it. This is the visible half of the ISBN-lookup fix. */}
                {detailBook.titleRomanized && (
                  <p className="romanized-line muted small" lang="und-Latn">{detailBook.titleRomanized}</p>
                )}
                <p className={`modal-author${isPlaceholder(detailBook.author, 'author') || !detailBook.author ? ' is-placeholder' : ''}`}>
                  {displayAuthor(detailBook, t('common.unknownAuthor'))}
                </p>
                {detailBook.authorRomanized && (
                  <p className="romanized-line muted small" lang="und-Latn">{detailBook.authorRomanized}</p>
                )}
                <div className="modal-pills">
                  <span className={`status-badge status-${detailBook.status}`}>{t(`status.${detailBook.status}`)}</span>
                  {detailBook.legacyId ? (
                    <span className="legacy-id-pill" title={t('detail.legacyTitle')}>{detailBook.legacyId}</span>
                  ) : null}
                </div>
              </div>
              {/* Same prohibited-attribute problem as the card badge: a
                  roleless div cannot carry an accessible name. */}
              <div className="modal-shelf-block">
                <span className="sr-only">
                  {detailBook.shelfCode ? t('detail.shelfAria', { code: detailBook.shelfCode }) : t('detail.shelfNoneAria')}
                </span>
                <span className="modal-shelf-label" aria-hidden="true">{t('detail.shelf')}</span>
                <span className={`modal-shelf-value${detailBook.shelfCode ? '' : ' is-empty'}`}>
                  {detailBook.shelfCode || '—'}
                </span>
              </div>
              <button className="modal-close" onClick={closeDetail} aria-label={t('common.close')} title={t('common.close')}>
                <span aria-hidden="true">✕</span>
              </button>
            </div>

            {/* Action bar */}
            <div className="modal-actions">
              {detailMode === 'view' ? (
                <>
                  {canWrite && (
                    <button className="secondary small" onClick={() => startEditFromDetail()}>{t('detail.editBtn')}</button>
                  )}
                  {canWrite && Boolean((detailBook.customFields as Record<string, unknown> | undefined)?.needs_review) && (
                    <button className="primary small" onClick={() => void markReviewed(detailBook)}>{t('detail.markReviewed')}</button>
                  )}
                  {canSeeCirculation && detailBook.status === 'available' && (
                    <button className="primary small" onClick={() => {
                      setSelectedBook(detailBook);
                      setCurrentSection('circulation');
                      closeDetail();
                    }}>{t('detail.borrowBtn')}</button>
                  )}
                  {canSeeCirculation && detailBook.status === 'borrowed' && (
                    <button className="secondary small" onClick={() => { void returnBook(detailBook); closeDetail(); }}>
                      {t('detail.returnBtn')}
                    </button>
                  )}
                  {/* Queue for a book whose copies are all out. Placing a hold on
                      an available book is allowed too — it puts the copy aside
                      straight away — but the button belongs where the need is. */}
                  {canSeeCirculation && detailBook.status !== 'available' && (
                    <button className="secondary small" onClick={() => void placeHold(detailBook)}>
                      {t('holds.place')}
                    </button>
                  )}
                  {canPrintLabels && (
                    <button className="secondary small" onClick={() => void printLabels([detailBook])}>{t('detail.labelBtn')}</button>
                  )}
                  {canDelete && (
                    <button className="danger small" onClick={() => void deleteBook(detailBook)}>{t('detail.deleteBtn')}</button>
                  )}
                </>
              ) : (
                <button className="secondary small" onClick={() => setDetailMode('view')}>{t('detail.backBtn')}</button>
              )}
            </div>

            {/* Body */}
            <div className="modal-body">
              {detailMode === 'view' ? (
                <>
                  {/* Cover image */}
                  <div className="detail-section cover-section">
                    {detailBook.coverUrl ? (
                      <button
                        type="button"
                        className="detail-cover-zoom"
                        onClick={() => setCoverZoom(joinApiUrl(detailBook.coverUrl!))}
                        title={t('detail.coverZoomHint')}
                        aria-label={t('detail.coverZoomHint')}
                      >
                        <img
                          className="detail-cover"
                          src={joinApiUrl(detailBook.coverUrl)}
                          alt={t('detail.coverAlt', { title: displayTitle(detailBook, t('common.untitled')) })}
                          loading="lazy"
                        />
                        <span className="cover-zoom-hint" aria-hidden="true">
                          <span className="cover-zoom-icon">🔍</span>
                          {t('detail.coverZoomHint')}
                        </span>
                      </button>
                    ) : (
                      <div className="detail-cover detail-cover-placeholder">
                        <span>{t('detail.noCover')}</span>
                      </div>
                    )}
                    {canWrite && (
                      <div className="cover-actions">
                        <label className="secondary small button-like">
                          {detailBook.coverUrl ? t('detail.replaceCover') : t('detail.uploadCover')}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            // NOT display:none — that removes the input from the tab order,
                            // and a <label> is not focusable, so this control could
                            // not be reached by keyboard at all (SC 2.1.1, Level A).
                            className="sr-only"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              e.target.value = '';
                              if (f) void uploadBookCover(detailBook, f);
                            }}
                          />
                        </label>
                        {detailBook.coverUrl && (
                          <button className="danger small" onClick={() => void deleteBookCover(detailBook)}>{t('detail.removeCover')}</button>
                        )}
                        <span className="muted small">{t('detail.coverHint')}</span>
                      </div>
                    )}
                  </div>

                  {/* Core Info */}
                  <div className="detail-section">
                    <div className="detail-section-title">{t('detail.bookInfo')}</div>
                    <div className="detail-grid">
                      {detailBook.isbn && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.isbn')}</span>
                          <span className="di-value">
                            {detailBook.isbn}
                            {/* The server has computed this on every read since
                                Phase B and nothing has ever shown it, so a
                                mistyped ISBN stayed silently wrong. A warning,
                                never an error: small publishers really do
                                misprint check digits, and refusing the value
                                would make the book uncatalogueable. */}
                            {detailBook.isbnValid === false && (
                              <span className="badge warn" title={t('detail.isbnBadTitle')}>
                                {t('detail.isbnBad')}
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                      {detailBook.ddc && (
                        <div className="detail-item">
                          <span className="di-label">{t('library.add.ddc')}</span>
                          <span className="di-value">{detailBook.ddc}</span>
                        </div>
                      )}
                      {displayBookDate(detailBook) && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.yearPublished')}</span>
                          <span className="di-value">{displayBookDate(detailBook)}</span>
                        </div>
                      )}
                      {detailBook.publisher && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.publisher')}</span>
                          <span className="di-value">{detailBook.publisher}</span>
                        </div>
                      )}
                      {detailBook.language && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.language')}</span>
                          <span className="di-value">{detailBook.language}</span>
                        </div>
                      )}
                      {detailBook.roomCode && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.room')}</span>
                          <span className="di-value">{detailBook.roomCode}</span>
                        </div>
                      )}
                      {detailBook.shelfCode && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.shelfRow')}</span>
                          <span className="di-value">{detailBook.shelfCode}</span>
                        </div>
                      )}
                      <div className="detail-item">
                        <span className="di-label">{t('detail.statusRow')}</span>
                        <span className="di-value">
                          <span className={`status-badge status-${detailBook.status}`}>{t(`status.${detailBook.status}`)}</span>
                        </span>
                      </div>
                    </div>
                    {detailBook.description && (
                      <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.6' }}>
                        {detailBook.description}
                      </p>
                    )}
                  </div>

                  {/* Controlled headings: who this is, under one form, with the
                      variant spellings recorded rather than overwritten. This is
                      what MARC 100/700/650 export from. */}
                  <div className="detail-section">
                    <div className="detail-section-title">
                      {t('authorities.onBook')}
                      <HelpLink anchor="what-a-heading-is" label={t('handbook.helpAbout', { field: t('authorities.onBook') })} />
                    </div>
                    <BookAuthorities
                      bookId={detailBook.id}
                      canWrite={canWrite}
                      onChanged={() => { void loadBooks(); }}
                    />
                  </div>

                  {/* The run of a periodical. Only for a serial — MARC keeps a
                      holdings statement instead of a record per issue, which is
                      the whole point: ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ is 47 book rows
                      today and should be one title with a run. */}
                  {detailBook.bibLevel === 'serial' && (
                    <div className="detail-section">
                      <div className="detail-section-title">{t('serials.heading')}</div>
                      {serialHoldings.length === 0 ? (
                        <p className="muted small">{t('serials.none')}</p>
                      ) : (
                        <ul className="copies-list">
                          {serialHoldings.map((h) => (
                            <li key={h.id}>
                              <span className="copy-number">
                                {formatHoldingStatement(h) || t('serials.unspecified')}
                              </span>
                              {h.gaps && <span className="meta-chip warn">{t('serials.gapsShort')} {h.gaps}</span>}
                              {h.note && <span className="muted small">{h.note}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {canWrite && (
                        <button
                          className="secondary small"
                          style={{ marginTop: '0.5rem' }}
                          onClick={() => setSerialsEditorOpen(true)}
                        >
                          {t('serials.editHeading')}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Holdings: where the physical copies actually are. Shown
                      whenever a record is held more than once — for a single
                      copy the location is already in the header badge, and
                      repeating it would be noise. */}
                  {(detailBook.items?.length ?? 0) > 0 && (
                    <div className="detail-section">
                      <div className="detail-section-title">
                        {t('library.copies.heading', { n: fmt(detailBook.items?.length ?? 0) })}
                      </div>
                      <ul className="copies-list">
                        {(detailBook.items ?? []).map((item) => (
                          <li key={item.id}>
                            <span className="copy-number">{t('library.copies.nth', { n: item.copyNumber })}</span>
                            <span className={`shelf-badge${item.shelfCode ? '' : ' shelf-missing'}`}>
                              <span className="shelf-icon" aria-hidden="true">📍</span>
                              <span className="shelf-value">{item.shelfCode || t('library.book.noShelf')}</span>
                            </span>
                            {item.volumeNum && <span className="meta-chip">{item.volumeNum}</span>}
                            {item.barcode && <span className="meta-chip mono">{item.barcode}</span>}
                            {item.itemType && item.itemType !== 'book' && (
                              <span className="meta-chip">{t(`itemType.${item.itemType}`)}</span>
                            )}
                            <span className={`status-badge status-${item.status}`}>{t(`status.${item.status}`)}</span>
                          </li>
                        ))}
                      </ul>
                      {/* The full per-copy editor. It used to be two controls
                          in a <details> — a type select and a date — that saved
                          on every change event, so nine writable columns had no
                          control at all and a librarian moving quickly through
                          the dropdown collided with their own in-flight save. */}
                      {canWrite && (
                        <button
                          className="secondary small"
                          style={{ marginTop: '0.5rem' }}
                          onClick={() => setCopiesEditorOpen(true)}
                        >
                          {t('copies.editHeading')}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Custom field attributes, driven by the DEFINITIONS rather
                      than by whatever keys happen to be on the book. That gives
                      three things the old Object.entries walk could not: the
                      attribute's real label instead of a name derived from the
                      raw key, the everyday (pinned) group first, and a stable
                      order that matches the edit form. Values whose definition
                      has since been deleted are still shown — under "Other", so
                      data the librarian typed never silently disappears. */}
                  {detailAttributeGroups.total > 0 && (
                    <div className="detail-section">
                      <div className="detail-section-title">{t('detail.attributes')}</div>
                      {detailAttributeGroups.pinned.length > 0 && (
                        <>
                          {detailAttributeGroups.other.length + detailAttributeGroups.orphans.length > 0 && (
                            <div className="attr-group-heading">{t('detail.attributes.everyday')}</div>
                          )}
                          <div className="attr-grid">
                            {detailAttributeGroups.pinned.map((a) => (
                              <div key={a.key} className="attr-tile">
                                <span className="attr-key">{a.label}</span>
                                <span className="attr-value">{a.value}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                      {detailAttributeGroups.other.length > 0 && (
                        <>
                          {detailAttributeGroups.pinned.length > 0 && (
                            <div className="attr-group-heading">{t('detail.attributes.other')}</div>
                          )}
                          <div className="attr-grid">
                            {detailAttributeGroups.other.map((a) => (
                              <div key={a.key} className="attr-tile">
                                <span className="attr-key">{a.label}</span>
                                <span className="attr-value">{a.value}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                      {detailAttributeGroups.orphans.length > 0 && (
                        <>
                          <div className="attr-group-heading">{t('detail.attributes.unrecognised')}</div>
                          <div className="attr-grid">
                            {detailAttributeGroups.orphans.map((a) => (
                              <div key={a.key} className="attr-tile is-orphan">
                                <span className="attr-key">{a.label}</span>
                                <span className="attr-value">{a.value}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Borrow History */}
                  {canSeeCirculation && (
                  <div className="detail-section">
                    {detailHolds.length > 0 && (
                  <>
                    <div className="detail-section-title">{t('holds.queueHeading', { n: detailHolds.length })}</div>
                    <ul className="copies-list">
                      {detailHolds.map((h) => (
                        <li key={h.id}>
                          <span className="copy-number">{h.position}</span>
                          <span>{h.borrowerName}</span>
                          {h.status === 'ready'
                            ? <span className="badge ready">{t('holds.ready')}</span>
                            : <span className="muted small">{t('holds.waitingSince', { date: new Date(h.placedAt).toLocaleDateString() })}</span>}
                          <button type="button" className="secondary small" onClick={() => void cancelHold(h)}>{t('holds.cancel')}</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="detail-section-title">{t('detail.history')}</div>
                    {bookHistory.length === 0 ? (
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>{t('detail.noHistory')}</p>
                    ) : (
                      <div className="history-list">
                        {bookHistory.map((h) => (
                          <div key={h.id} className="history-item">
                            <div className="history-item-info">
                              <strong>{h.borrowerName}</strong>
                              <span>
                                {new Date(h.borrowedAt).toLocaleDateString()} →{' '}
                                {h.returnedAt ? new Date(h.returnedAt).toLocaleDateString() : t('detail.currentlyActive')}
                              </span>
                            </div>
                            {h.wasOverdue && <span className="history-overdue-badge">{t('detail.overdueBadge')}</span>}
                          </div>
                        ))}
                        {bookHistoryHasMore && detailBook && (
                          <button
                            type="button"
                            className="secondary small"
                            style={{ alignSelf: 'flex-start' }}
                            onClick={() => void loadBookHistory(detailBook.id, bookHistory.length)}
                          >{t('detail.loadMoreHistory')}</button>
                        )}
                      </div>
                    )}
                  </div>
                  )}
                </>
              ) : (
                /* ── Edit Mode ── */
                <form onSubmit={saveBookEdit} className="simple-form">
                  <div className="form-row">
                    <div>
                      <label htmlFor="fld-detail-title">{t('detail.title')}<span className="required-mark"> *</span></label>
                      <HelpLink anchor="title-proper" label={t('handbook.helpAbout', { field: t('detail.title') })} />
                      <input id="fld-detail-title"
                        ref={editTitleInputRef}
                        className={editFieldErrors.has('title') ? 'input-error' : undefined}
                        aria-required="true"
                        aria-invalid={editFieldErrors.has('title') || undefined}
                        value={editForm.title}
                        onChange={(e) => {
                          setEditForm({ ...editForm, title: e.target.value });
                          if (editFieldErrors.has('title')) {
                            setEditFieldErrors((prev) => {
                              const next = new Set(prev);
                              next.delete('title');
                              return next;
                            });
                          }
                        }}
                      />
                    </div>
                    <div>
                      <label htmlFor="fld-detail-author">{t('detail.author')}</label>
                      <HelpLink anchor="greek-name-order" label={t('handbook.helpAbout', { field: t('detail.author') })} />
                      <input id="fld-detail-author" list="suggest-author" value={editForm.author} onChange={(e) => setEditForm({ ...editForm, author: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label htmlFor="fld-detail-isbn">{t('detail.isbn')}</label>
                      <HelpLink anchor="isbn" label={t('handbook.helpAbout', { field: t('detail.isbn') })} />
                      <input id="fld-detail-isbn" className="isbn-input" value={editForm.isbn} onChange={(e) => setEditForm({ ...editForm, isbn: e.target.value })} placeholder={t('detail.isbnPh')} inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
                    </div>
                    <div>
                      <label htmlFor="fld-detail-yearpublished">{t('detail.yearPublished')}</label>
                      <HelpLink anchor="uncertain-dates" label={t('handbook.helpAbout', { field: t('detail.yearPublished') })} />
                      <input id="fld-detail-yearpublished"
                        value={editForm.publicationYear}
                        onChange={(e) => setEditForm({ ...editForm, publicationYear: e.target.value })}
                        placeholder={t('detail.yearPh')}
                      />
                      <EdtfHint value={editForm.publicationYear} t={t} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label htmlFor="fld-detail-shelfrow">{t('detail.shelfRow')}</label>
                      <input id="fld-detail-shelfrow" list="suggest-shelf" value={editForm.shelfCode} onChange={(e) => setEditForm({ ...editForm, shelfCode: e.target.value })} placeholder={t('detail.shelfPh')} />
                    </div>
                    <div>
                      <label htmlFor="fld-detail-statusrow">{t('detail.statusRow')}</label>
                      <select id="fld-detail-statusrow" value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as BookStatus })}>
                        {/* 'borrowed' is owned by the borrow/return actions — the
                            server rejects setting it manually (or clearing it to
                            available). Offer only the transitions the edit path is
                            allowed to make from the book's real current state. */}
                        {detailBook?.status === 'borrowed'
                          ? <option value="borrowed">{t('status.borrowed')}</option>
                          : <option value="available">{t('status.available')}</option>}
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label htmlFor="fld-detail-publisher">{t('detail.publisher')}</label>
                      <HelpLink anchor="publisher" label={t('handbook.helpAbout', { field: t('detail.publisher') })} />
                      <input id="fld-detail-publisher" list="suggest-publisher" value={editForm.publisher} onChange={(e) => setEditForm({ ...editForm, publisher: e.target.value })} placeholder={t('detail.publisherPh')} />
                    </div>
                    <div>
                      <label htmlFor="fld-detail-language">{t('detail.language')}</label>
                      <HelpLink anchor="parallel-fields" label={t('handbook.helpAbout', { field: t('detail.language') })} />
                      <input id="fld-detail-language" list="suggest-language" value={editForm.language} onChange={(e) => setEditForm({ ...editForm, language: e.target.value })} placeholder={t('detail.languagePh')} />
                    </div>
                    <div>
                      <label htmlFor="fld-detail-ddc">{t('library.add.ddc')}</label>
                      <HelpLink anchor="ddc" label={t('handbook.helpAbout', { field: t('library.add.ddc') })} />
                      <input
                        id="fld-detail-ddc"
                        value={editForm.ddc}
                        onChange={(e) => setEditForm({ ...editForm, ddc: e.target.value })}
                        placeholder={t('library.add.ddcPh')}
                      />
                    </div>
                    <div>
                      {/* MARC leader/07. The column has existed since 0024 with
                          no way to set it, so every record was a monograph and
                          the ISO 2789 return said the library held no serials. */}
                      <label htmlFor="fld-detail-biblevel">{t('library.add.bibLevel')}</label>
                      <HelpLink anchor="date-ranges" label={t('handbook.helpAbout', { field: t('library.add.bibLevel') })} />
                      <select
                        id="fld-detail-biblevel"
                        value={editForm.bibLevel}
                        onChange={(e) => setEditForm({ ...editForm, bibLevel: e.target.value as BibLevel })}
                      >
                        <option value="monograph">{t('bibLevel.monograph')}</option>
                        <option value="serial">{t('bibLevel.serial')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-field">
                    <label htmlFor="fld-library-add-description">{t('library.add.description')}</label>
                    <textarea id="fld-library-add-description"
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      rows={3}
                    />
                  </div>

                  <details className="custom-fields-section" open>
                    <summary>{t('library.add.attributes', { n: customFields.length })}</summary>
                    {renderCustomFieldsForm(
                      attributeEditorValues,
                      (key, value) => {
                        setAttributeEditorValues((prev) => ({ ...prev, [key]: value }));
                        const empty = value === undefined || value === null || value === '';
                        if (!empty && editFieldErrors.has(`cf:${key}`)) {
                          setEditFieldErrors((prev) => {
                            const next = new Set(prev);
                            next.delete(`cf:${key}`);
                            return next;
                          });
                        }
                      },
                      editFieldErrors
                    )}
                  </details>

                  <div className="button-group">
                    <button type="submit" className="primary" disabled={isWorking}>{isWorking ? t('common.saving') : t('detail.saveChanges')}</button>
                    <button type="button" className="secondary" onClick={() => setDetailMode('view')}>{t('common.cancel')}</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </Dialog>
      )}

      {/* ═══ COVER ZOOM LIGHTBOX ═══ */}
      {coverZoom && (
        <CoverLightbox src={coverZoom} onClose={() => setCoverZoom(null)} />
      )}

      {/* ═══ CUSTOM CONTEXT MENU ═══ */}
      {contextMenu && <ContextMenuView state={contextMenu} onClose={closeContextMenu} />}
      {/* Hidden picker reused by the "Replace/Add cover" menu item. */}
      <input
        ref={coverInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        // Genuinely offscreen plumbing: opened programmatically by the context
        // menu, never tabbed to, so display:none is correct here. Named anyway.
        aria-label={t('detail.uploadCover')}
        tabIndex={-1}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          const b = coverUploadBookRef.current;
          coverUploadBookRef.current = null;
          if (f && b) void uploadBookCover(b, f);
        }}
      />

      {/* ═══ ONBOARDING COURSE (replay from Settings — closable) ═══ */}
      {showOnboarding && !mustOnboard && (
        <OnboardingCourse onFinish={() => void completeOnboarding()} onClose={() => setShowOnboarding(false)} />
      )}

      {/* ═══ LOGIN ═══ */}
      {sessionLoading ? null : !loggedIn ? (
        <div className="simple-center">
          <div className="simple-card">
            <div className="login-logo">📚</div>
            <h2>{t('app.brand')}</h2>
            <p className="login-subtitle">{t('app.subtitle')}</p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.75rem' }}>
              <LanguageSwitcher />
            </div>
            <form onSubmit={login} className="simple-form">
              <div>
                <label htmlFor="fld-login-username">{t('login.username')}</label>
                <input id="fld-login-username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
              </div>
              <div>
                <label htmlFor="fld-login-password">{t('login.password')}</label>
                <input id="fld-login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <button type="submit" className="primary" disabled={isWorking}>{isWorking ? t('login.signingIn') : t('login.signIn')}</button>
            </form>
          </div>
        </div>
      ) : mustOnboard ? (
        /* Mandatory first-run librarian course — no bypass; the app below is
           unreachable until it's finished (which flips needsOnboarding false). */
        <OnboardingCourse mandatory onFinish={() => void completeOnboarding()} />
      ) : (
        <>
          {/* ─── Navbar ─── */}
          {/* Skip link: the facet rail can render hundreds of buttons before
              the results, and a keyboard user had to tab through all of them.
              SC 2.4.1 Bypass Blocks. */}
          <a className="skip-link" href="#main-content">{t('a11y.skipToContent')}</a>
          <header className="simple-navbar">
            <div className="navbar-brand">
              <div className="navbar-icon">📚</div>
              <h1>{t('app.brand')}</h1>
            </div>
            <div className="navbar-right">
              <DownloadDesktopButton />
              <LanguageSwitcher />
              <button
                className="theme-toggle"
                onClick={() => setTheme((curr) => (curr === 'dark' ? 'light' : 'dark'))}
                title={theme === 'dark' ? t('app.switchToLight') : t('app.switchToDark')}
                aria-label={t('app.toggleDark')}
              >
                {theme === 'dark' ? '☀' : '🌙'}
              </button>
              {currentUser && (
                <button
                  type="button"
                  className="secondary small navbar-user-btn"
                  onClick={openProfile}
                  title={t('profile.open')}
                  // SC 2.5.3: the accessible name must CONTAIN the visible
                  // label, or a speech-input user saying the username cannot
                  // activate the control.
                  aria-label={`${currentUser.username} — ${t('profile.open')}`}
                >
                  <span aria-hidden="true">👤 </span>{currentUser.username}
                </button>
              )}
              <button className="secondary small" onClick={logout}>{t('app.signOut')}</button>
            </div>
          </header>

          {/* ─── Tabs ─── */}
          {/* The active tab was conveyed by a colour and a 2.5px underline and
              nothing else — no role, no aria-selected, no aria-current — so a
              screen-reader user could not tell which section they were in. */}
          <nav className="simple-tabs" aria-label={t('app.brand')}>
            {sectionMeta.map((section) => (
              <button
                key={section.key}
                className={currentSection === section.key ? 'tab-btn active' : 'tab-btn'}
                aria-current={currentSection === section.key ? 'page' : undefined}
                onClick={() => setCurrentSection(section.key)}
              >
                <span className="tab-icon" aria-hidden="true">{section.icon}</span>
                <span className="tab-label">{section.label}</span>
              </button>
            ))}
          </nav>

          <main className="simple-content" id="main-content" tabIndex={-1}>

            {/* ═══ DASHBOARD TAB ═══ */}
            {currentSection === 'dashboard' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('dashboard.title')}</h2>
                    <p>{t('dashboard.description')}</p>
                  </div>
                  <div className="section-header-actions">
                    <button className="secondary small" onClick={() => void loadStats()}>{t('common.refresh')}</button>
                  </div>
                </div>

                {/* ISO 2789 — the return a library files, rather than the
                    dashboard's point-in-time counts. */}
                <div className="card">
                  <h3>{t('iso.heading')}</h3>
                  <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('iso.intro')}</p>
                  <div className="search-bar" style={{ alignItems: 'flex-end' }}>
                    <div className="filter-field">
                      <label htmlFor="iso-from">{t('iso.from')}</label>
                      <input id="iso-from" type="date" value={isoFrom} onChange={(e) => setIsoFrom(e.target.value)} />
                    </div>
                    <div className="filter-field">
                      <label htmlFor="iso-to">{t('iso.to')}</label>
                      <input id="iso-to" type="date" value={isoTo} onChange={(e) => setIsoTo(e.target.value)} />
                    </div>
                    <div className="search-actions">
                      <span aria-hidden="true" className="field-spacer" />
                      <button className="primary" disabled={isoBusy} onClick={() => void runIso2789()}>
                        {isoBusy ? t('iso.running') : t('iso.run')}
                      </button>
                    </div>
                  </div>

                  {isoReport && (
                    <div style={{ marginTop: '1rem' }}>
                      {isoReport.stockBaselineDate && (
                        <p className="muted small">{t('iso.baseline', { date: isoReport.stockBaselineDate.slice(0, 10) })}</p>
                      )}
                      <div className="stats-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginTop: '0.5rem' }}>
                        <div className="stat-box"><span className="stat-box-label">{t('iso.titles')}</span><span className="stat-box-value">{fmt(isoReport.collection.titles)}</span></div>
                        <div className="stat-box accent"><span className="stat-box-label">{t('iso.items')}</span><span className="stat-box-value">{fmt(isoReport.collection.items)}</span></div>
                        <div className="stat-box"><span className="stat-box-label">{t('iso.loans')}</span><span className="stat-box-value">{fmt(isoReport.flow.loans)}</span></div>
                        <div className="stat-box"><span className="stat-box-label">{t('iso.activeBorrowers')}</span><span className="stat-box-value">{fmt(isoReport.flow.activeBorrowers)}</span></div>
                      </div>

                      <div className="iso-grid">
                        <section>
                          <h4>{t('iso.byCategory')}</h4>
                          <ul className="iso-list">
                            {isoReport.collection.byDocumentCategory.map((r) => (
                              <li key={r.category}><span>{t(`itemType.${r.category}`)}</span><span>{fmt(r.items)}</span></li>
                            ))}
                          </ul>
                        </section>
                        <section>
                          <h4>{t('iso.byLanguage')}</h4>
                          <ul className="iso-list">
                            {isoReport.collection.byLanguage.slice(0, 12).map((r) => (
                              <li key={r.language}><span className="mono">{r.language}</span><span>{fmt(r.titles)}</span></li>
                            ))}
                          </ul>
                        </section>
                        <section>
                          <h4>{t('iso.flow')}</h4>
                          <ul className="iso-list">
                            <li><span>{t('iso.additions')}</span><span>{fmt(isoReport.flow.additions)}</span></li>
                            <li><span>{t('iso.withdrawals')}</span><span>{fmt(isoReport.flow.withdrawals.total)}</span></li>
                            <li><span>{t('iso.itemsLent')}</span><span>{fmt(isoReport.flow.itemsLent)}</span></li>
                            <li><span>{t('iso.renewed')}</span><span>{fmt(isoReport.flow.renewedLoans)}</span></li>
                            <li><span>{t('iso.serials')}</span><span>{fmt(isoReport.collection.serialTitles)}</span></li>
                            <li><span>{t('iso.users')}</span><span>{fmt(isoReport.users.registered)}</span></li>
                          </ul>
                        </section>
                      </div>

                      {/* The caveats sit WITH the numbers. A figure quoted
                          without its qualification is how a report misleads. */}
                      {isoReport.caveats.length > 0 && (
                        <div className="merge-preview" style={{ marginTop: '0.75rem' }}>
                          <p className="small" style={{ margin: 0, fontWeight: 600 }}>{t('iso.caveats')}</p>
                          <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
                            {isoReport.caveats.map((cav, i) => (
                              <li key={i} className="muted small">{cav}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="button-group" style={{ marginTop: '0.75rem' }}>
                        <button className="secondary small" onClick={() => {
                          const qs = `from=${encodeURIComponent(isoFrom + 'T00:00:00.000Z')}&to=${encodeURIComponent(isoTo + 'T23:59:59.999Z')}`;
                          void downloadWithAuth(`/api/reports/iso2789.csv?${qs}`, `iso2789-${isoFrom}.csv`);
                        }}>{t('iso.download')}</button>
                      </div>
                    </div>
                  )}
                </div>

                {!stats ? (
                  <div className="card empty-state"><p style={{ fontSize: '2rem' }}>📊</p><p>{t('dashboard.loading')}</p></div>
                ) : (
                  <>
                    {/* KPI tiles */}
                    <div className="stats-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                      <div className="stat-box accent">
                        <span className="stat-box-label">{t('dashboard.totalBooks')}</span>
                        <span className="stat-box-value">{fmt(stats.completeness.total)}</span>
                      </div>
                      <div className="stat-box success">
                        <span className="stat-box-label">{t('status.available')}</span>
                        <span className="stat-box-value">
                          {fmt(stats.byStatus.find((s) => s.status === 'available')?.count ?? 0)}
                        </span>
                      </div>
                      <div className="stat-box warning">
                        <span className="stat-box-label">{t('status.borrowed')}</span>
                        <span className="stat-box-value">
                          {fmt(stats.byStatus.find((s) => s.status === 'borrowed')?.count ?? 0)}
                        </span>
                      </div>
                      <div className="stat-box danger">
                        <span className="stat-box-label">{t('dashboard.lostMaint')}</span>
                        <span className="stat-box-value">
                          {fmt((stats.byStatus.find((s) => s.status === 'lost')?.count ?? 0)
                            + (stats.byStatus.find((s) => s.status === 'maintenance')?.count ?? 0))}
                        </span>
                      </div>
                    </div>

                    <div className="dashboard-grid">
                      {/* Completeness */}
                      <div className="card">
                        <h3>{t('dashboard.completeness')}</h3>
                        <div className="completeness-list">
                          {([
                            [t('dashboard.compl.isbn'), stats.completeness.withIsbn],
                            [t('dashboard.compl.shelf'), stats.completeness.withShelf],
                            [t('dashboard.compl.publisher'), stats.completeness.withPublisher],
                            [t('dashboard.compl.year'), stats.completeness.withYear]
                          ] as Array<[string, number]>).map(([label, n]) => {
                            const pct = stats.completeness.total > 0
                              ? Math.round((n / stats.completeness.total) * 100)
                              : 0;
                            return (
                              <div key={label} className="completeness-row">
                                <span className="completeness-label">{label}</span>
                                <div className="completeness-bar">
                                  <div className="completeness-fill" style={{ width: `${pct}%` }} />
                                </div>
                                <span className="completeness-pct">{pct}%</span>
                                <span className="completeness-count">{fmt(n)}</span>
                              </div>
                            );
                          })}
                        </div>
                        {(stats.completeness.untitled > 0 || stats.completeness.unknownAuthor > 0) && (
                          <p className="muted small" style={{ marginTop: '0.75rem' }}>
                            {t('dashboard.complNote', { untitled: fmt(stats.completeness.untitled), unknown: fmt(stats.completeness.unknownAuthor) })}
                          </p>
                        )}
                      </div>

                      {/* Languages */}
                      <div className="card">
                        <h3>{t('dashboard.languages')}</h3>
                        {stats.byLanguage.length === 0 ? (
                          <p className="muted small">{t('dashboard.noLangData')}</p>
                        ) : (
                          <div className="minibar-list">
                            {stats.byLanguage.map((l) => (
                              <MiniBar
                                key={l.language}
                                label={l.language}
                                value={l.count}
                                count={l.count}
                                max={stats.byLanguage[0].count}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Years */}
                      <div className="card">
                        <h3>{t('dashboard.publicationYear')}</h3>
                        <div className="minibar-list">
                          {stats.byYear.map((y) => (
                            <MiniBar
                              key={y.bucket}
                              label={y.bucket}
                              value={y.count}
                              count={y.count}
                              max={Math.max(...stats.byYear.map((b) => b.count))}
                            />
                          ))}
                        </div>
                      </div>

                      {/* Top Shelves */}
                      <div className="card">
                        <h3>{t('dashboard.topShelves')}</h3>
                        {stats.topShelves.length === 0 ? (
                          <p className="muted small">{t('dashboard.noShelves')}</p>
                        ) : (
                          <div className="minibar-list">
                            {stats.topShelves.map((s) => (
                              <MiniBar
                                key={s.shelfCode}
                                label={s.shelfCode}
                                value={s.count}
                                count={s.count}
                                max={stats.topShelves[0].count}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Recent activity */}
                      <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <h3>{t('dashboard.recent')}</h3>
                        {stats.recentlyUpdated.length === 0 ? (
                          <p className="muted small">{t('dashboard.noRecent')}</p>
                        ) : (
                          <ul className="recent-list">
                            {stats.recentlyUpdated.map((b) => (
                              <li key={b.id}>
                                <button
                                  className="recent-link"
                                  onClick={() => {
                                    // Was an inline `.then` with no `.catch`: /api/stats is served
                                    // stale-while-revalidate from IndexedDB, so a row can name a
                                    // record that has since been deleted — and the click then did
                                    // nothing at all, no modal, no toast, just an unhandled
                                    // rejection in the console. openBookDetailById reports the
                                    // failure and opens the record the same way every other
                                    // id-only caller does (holds, history and the hold shelf
                                    // included, which the inline copy had drifted away from).
                                    // The tab only changes if the record actually opened — a
                                    // click that failed should not also move the librarian off
                                    // the Dashboard.
                                    void openBookDetailById(b.id).then((opened) => {
                                      if (opened) setCurrentSection('books');
                                    });
                                  }}
                                >
                                  <strong>{b.title || t('common.untitled')}</strong>
                                  <span className="muted small"> · {b.author || t('common.unknown')}</span>
                                  {b.legacyId && <span className="legacy-id-pill">{b.legacyId}</span>}
                                </button>
                                <span className="muted small">{new Date(b.updatedAt).toLocaleString()}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ═══ LIBRARY TAB ═══ */}
            {currentSection === 'books' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('library.title')}</h2>
                    <p>{t('library.description')}</p>
                  </div>
                  <div className="section-header-actions">
                    {canWrite && (
                      <button className="primary small" onClick={() => setShowAddBook((v) => !v)}>
                        {showAddBook ? t('library.cancelAdd') : t('library.addBook')}
                      </button>
                    )}
                    {canWrite && (
                      <button
                        className={`small ${selectionMode ? 'primary' : 'secondary'}`}
                        onClick={() => {
                          // Toggling selection mode only shows/hides the row
                          // checkboxes — it never discards the selection. Only
                          // "Clear selection" does that (the bulk bar stays
                          // visible while a selection exists).
                          setSelectionMode((v) => !v);
                        }}
                        aria-pressed={selectionMode}
                        title={selectionMode ? t('library.select.exit') : t('library.select.enter')}
                      >
                        {selectionMode
                          ? t('library.select.done', { n: selectedBookIds.length })
                          : t('library.select.start')}
                      </button>
                    )}
                    {canExportCsv && (
                      <button className="secondary small" onClick={exportFilteredBooksCsv}>{t('library.exportCsv')}</button>
                    )}
                  </div>
                </div>

                {/* Stats */}
                <div className="stats-row">
                  <div className="stat-box accent">
                    <span className="stat-box-label">{t('library.totalBooks')}</span>
                    <span className="stat-box-value">{fmt(totalBooksCount)}</span>
                  </div>
                  <div className="stat-box success">
                    <span className="stat-box-label">{t('status.available')}</span>
                    <span className="stat-box-value">{availableBooksDisplay}</span>
                    {filtersActive && <span className="stat-box-scope">{t('library.wholeCatalogue')}</span>}
                  </div>
                  <div className="stat-box warning">
                    <span className="stat-box-label">{t('status.borrowed')}</span>
                    <span className="stat-box-value">{borrowedBooksDisplay}</span>
                    {filtersActive && <span className="stat-box-scope">{t('library.wholeCatalogue')}</span>}
                  </div>
                  {/* Overdue is derived from active-loan data, which only
                      circulation users can load — hide it for viewers rather
                      than show a misleading permanent 0. */}
                  {canSeeCirculation && (
                    <div className="stat-box danger">
                      <span className="stat-box-label">{t('library.overdue')}</span>
                      <span className="stat-box-value">{overdueCount}</span>
                      {filtersActive && <span className="stat-box-scope">{t('library.wholeCatalogue')}</span>}
                    </div>
                  )}
                </div>

                {/* Quick filter chips: pinned shortcuts that toggle filters without opening Advanced. */}
                <div className="filter-chips">
                  <button
                    type="button"
                    className={`chip${needsReviewFilter ? ' is-active' : ''}`}
                    /* aria-pressed, because this chip is a toggle whose only signal was its
                       fill colour: the label, the count and the accessible name were
                       byte-identical in both states, so a screen reader announced no
                       difference and a sighted librarian had nothing but a hue to go on. The
                       facet-rail buttons and the selection-mode toggle already carry it, so
                       this was an omission rather than house style. The ✕ below is the
                       non-colour cue, matching the smart-list chips exactly. */
                    aria-pressed={needsReviewFilter}
                    onClick={() => setNeedsReviewFilter((v) => !v)}
                    title={t('library.needsReviewTitle')}
                  >
                    {t('library.needsReview')}
                    {needsReviewCount > 0 && <span className="chip-count">{fmt(needsReviewCount)}</span>}
                    {needsReviewFilter && <span className="chip-x" aria-hidden="true">✕</span>}
                  </button>
                  {SMART_LISTS.map((list) => {
                    const active = smartListKey === list.key;
                    const label = t(list.labelKey);
                    return (
                      <button
                        key={list.key}
                        type="button"
                        className={`chip${active ? ' is-active' : ''}`}
                        onClick={() => {
                          if (active) { setSmartListKey(''); return; }
                          setSmartListKey(list.key);
                          // Reflect any control-backed params into their bound
                          // state so the visible Status/Sort controls agree with
                          // what the chip actually queries (e.g. "Currently
                          // borrowed" sets Status, "Recently added" sets Sort).
                          const p = list.params as Record<string, string>;
                          if (p.status !== undefined) setStatus(p.status);
                          if (p.sortBy !== undefined) setSortBy(p.sortBy as SortBy);
                          if (p.sortDir !== undefined) setSortDir(p.sortDir as SortDir);
                        }}
                        title={t('library.smartListTitle', { label })}
                      >
                        <span className="chip-icon">{list.icon}</span> {label}
                        {active && <span className="chip-x">✕</span>}
                      </button>
                    );
                  })}
                  {(facetValue || facetEmpty) && (
                    <button
                      type="button"
                      className="chip is-active"
                      onClick={clearFacetSelection}
                      title={t('library.categoryFilterTitle')}
                    >
                      {t('library.facets.chip', {
                        field: facetChoices.find((f) => f.key === facetField)?.label ?? facetField,
                        value: facetEmpty ? t('library.facets.empty') : facetValue
                      })}
                      <span className="chip-x">✕</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="chip ghost"
                    onClick={() => setShowCategoryRail((v) => !v)}
                    title={showCategoryRail ? t('library.catBrowser.hide') : t('library.catBrowser.show')}
                  >
                    {showCategoryRail ? t('library.hideCats') : t('library.showCats')}
                  </button>
                </div>

                <div className={`library-layout${showCategoryRail ? '' : ' no-rail'}`}>
                  {showCategoryRail && (
                    /* Facet browser. Was category-only; now it groups by any of
                       the fields in FACET_CHOICES, because the librarian uses
                       these counts to reconcile the catalogue against the
                       shelves: "μπορώ να κάνω έλεγχο αριθμητικό επιτόπου στο
                       ράφι και αν δεν συμφωνεί … έπειτα να ψάξω ποιο βιβλίο
                       λείπει." Every bucket, including "(not filled in)", opens
                       a list holding exactly the number shown. */
                    <aside className="category-rail">
                      <div className="category-rail-head">
                        <h3>{t('library.cats.title')}</h3>
                        <span className="muted small">
                          {facetTruncated
                            ? t('library.facets.truncated', { n: fmt(facetItems.length) })
                            : t('library.cats.totalCount', { n: facetItems.length })}
                        </span>
                      </div>
                      <select
                        className="category-rail-field"
                        value={facetField}
                        onChange={(e) => { setFacetField(e.target.value); clearFacetSelection(); }}
                        // `title` is a tooltip, not an accessible name for a
                        // select — it is used only when nothing better exists,
                        // and inconsistently.
                        aria-label={t('library.facets.fieldTitle')}
                        title={t('library.facets.fieldTitle')}
                      >
                        {facetChoices.map((f) => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                      <input
                        className="category-rail-search"
                        // A placeholder is not an accessible name — it
                        // disappears the moment the field has a value.
                        aria-label={t('library.cats.filter')}
                        placeholder={t('library.cats.filter')}
                        value={categoryRailQuery}
                        onChange={(e) => setCategoryRailQuery(e.target.value)}
                      />
                      {facetField === RAIL_SETS ? (
                        /* Multi-part works, with the volumes that are absent.
                           Clicking a set filters the list to its members, so
                           the librarian can go from "volume 7 is missing" to
                           the shelf it belongs on. */
                        <>
                          <label className="rail-toggle">
                            <input
                              type="checkbox"
                              checked={setsGapsOnly}
                              onChange={(e) => setSetsGapsOnly(e.target.checked)}
                            />
                            {t('library.sets.gapsOnly')}
                          </label>
                          {(setsMeta.suppressed > 0 || setsMeta.matched > bookSets.length) && (
                            <p className="muted small rail-note">
                              {setsMeta.matched > bookSets.length
                                ? t('library.sets.showingOf', {
                                  shown: fmt(bookSets.length), matched: fmt(setsMeta.matched)
                                })
                                : t('library.sets.groupCount', { n: fmt(setsMeta.matched) })}
                              {setsMeta.suppressed > 0
                                ? ` ${t('library.sets.suppressed', { n: fmt(setsMeta.suppressed) })}`
                                : ''}
                            </p>
                          )}
                          <ul className="category-rail-list">
                            {setsLoading && bookSets.length === 0 && (
                              <li><span className="muted small">{t('app.working')}</span></li>
                            )}
                            {bookSets
                              .filter((set) => {
                                const needle = categoryRailQuery.trim().toLowerCase();
                                return !needle || set.title.toLowerCase().includes(needle);
                              })
                              .map((set) => (
                                <li key={set.key}>
                                  <button
                                    type="button"
                                    className={`category-rail-item set-row${facetValue === set.title ? ' is-active' : ''}`}
                                    aria-pressed={facetValue === set.title}
                                    onClick={() => selectFacet({ value: set.title, isEmpty: false, count: set.bookCount })}
                                    title={set.title}
                                  >
                                    <span className="cat-label"><span className="cat-text">{set.title}</span></span>
                                    <span className="cat-count">{fmt(set.bookCount)}</span>
                                    {set.gapsAvailable && set.missingCount > 0 && (
                                      <span className="set-gap" title={t('library.sets.missingTitle', { list: set.missing.slice(0, 20).join(', ') })}>
                                        {t('library.sets.missingN', { n: fmt(set.missingCount) })}
                                      </span>
                                    )}
                                    {!set.gapsAvailable && set.unnumbered > 0 && (
                                      <span className="set-unnumbered">{t('library.sets.unnumbered')}</span>
                                    )}
                                  </button>
                                </li>
                              ))}
                          </ul>
                        </>
                      ) : (
                      <ul className="category-rail-list">
                        <li>
                          <button
                            type="button"
                            className={`category-rail-item${!facetValue && !facetEmpty ? ' is-active' : ''}`}
                            aria-pressed={!facetValue && !facetEmpty}
                            onClick={clearFacetSelection}
                          >
                            <span className="cat-label">{t('library.cats.all')}</span>
                            {/* The LIBRARY total, from the same memoized key the
                                unfiltered list uses. It used to render the
                                current filtered total, so applying any other
                                filter silently changed the "All" row. */}
                            <span className="cat-count">{fmt(facetTotalBooks ?? totalBooksCount)}</span>
                          </button>
                        </li>
                        {facetItems
                          .filter((item) => {
                            const needle = categoryRailQuery.trim().toLowerCase();
                            if (!needle) return true;
                            if (item.isEmpty) return false;
                            return item.value.toLowerCase().includes(needle);
                          })
                          .map((item) => {
                            const active = item.isEmpty ? facetEmpty : facetValue === item.value;
                            const label = item.isEmpty ? t('library.facets.empty') : item.value;
                            return (
                              <li key={item.isEmpty ? ' empty' : item.value}>
                                <button
                                  type="button"
                                  className={`category-rail-item${active ? ' is-active' : ''}${item.isEmpty ? ' is-empty-bucket' : ''}`}
                                  aria-pressed={active}
                                  onClick={() => selectFacet(item)}
                                  onContextMenu={(e) => openContextMenu(e, buildFacetMenu(item), label)}
                                  title={label}
                                >
                                  <span className="cat-label">
                                    <span className="cat-text">{label}</span>
                                  </span>
                                  <span className="cat-count">{fmt(item.count)}</span>
                                </button>
                              </li>
                            );
                          })}
                      </ul>
                      )}
                    </aside>
                  )}
                  <div className="library-main">

                {/* Add Book (collapsible) */}
                {canWrite && showAddBook && (
                  <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
                    <h3>{t('library.add.title')}</h3>
                    <form onSubmit={createBook} className="simple-form">
                      <div className="form-row">
                        {/* Titles already in the catalogue surface HERE, while the
                            librarian types, rather than as a warning after the
                            duplicate has already been created. Picking a row
                            opens that book — it never writes into this field. */}
                        <Combobox<TitleSuggestion>
                          idPrefix="add-title"
                          className="combobox title-combobox"
                          label={<>{t('library.add.bookTitle')}<span className="required-mark"> *</span></>}
                          value={createForm.title}
                          inputRef={titleInputRef}
                          inputClassName={createFieldErrors.has('title') ? 'input-error' : undefined}
                          ariaRequired
                          ariaInvalid={createFieldErrors.has('title')}
                          onChange={(v) => {
                            setCreateForm({ ...createForm, title: v });
                            scheduleTitleSuggest(v);
                            // Clear the title error as soon as the librarian starts typing.
                            if (createFieldErrors.has('title')) {
                              setCreateFieldErrors((prev) => {
                                const next = new Set(prev);
                                next.delete('title');
                                return next;
                              });
                            }
                          }}
                          items={titleSuggestions}
                          getKey={(b) => b.id}
                          onPick={(b) => { void openBookDetailById(b.id); }}
                          listHeader={
                            <p className="title-dup-note">
                              {t('library.add.titleDupNote', { n: fmt(titleSuggestTotal) })}
                            </p>
                          }
                          renderItem={(b) => (
                            <>
                              <span className="combo-name">{displayTitle(b, t('common.untitled'))}</span>
                              <span className="combo-contact muted small">{displayAuthor(b, t('common.unknownAuthor'))}</span>
                              <span className="combo-stats muted small">
                                {b.shelfCode ? <span className="shelf-badge">{b.shelfCode}</span> : null}
                                {b.publicationYear ? <span> · {b.publicationYear}</span> : null}
                              </span>
                            </>
                          )}
                          placeholder={t('library.add.titlePh')}
                        />
                        <div>
                          <label htmlFor="fld-library-add-author">{t('library.add.author')}</label>
                          <input id="fld-library-add-author" list="suggest-author" value={createForm.author} onChange={(e) => setCreateForm({ ...createForm, author: e.target.value })} placeholder={t('library.add.authorPh')} />
                        </div>
                      </div>
                      {/* Parallel (romanized) forms. Only shown once something is
                          there — normally that means an ISBN lookup returned a
                          romanized reading, which now lands here instead of
                          overwriting the Greek title. */}
                      {(createForm.titleRomanized || createForm.authorRomanized || createForm.publisherRomanized) && (
                        <div className="romanized-block">
                          <p className="muted small">{t('library.add.romanizedNote')}</p>
                          <div className="form-row">
                            <div>
                              <label htmlFor="fld-library-add-titleromanized">{t('library.add.titleRomanized')}</label>
                              <input id="fld-library-add-titleromanized" value={createForm.titleRomanized} onChange={(e) => setCreateForm({ ...createForm, titleRomanized: e.target.value })} />
                            </div>
                            <div>
                              <label htmlFor="fld-library-add-authorromanized">{t('library.add.authorRomanized')}</label>
                              <input id="fld-library-add-authorromanized" value={createForm.authorRomanized} onChange={(e) => setCreateForm({ ...createForm, authorRomanized: e.target.value })} />
                            </div>
                          </div>
                        </div>
                      )}
                      {/* ISBN spans its own full-width row so the number stays fully
                          visible while typing and the lookup button sits beside it
                          without squeezing the field into a few characters. */}
                      <div className="form-field">
                        <label htmlFor="fld-add-isbn">{t('library.add.isbn')}</label>
                        <div className="isbn-row">
                          <input
                            id="fld-add-isbn"
                            className="isbn-input"
                            value={createForm.isbn}
                            onChange={(e) => setCreateForm({ ...createForm, isbn: e.target.value })}
                            placeholder={t('library.add.isbnPh')}
                            inputMode="text"
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            onKeyDown={(e) => {
                              // Enter inside the ISBN field triggers lookup rather than
                              // submitting the (likely incomplete) form. The librarian
                              // can still click "Add Book" once they're satisfied.
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (!isbnLookupBusy) void enrichFromIsbn();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="secondary small"
                            onClick={() => void enrichFromIsbn()}
                            disabled={isbnLookupBusy || !createForm.isbn.trim()}
                            title={t('library.add.lookupHint')}
                          >
                            {isbnLookupBusy ? t('library.add.lookupSearching') : t('library.add.lookupIsbn')}
                          </button>
                        </div>
                        <p className="muted small" style={{ marginTop: '0.25rem' }}>{t('library.add.lookupHint')}</p>
                      </div>
                      <div className="form-row">
                        <div>
                          <label htmlFor="fld-library-add-year">{t('library.add.year')}</label>
                          <HelpLink anchor="uncertain-dates" label={t('handbook.helpAbout', { field: t('library.add.year') })} />
                          <input id="fld-library-add-year"
                            value={createForm.publicationYear}
                            onChange={(e) => setCreateForm({ ...createForm, publicationYear: e.target.value })}
                            placeholder={t('library.add.yearPh')}
                          />
                          <EdtfHint value={createForm.publicationYear} t={t} />
                        </div>
                        <div>
                          <label htmlFor="fld-library-add-shelf">{t('library.add.shelf')}</label>
                          <input id="fld-library-add-shelf" list="suggest-shelf" value={createForm.shelfCode} onChange={(e) => setCreateForm({ ...createForm, shelfCode: e.target.value })} placeholder={t('library.add.shelfPh')} />
                        </div>
                      </div>
                      <div className="form-row">
                        <div>
                          <label htmlFor="fld-library-add-publisher">{t('library.add.publisher')}</label>
                          <HelpLink anchor="publisher" label={t('handbook.helpAbout', { field: t('library.add.publisher') })} />
                          <input id="fld-library-add-publisher" list="suggest-publisher" value={createForm.publisher} onChange={(e) => setCreateForm({ ...createForm, publisher: e.target.value })} placeholder={t('library.add.publisherPh')} />
                        </div>
                        <div>
                          <label htmlFor="fld-library-add-language">{t('library.add.language')}</label>
                          <input id="fld-library-add-language" list="suggest-language" value={createForm.language} onChange={(e) => setCreateForm({ ...createForm, language: e.target.value })} placeholder={t('library.add.languagePh')} />
                        </div>
                        <div>
                          {/* Dewey sits ALONGSIDE the shelf mark, never replacing
                              it — nobody is re-labelling 12,675 spines. It has been
                              accepted by the API and written by the ISBN lookup and
                              MARC import since Phase B with no field to show it. */}
                          <label htmlFor="fld-library-add-ddc">{t('library.add.ddc')}</label>
                          <HelpLink anchor="ddc" label={t('handbook.helpAbout', { field: t('library.add.ddc') })} />
                          <input
                            id="fld-library-add-ddc"
                            value={createForm.ddc}
                            onChange={(e) => setCreateForm({ ...createForm, ddc: e.target.value })}
                            placeholder={t('library.add.ddcPh')}
                          />
                        </div>
                        <div>
                          <label htmlFor="fld-library-add-biblevel">{t('library.add.bibLevel')}</label>
                          <HelpLink anchor="date-ranges" label={t('handbook.helpAbout', { field: t('library.add.bibLevel') })} />
                          <select
                            id="fld-library-add-biblevel"
                            value={createForm.bibLevel}
                            onChange={(e) => setCreateForm({ ...createForm, bibLevel: e.target.value as BibLevel })}
                          >
                            <option value="monograph">{t('bibLevel.monograph')}</option>
                            <option value="serial">{t('bibLevel.serial')}</option>
                          </select>
                        </div>
                      </div>
                      <div className="form-field">
                        <label htmlFor="fld-library-add-description-2">{t('library.add.description')}</label>
                        <textarea id="fld-library-add-description-2"
                          value={createForm.description}
                          onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                          rows={2}
                          placeholder={t('library.add.descriptionPh')}
                        />
                      </div>

                      {/* Cover image — staged here, uploaded right after the book row
                          is created (the cover endpoint keys on the book id). */}
                      <div className="form-field">
                        {/* This names a GROUP (preview + upload button), not a
                            single control, so it is not a <label>. */}
                        <span className="field-group-label">{t('library.add.cover')}</span>
                        <div className="cover-section">
                          {createCoverPreview ? (
                            <img className="detail-cover" src={createCoverPreview} alt={t('library.add.coverPreviewAlt')} />
                          ) : (
                            <div className="detail-cover detail-cover-placeholder">
                              <span>{t('detail.noCover')}</span>
                            </div>
                          )}
                          <div className="cover-actions">
                            <label className="secondary small button-like">
                              {createCoverFile ? t('detail.replaceCover') : t('detail.uploadCover')}
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/webp,image/gif"
                                // See above: display:none would make this unreachable by keyboard.
                                className="sr-only"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  e.target.value = '';
                                  if (f) selectCreateCover(f);
                                }}
                              />
                            </label>
                            {createCoverFile && (
                              <button type="button" className="danger small" onClick={clearCreateCover}>{t('detail.removeCover')}</button>
                            )}
                            <span className="muted small">{t('detail.coverHint')}</span>
                          </div>
                        </div>
                      </div>

                      <details className="custom-fields-section" open={customFields.length > 0 && (customFields.length <= 6 || [...createFieldErrors].some((k) => k.startsWith('cf:')))}>
                        <summary>{t('library.add.attributes', { n: customFields.length })}</summary>
                        {renderCustomFieldsForm(
                          createAttrValues,
                          (key, value) => {
                            setCreateAttrValues((prev) => ({ ...prev, [key]: value }));
                            // Clear a required-field error once the field is given a value.
                            const empty = value === undefined || value === null || value === '';
                            if (!empty && createFieldErrors.has(`cf:${key}`)) {
                              setCreateFieldErrors((prev) => {
                                const next = new Set(prev);
                                next.delete(`cf:${key}`);
                                return next;
                              });
                            }
                          },
                          createFieldErrors
                        )}
                      </details>

                      <div className="button-group">
                        <button type="submit" className="primary" disabled={isWorking}>{isWorking ? t('common.saving') : t('library.add.submit')}</button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setShowAddBook(false);
                            setCreateAttrValues({});
                            clearCreateCover();
                          }}
                        >{t('common.cancel')}</button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Duplicate warning after creating a book */}
                {duplicateWarning.length > 0 && (
                  <div className="card" /* `--warning-bg`, not `--bg-warning`. The token name was wrong, so this always
                          took the inline fallback `#fffbeb` — a light cream — including in the dark theme,
                          where the card's own text inherits `--text` (#e2e8f0) and landed at 1.19:1. The
                          panel looked like a blank cream rectangle, and what disappeared into it was the
                          LIST of records this book might duplicate, which is the only reason the panel
                          exists. `--warning-bg` has a dark value (#422006), so both themes now work and
                          neither needs a hardcoded fallback. */
                        style={{ borderLeft: '3px solid var(--warning)', background: 'var(--warning-bg)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <strong>{t('library.dup.title')}</strong>
                        <p style={{ marginTop: '0.4rem', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                          {t('library.dup.body')}
                        </p>
                        <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.875rem' }}>
                          {duplicateWarning.map((d) => (
                            <li key={d.id}><em>{displayTitle(d, t('common.untitled'))}</em> — {displayAuthor(d, t('common.unknownAuthor'))}{d.isbn ? ` (${t('library.add.isbn')}: ${d.isbn})` : ''}</li>
                          ))}
                        </ul>
                      </div>
                      <button className="secondary small" onClick={() => setDuplicateWarning([])}>{t('common.dismiss')}</button>
                    </div>
                  </div>
                )}

                {/* Search & Filter */}
                <div className="card">
                  <div className="search-bar">
                    <div className="search-field">
                      <label>
                        {t('library.search.label')} <span className="kbd-hint">{t('library.search.kbdHint')} <kbd>/</kbd></span>
                      </label>
                      <input
                        ref={searchInputRef}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        aria-label={t('library.search.label')}
                        placeholder={t('library.search.placeholder')}
                        list="suggest-author"
                      />
                    </div>
                    <div className="filter-field">
                      <label htmlFor="fld-library-search-status">{t('library.search.status')}</label>
                      <select id="fld-library-search-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">{t('status.allStatuses')}</option>
                        <option value="available">{t('status.available')}</option>
                        <option value="borrowed">{t('status.borrowed')}</option>
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                    </div>
                    <div className="filter-field">
                      <label htmlFor="fld-library-search-shelf">{t('library.search.shelf')}</label>
                      <input id="fld-library-search-shelf"
                        value={shelfFilter}
                        onChange={(e) => setShelfFilter(e.target.value)}
                        placeholder={t('library.search.shelfPh')}
                        title={t('library.search.shelfTitle')}
                        list="suggest-shelf"
                      />
                    </div>
                    <div className="filter-field">
                      <label htmlFor="fld-library-search-language">{t('library.search.language')}</label>
                      <input id="fld-library-search-language"
                        value={filterLanguage}
                        onChange={(e) => setFilterLanguage(e.target.value)}
                        placeholder={t('library.search.languagePh')}
                        list="lang-suggest"
                        title={t('library.search.languageTitle')}
                      />
                      <datalist id="lang-suggest">
                        {/*
                          Each language is listed in English / Greek / Korean / Russian
                          so a librarian can type their own and the server's synonym
                          map resolves it to the ISO code stored in the catalog.
                        */}
                        <option value="English" /><option value="Αγγλικά" /><option value="영어" /><option value="Английский" />
                        <option value="Greek" /><option value="Ελληνικά" /><option value="그리스어" /><option value="Греческий" />
                        <option value="German" /><option value="Γερμανικά" /><option value="독일어" /><option value="Немецкий" />
                        <option value="French" /><option value="Γαλλικά" /><option value="프랑스어" /><option value="Французский" />
                        <option value="Italian" /><option value="Ιταλικά" /><option value="이탈리아어" /><option value="Итальянский" />
                        <option value="Spanish" /><option value="Ισπανικά" /><option value="스페인어" /><option value="Испанский" />
                        <option value="Russian" /><option value="Ρωσικά" /><option value="러시아어" /><option value="Русский" />
                        <option value="Latin" /><option value="Λατινικά" /><option value="라틴어" /><option value="Латинский" />
                        <option value="Bulgarian" /><option value="Βουλγαρικά" /><option value="불가리아어" /><option value="Болгарский" />
                        <option value="Czech" /><option value="Τσεχικά" /><option value="체코어" /><option value="Чешский" />
                        <option value="Korean" /><option value="Κορεατικά" /><option value="한국어" /><option value="Корейский" />
                        <option value="Turkish" /><option value="Τουρκικά" /><option value="터키어" /><option value="Турецкий" />
                        <option value="Romanian" /><option value="Ρουμανικά" /><option value="루마니아어" /><option value="Румынский" />
                        <option value="Serbian" /><option value="Σερβικά" /><option value="세르비아어" /><option value="Сербский" />
                        <option value="Multilingual" /><option value="Πολύγλωσσο" /><option value="다국어" /><option value="Многоязычный" />
                      </datalist>
                    </div>
                    <div className="filter-field">
                      <label htmlFor="fld-library-search-year">{t('library.search.year')}</label>
                      <input id="fld-library-search-year" type="number" min={1000} max={3000} value={filterYear} onChange={(e) => setFilterYear(e.target.value)} placeholder={t('library.search.yearPh')} />
                    </div>
                    <div className="filter-field">
                      <label htmlFor="fld-search-sort">{t('library.search.sort')}</label>
                      <div className="sort-row">
                        <select id="fld-search-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                          <option value="updatedAt">{t('library.search.sortUpdated')}</option>
                          <option value="title">{t('library.search.sortTitle')}</option>
                          <option value="author">{t('library.search.sortAuthor')}</option>
                          <option value="publicationYear">{t('library.search.sortYear')}</option>
                          <option value="status">{t('library.search.sortStatus')}</option>
                        </select>
                        <button
                          type="button"
                          className="secondary small sort-dir-btn"
                          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                          title={sortDir === 'asc' ? t('library.search.sortAsc') : t('library.search.sortDesc')}
                          aria-label={t('library.search.sortDirAria')}
                        >
                          {sortDir === 'asc' ? '↑' : '↓'}
                        </button>
                      </div>
                    </div>
                    <div className="search-actions">
                      <span aria-hidden="true" className="field-spacer" />
                      <button className="secondary" onClick={() => { setShowAdvancedSearch((v) => !v); }}>
                        {showAdvancedSearch ? t('library.search.hideAdvanced') : t('library.search.advanced')}
                      </button>
                      {/* Cards → List → Table → Cards. The button shows where
                          the next click goes, matching the previous two-way
                          toggle's behaviour. */}
                      <button
                        className="secondary"
                        onClick={() => setDensity((d) => DENSITIES[(DENSITIES.indexOf(d) + 1) % DENSITIES.length] as Density)}
                        title={t('library.search.densityTitle')}
                      >
                        {density === 'comfortable'
                          ? t('library.search.densityList')
                          : density === 'compact'
                            ? t('library.search.densityTable')
                            : t('library.search.densityCards')}
                      </button>
                      {density === 'table' && (
                        <button
                          className={`secondary${showColumnPicker ? ' is-active' : ''}`}
                          onClick={() => setShowColumnPicker((v) => !v)}
                          title={t('library.table.columnsTitle')}
                        >
                          {t('library.table.columns', { n: fmt(visibleTableColumns.length) })}
                        </button>
                      )}
                      <button className="secondary" onClick={() => {
                        setQ('');
                        setQExclude('');
                        setQMode('all');
                        setPartialWords(true);
                        setFuzzyTypos(true);
                        setSearchFields(['title', 'author', 'isbn']);
                        setSearchEngine('lexical');
                        setStatus('');
                        setFilterLanguage('');
                        setFilterYear('');
                        setShelfFilter('');
                        clearFacetSelection();
                        setNeedsReviewFilter(false);
                        setSmartListKey('');
                        setCurrentPage(1);
                      }}>{t('common.reset')}</button>
                    </div>
                  </div>

                  {showAdvancedSearch && (
                    <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <div className="form-row">
                        <div>
                          <label htmlFor="fld-library-adv-engine">{t('library.adv.engine')}</label>
                          <select id="fld-library-adv-engine"
                            value={searchEngine}
                            onChange={(e) => setSearchEngine(e.target.value as 'lexical' | 'semantic')}
                            disabled={semanticAvailable === false}
                            title={semanticAvailable === false ? t('library.adv.semanticOff') : undefined}
                          >
                            <option value="lexical">{t('library.adv.engineLexical')}</option>
                            <option value="semantic" disabled={semanticAvailable === false}>
                              {t('library.adv.engineSemantic')}
                            </option>
                          </select>
                          {searchEngine === 'semantic' && (
                            <p className="muted small" style={{ marginTop: '0.25rem' }}>{t('library.adv.semanticHint')}</p>
                          )}
                          {semanticAvailable === false && (
                            <p className="muted small" style={{ marginTop: '0.25rem' }}>{t('library.adv.semanticOff')}</p>
                          )}
                        </div>
                        <div>
                          <label htmlFor="fld-library-adv-exclude">{t('library.adv.exclude')}</label>
                          <input id="fld-library-adv-exclude"
                            value={qExclude}
                            onChange={(e) => setQExclude(e.target.value)}
                            placeholder={t('library.adv.excludePh')}
                            disabled={searchEngine === 'semantic'}
                          />
                        </div>
                        <div>
                          <label htmlFor="fld-library-adv-matchmode">{t('library.adv.matchMode')}</label>
                          <select id="fld-library-adv-matchmode"
                            value={qMode}
                            onChange={(e) => setQMode(e.target.value as SearchMode)}
                            disabled={searchEngine === 'semantic'}
                          >
                            <option value="all">{t('library.adv.modeAll')}</option>
                            <option value="any">{t('library.adv.modeAny')}</option>
                            <option value="exact">{t('library.adv.modeExact')}</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="fld-library-adv-partialwords">{t('library.adv.partialWords')}</label>
                          <select id="fld-library-adv-partialwords"
                            value={partialWords ? 'yes' : 'no'}
                            onChange={(e) => setPartialWords(e.target.value === 'yes')}
                            disabled={searchEngine === 'semantic'}
                          >
                            <option value="yes">{t('library.adv.partialYes')}</option>
                            <option value="no">{t('library.adv.partialNo')}</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="fld-library-adv-fuzzy">{t('library.adv.fuzzy')}</label>
                          <select id="fld-library-adv-fuzzy"
                            value={fuzzyTypos ? 'on' : 'off'}
                            onChange={(e) => setFuzzyTypos(e.target.value === 'on')}
                            disabled={searchEngine === 'semantic'}
                          >
                            <option value="on">{t('library.adv.fuzzyOn')}</option>
                            <option value="off">{t('library.adv.fuzzyOff')}</option>
                          </select>
                        </div>
                      </div>

                      <label style={{ marginTop: '0.5rem' }}>{t('library.adv.searchIn')}</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.35rem' }}>
                        {([
                          ['title', t('library.adv.field.title')],
                          ['author', t('library.adv.field.author')],
                          ['isbn', t('library.adv.field.isbn')],
                          ['publisher', t('library.adv.field.publisher')],
                          ['language', t('library.adv.field.language')],
                          ['description', t('library.adv.field.description')],
                          ['shelfCode', t('library.adv.field.shelfCode')],
                          ['tags', t('library.adv.field.tags')],
                          ['custom', t('library.adv.field.custom')]
                        ] as Array<[SearchField, string]>).map(([field, label]) => (
                          <label key={field} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', margin: 0, fontSize: '0.82rem' }}>
                            <input
                              type="checkbox"
                              checked={searchFields.includes(field)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSearchFields((prev) => (prev.includes(field) ? prev : [...prev, field]));
                                } else {
                                  setSearchFields((prev) => {
                                    const next = prev.filter((value) => value !== field);
                                    return next.length > 0 ? next : ['title'];
                                  });
                                }
                              }}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Bulk action bar — only visible when at least one book is selected. */}
                {/* Shown whenever a selection exists — even after leaving selection
                    mode or paging away — so a selection is never invisible and the
                    user can always act on it or clear it. */}
                {canWrite && (selectionMode || selectedBookIds.length > 0) && (
                  <div className="bulk-bar" role="region" aria-label={t('library.bulk.aria')}>
                    <div className="bulk-bar-info">
                      <strong>{selectedBookIds.length} </strong>
                      <span className="muted small">{t('library.bulk.selectedSuffix')}</span>
                      {selectedOnPageCount < books.length && (
                        <button className="link-btn" onClick={selectAllOnPage}>{t('library.bulk.selectAll', { n: books.length })}</button>
                      )}
                      {selectedOnPageCount > 0 && (
                        <button className="link-btn" onClick={deselectAllOnPage}>{t('library.bulk.deselectPage', { n: selectedOnPageCount })}</button>
                      )}
                      {/* Criteria selection: everything matching the current
                          search/filters, across every page. */}
                      <button className="link-btn" onClick={selectAllMatchingFilters}>{t('library.bulk.selectMatching', { n: totalBooksCount })}</button>
                      <button className="link-btn" onClick={clearSelectedBooks}>{t('library.bulk.clear')}</button>
                    </div>
                    {/* Actions only make sense once something is selected; the
                        info row above still offers the criteria selectors. */}
                    <div className="bulk-bar-actions" style={selectedBookIds.length === 0 ? { display: 'none' } : undefined}>
                      <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} aria-label={t('library.bulk.setStatusAria')}>
                        <option value="">{t('library.bulk.setStatus')}</option>
                        <option value="available">{t('status.available')}</option>
                        {/* No 'borrowed' — lending goes through the borrow action so
                            book.status never desyncs from the loan record. */}
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                      {/* Same state the modal's Shelf field edits — two inputs
                          writing one column independently would have let the
                          librarian set two different shelves and silently get
                          whichever one the apply order happened to prefer. */}
                      <input
                        value={bulkEditValues['core:shelfCode'] ?? ''}
                        onChange={(e) => setBulkEditValue('core:shelfCode', e.target.value)}
                        placeholder={t('library.bulk.setShelf')}
                        aria-label={t('library.bulk.setShelfAria')}
                        list="suggest-shelf"
                      />
                      <button
                        className="primary small"
                        onClick={() => void applyBulkBookChanges()}
                        disabled={bulkEditPendingCount === 0}
                      >{bulkEditPendingCount > 1
                        ? t('library.bulk.applyNShort', { fields: bulkEditPendingCount })
                        : t('common.apply')}</button>
                      {/* Everything beyond status + shelf lives in a panel, so
                          the bar stays usable while still reaching every field. */}
                      <button
                        className="secondary small"
                        onClick={() => setBulkEditOpen(true)}
                      >{t('library.bulk.moreFields')}</button>
                      {/* Add a copy of each selected record, optionally on a
                          different shelf. This is what replaces re-cataloguing
                          a book because a second exemplar sits elsewhere. */}
                      <button
                        className="secondary small"
                        onClick={() => setAddCopiesOpen(true)}
                      >{t('library.bulk.addCopies')}</button>
                      {canPrintLabels && (
                        <button
                          className="secondary small"
                          onClick={() => {
                            // Resolve the whole selection so labels print for books
                            // on other pages too, not just the visible ones.
                            void (async () => {
                              try {
                                const targets = await resolveSelectedBooks(selectedBookIds);
                                await printLabels(targets);
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            })();
                          }}
                        >{t('library.bulk.labels')}</button>
                      )}
                      {/* Deletion needs books.delete, like every other delete
                          affordance (context menu, detail modal). Without this
                          gate the UI offered bulk delete to librarians whose
                          admin had turned deletion off. */}
                      {canDelete && (
                      <button
                        className="danger small"
                        onClick={async () => {
                          const ok = await confirm({
                            title: t('confirm.deleteBulkTitle', { n: selectedBookIds.length, s: selectedBookIds.length === 1 ? '' : 's' }),
                            body: t('confirm.deleteBulkBody'),
                            confirmLabel: t('confirm.deleteBulkAction'),
                            danger: true
                          });
                          if (!ok) return;
                          clearStatus();
                          try {
                            const ids = [...selectedBookIds];
                            // Batched sync pushes (1 KV write per batch) instead of N deletes.
                            const { success, failed, okIds } = await pushBulkMutations(
                              ids.map((id) => ({ operation: 'delete_book', payload: { id } }))
                            );
                            setMessage(failed === 0
                              ? t('toast.deletedAll', { n: success, s: success === 1 ? '' : 's' })
                              : t('toast.deletedMixed', { success, failed }));
                            // Drop only the books that were actually deleted — they no
                            // longer exist. Anything that failed stays selected so the
                            // librarian can see and retry it.
                            const deleted = new Set(okIds);
                            setSelectedBookIds((prev) => prev.filter((id) => !deleted.has(id)));
                            await Promise.all([loadBooks(), loadRoomSummary(), loadFacet(facetField), loadStats()]);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >{t('common.delete')}</button>
                      )}
                    </div>
                  </div>
                )}

                {/* Book Grid */}
                <div className="card">
                  {isLoadingBooks && books.length === 0 ? (
                    <BookCardSkeleton count={6} />
                  ) : booksError && books.length === 0 ? (
                    <div className="empty-state">
                      <p style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⚠️</p>
                      <p style={{ fontWeight: 600 }}>{t('library.error.title')}</p>
                      <p className="muted small">{booksError}</p>
                      <button
                        className="secondary"
                        style={{ marginTop: '0.75rem' }}
                        onClick={() => { void loadBooks(currentPage); }}
                      >{t('library.error.retry')}</button>
                    </div>
                  ) : books.length === 0 ? (
                    <div className="empty-state">
                      <p style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📚</p>
                      <p style={{ fontWeight: 600 }}>{t('library.empty.title')}</p>
                      <p className="muted small">
                        {q || facetValue || facetEmpty || needsReviewFilter || status || filterLanguage || filterYear || shelfFilter || smartListKey
                          ? t('library.empty.filtered')
                          : t('library.empty.bare')}
                      </p>
                    </div>
                  ) : (
                    <>
                      {density === 'table' && showColumnPicker && (
                        <div className="column-picker card">
                          <div className="column-picker-head">
                            <strong>{t('library.table.columnsTitle')}</strong>
                            <label className="column-picker-toggle">
                              <input
                                type="checkbox"
                                checked={tableHighlightGaps}
                                onChange={(e) => setTableHighlightGaps(e.target.checked)}
                              />
                              {t('library.table.highlightGaps')}
                            </label>
                            <button className="secondary small" onClick={() => setTableColumns(null)}>
                              {t('library.table.resetColumns')}
                            </button>
                          </div>
                          <div className="column-picker-grid">
                            {allTableColumns.map((col) => {
                              const on = visibleTableColumns.some((c) => c.key === col.key);
                              return (
                                <label key={col.key} className={on ? 'is-on' : undefined}>
                                  <input type="checkbox" checked={on} onChange={() => toggleTableColumn(col.key)} />
                                  {col.label}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {density === 'table' ? (
                        /* Spreadsheet view. The whole point is spotting gaps —
                           "να βλέπω π.χ. αν έχω παραλείψει να καταχωρήσω κάποιο
                           πεδίο" — so empty cells are marked rather than left
                           blank. The wrapper scrolls sideways, never the page. */
                        <div className="book-table-wrap">
                          <table className={`book-table${tableHighlightGaps ? ' show-gaps' : ''}`}>
                            {/* A caption, not an aria-label: it names the table
                                for AT and says what the rows are ordered by,
                                which nothing else in the table conveys — sorting
                                is driven by the toolbar, so no header carries
                                aria-sort. */}
                            <caption className="sr-only">
                              {t('library.table.caption', {
                                n: books.length,
                                sort: t(`library.sortBy.${sortBy}`),
                                dir: t(`library.sortDir.${sortDir}`)
                              })}
                            </caption>
                            <thead>
                              <tr>
                                {canWrite && selectionMode && <th className="col-select" scope="col"><span className="sr-only">{t('library.select.start')}</span></th>}
                                <th className="col-status" scope="col">{t('detail.statusRow')}</th>
                                {visibleTableColumns.map((col) => (
                                  <th
                                    key={col.key}
                                    scope="col"
                                    /* The title column is frozen: with 16 columns in a
                                       726px scroller, scrolling right to read a copy's
                                       condition otherwise leaves the row unidentifiable. */
                                    className={col.key === 'title' ? 'col-sticky' : undefined}
                                    style={col.width ? { minWidth: col.width } : undefined}
                                  >
                                    {col.label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {books.map((book) => {
                                const isSelected = selectedBookIds.includes(book.id);
                                return (
                                  <tr
                                    key={book.id}
                                    className={`${isSelected ? 'is-selected' : ''}${selectionMode ? ' is-selecting' : ''}`}
                                    {...bookRowHandlers(book)}
                                  >
                                    {canWrite && selectionMode && (
                                      <td className="col-select">
                                        <input
                                          type="checkbox"
                                          className="book-select"
                                          checked={isSelected}
                                          onChange={(e) => { e.stopPropagation(); toggleBookSelection(book.id); }}
                                          onClick={(e) => e.stopPropagation()}
                                          aria-label={t('library.book.selectAria', { title: displayTitle(book, t('common.untitled')) })}
                                        />
                                      </td>
                                    )}
                                    <td className="col-status">
                                      <span className={`status-badge status-${book.status}`}>{t(`status.${book.status}`)}</span>
                                    </td>
                                    {visibleTableColumns.map((col) => {
                                      const value = col.get(book);
                                      // Title and author render their localized
                                      // placeholder rather than looking merely blank.
                                      const display = col.key === 'title'
                                        ? displayTitle(book, t('common.untitled'))
                                        : col.key === 'author'
                                          ? displayAuthor(book, t('common.unknownAuthor'))
                                          : value;
                                      /*
                                       * The gap test has to use the SAME predicate the cell
                                       * renders with. `value.trim() === ''` is tested against
                                       * the raw getter, while the cell displays through
                                       * displayTitle/displayAuthor — so inside one filtered
                                       * list of author-less books, rows stored as '' got the
                                       * amber wash and a centred em-dash while rows stored as
                                       * the legacy '(Unknown)' sentinel showed the words
                                       * "(Άγνωστος συγγραφέας)" in ordinary body colour with no
                                       * wash at all. The view whose stated purpose is spotting
                                       * omissions was blind to half of them, and to exactly the
                                       * half that came from the legacy import. `isPlaceholder`
                                       * already existed for this.
                                       */
                                      const empty = (col.key === 'title' || col.key === 'author')
                                        ? isPlaceholder(value, col.key)
                                        : value.trim() === '';
                                      return (
                                        <td
                                          key={col.key}
                                          className={[
                                            empty ? 'cell-empty' : '',
                                            col.key === 'title' ? 'col-sticky' : ''
                                          ].filter(Boolean).join(' ') || undefined}
                                          title={empty ? undefined : display}
                                        >
                                          {empty ? <><span className="sr-only">{t('library.table.missing')}</span><span aria-hidden="true">—</span></> : display}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                      <div className={density === 'compact' ? 'book-list' : 'book-grid'}>
                        {books.map((book) => {
                          const isSelected = selectedBookIds.includes(book.id);
                          return (
                            <div
                              key={book.id}
                              className={`${density === 'compact' ? 'book-row' : 'book-card'}${isSelected ? ' is-selected' : ''}${selectionMode ? ' is-selecting' : ''}`}
                              {...bookCardHandlers(book)}
                            >
                              <input
                                type="checkbox"
                                className="book-select"
                                checked={isSelected}
                                onChange={(e) => { e.stopPropagation(); toggleBookSelection(book.id); }}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={t('library.book.selectAria', { title: displayTitle(book, t('common.untitled')) })}
                                style={canWrite && selectionMode ? undefined : { display: 'none' }}
                              />
                              {book.coverUrl ? (
                                <img
                                  className="book-avatar book-cover"
                                  src={joinApiUrl(book.coverUrl)}
                                  /* Decorative here: the title is right beside it, so an alt
                             would only repeat what the row already says. The
                             detail modal, where the cover stands alone, keeps a
                             real localized alt. */
                          alt=""
                                  loading="lazy"
                                  decoding="async"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                />
                              ) : (
                                <div className="book-avatar" aria-hidden="true">
                                  {(displayTitle(book, t('common.untitled')).charAt(0) || '?').toUpperCase()}
                                </div>
                              )}
                              <div className="book-card-body">
                                <span className={`book-card-title${isPlaceholder(book.title, 'title') || !book.title ? ' is-placeholder' : ''}`}>
                                  {q ? highlight(displayTitle(book, t('common.untitled')), q) : displayTitle(book, t('common.untitled'))}
                                </span>
                                <p className={`book-card-author${isPlaceholder(book.author, 'author') || !book.author ? ' is-placeholder' : ''}`}>
                                  {q ? highlight(displayAuthor(book, t('common.unknownAuthor')), q) : displayAuthor(book, t('common.unknownAuthor'))}
                                </p>
                                <div className="book-card-meta">
                                  {displayBookDate(book) && <span className="meta-chip">{displayBookDate(book)}</span>}
                                  {book.language && <span className="meta-chip">{book.language}</span>}
                                  {book.isbn && (
                                    book.isbnValid === false
                                      ? <span className="meta-chip is-warn" title={t('detail.isbnBadTitle')}>ISBN ⚠</span>
                                      : <span className="meta-chip">ISBN</span>
                                  )}
                                  {/* `title`, because the chip now ellipsises: a 64-character accession
                                      number would otherwise be unreadable AND unrecoverable. */}
                                  {book.legacyId && <span className="meta-chip mono" title={book.legacyId}>{book.legacyId}</span>}
                                  {/*
                                    * HOW MANY COPIES. A record held in ten places looked exactly
                                    * like a record held in one: a single shelf badge, a single
                                    * status pill, no count. So the 29 volumes that also sit on
                                    * "19-000 πίσω" advertised only "19-000" and the librarian
                                    * walked to one shelf; and nothing warned that printing labels
                                    * for that row yields ten stickers, not one. The data is
                                    * already on the record — `items` is loaded for every row in
                                    * the list — it was simply never shown.
                                    */}
                                  {(book.items?.length ?? 0) > 1 && (
                                    <span className="meta-chip" title={t('library.copiesTitle', { n: book.items?.length ?? 0 })}>
                                      ×{book.items?.length}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="book-card-side">
                                {/* Visually-hidden text, not aria-label: the
                                    attribute is PROHIBITED on a roleless span and
                                    is dropped, so the badge used to read as just
                                    "📍 19-000" with no indication of what that is. */}
                                <span
                                  className={`shelf-badge${book.shelfCode ? '' : ' shelf-missing'}`}
                                  title={book.shelfCode ? t('library.book.shelfTitle', { code: book.shelfCode }) : t('library.book.noShelfTitle')}
                                >
                                  <span className="shelf-icon" aria-hidden="true">📍</span>
                                  <span className="sr-only">
                                    {book.shelfCode ? t('library.book.shelfTitle', { code: book.shelfCode }) : t('library.book.noShelfAria')}
                                  </span>
                                  <span className="shelf-value" aria-hidden="true">{book.shelfCode || t('library.book.noShelf')}</span>
                                </span>
                                <span className={`status-badge status-${book.status}`}>{t(`status.${book.status}`)}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      )}
                      <div className="pagination">
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(1)}
                          disabled={currentPage === 1}
                          title={t('library.page.firstTitle')}
                        >{t('library.page.first')}</button>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(currentPage - 1)}
                          disabled={currentPage === 1}
                        >{t('library.page.prev')}</button>
                        <span className="pagination-info">
                          {t('library.page.info')} <strong>{currentPage}</strong> {t('library.page.of')} <strong>{Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE))}</strong>
                          <span className="muted small"> · {t('library.page.booksSuffix', { n: fmt(totalBooksCount) })}</span>
                        </span>
                        <form
                          className="page-jump"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const parsed = Number(jumpPage);
                            const totalPages = Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE));
                            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalPages) {
                              void loadBooks(Math.floor(parsed));
                              setJumpPage('');
                            }
                          }}
                        >
                          <input
                            value={jumpPage}
                            onChange={(e) => setJumpPage(e.target.value.replace(/[^0-9]/g, ''))}
                            placeholder={t('library.page.jump')}
                            aria-label={t('library.page.jumpAria')}
                          />
                          <button type="submit" className="secondary small">{t('common.go')}</button>
                        </form>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(currentPage + 1)}
                          disabled={currentPage >= Math.ceil(totalBooksCount / PAGE_SIZE)}
                        >{t('library.page.next')}</button>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE)))}
                          disabled={currentPage >= Math.ceil(totalBooksCount / PAGE_SIZE)}
                          title={t('library.page.lastTitle')}
                        >{t('library.page.last')}</button>
                      </div>
                    </>
                  )}
                </div>
                  </div> {/* /library-main */}
                </div> {/* /library-layout */}
              </>
            )}

            {/* ═══ LOANS TAB ═══ */}
            {currentSection === 'circulation' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('loans.title')}</h2>
                    <p>{t('loans.description')}</p>
                  </div>
                </div>

                {/* Readers. Lives in Circulation rather than Settings because it
                    is desk work — and because the category set here is what the
                    loan rules resolve on. */}
                <BorrowersCard canWrite={canSeeCirculation} canAdmin={isAdmin || can('setup')} />

                {/* Scan — the desk's fastest path to a copy. A handheld scanner
                    types the code and presses Enter, so this is the whole UI. */}
                <div className="card">
                  <h3>{t('scan.heading')}</h3>
                  <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('scan.intro')}</p>
                  <form onSubmit={(e) => void resolveScanCode(e)} className="search-bar" style={{ alignItems: 'flex-end' }}>
                    <div className="filter-field" style={{ flex: '1 1 18rem' }}>
                      <label htmlFor="scan-input">{t('scan.heading')}</label>
                      <input
                        id="scan-input"
                        value={scanCode}
                        onChange={(e) => setScanCode(e.target.value)}
                        placeholder={t('scan.placeholder')}
                        autoComplete="off"
                        // A scanner emits the whole string in milliseconds; the
                        // browser's autocorrect and spellcheck only get in the way.
                        spellCheck={false}
                      />
                    </div>
                    <div className="search-actions">
                      <span aria-hidden="true" className="field-spacer" />
                      <button type="submit" className="primary">{t('scan.go')}</button>
                    </div>
                  </form>
                  {scanHit && (
                    <div className="merge-preview" style={{ marginTop: '0.75rem' }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>{scanResult}</p>
                      <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
                        {scanHit.item
                          ? <>{t('scan.copyN', { n: scanHit.item.copyNumber ?? 1 })}{scanHit.item.shelfCode ? ` · ${scanHit.item.shelfCode}` : ''}</>
                          : t('scan.copiesN', { n: scanHit.items.length })}
                      </p>
                      {scanHit.openLoan && (
                        <p className="small" style={{ margin: '0.25rem 0 0', color: 'var(--warning)' }}>
                          {t('scan.onLoanTo', {
                            name: scanHit.openLoan.borrower_name,
                            date: new Date(scanHit.openLoan.due_at).toLocaleDateString()
                          })}
                        </p>
                      )}
                      <div className="button-group" style={{ marginTop: '0.5rem' }}>
                        <button className="secondary small" onClick={() => { void openBookDetailById(scanHit.book.id); }}>
                          {t('scan.openBook')}
                        </button>
                        {scanHit.openLoan ? (
                          <button className="primary small" onClick={() => void quickReturnByBookId(
                            scanHit.book.id,
                            displayTitle(scanHit.book, t('common.untitled')),
                            scanHit.openLoan!.id
                          )}>{t('loans.return')}</button>
                        ) : (
                          <button className="primary small" onClick={() => { setSelectedBook(scanHit.book); setScanHit(null); }}>
                            {t('detail.borrowBtn')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Loan stats */}
                <div className="stats-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <div className="stat-box accent">
                    <span className="stat-box-label">{t('loans.activeKpi')}</span>
                    <span className="stat-box-value">{activeBorrows.length}</span>
                  </div>
                  <div className="stat-box danger">
                    <span className="stat-box-label">{t('library.overdue')}</span>
                    <span className="stat-box-value">{overdueCount}</span>
                  </div>
                  <div className="stat-box warning">
                    <span className="stat-box-label">{t('loans.dueSoon')}</span>
                    <span className="stat-box-value">{dueSoonCount}</span>
                  </div>
                </div>

                {/* Active Loans list */}
                <div className="card">
                  <h3>{t('loans.activeHeading', { n: activeBorrows.length })}</h3>
                  {activeBorrows.length === 0 ? (
                    <div className="empty-state" style={{ padding: '1.5rem 0 0.5rem' }}>
                      <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>✅</p>
                      <p style={{ fontWeight: 600 }}>{t('loans.allClear')}</p>
                      <p className="muted small">{t('loans.allClearBody')}</p>
                    </div>
                  ) : (
                    <div className="loan-list">
                      {activeBorrows.map((loan) => (
                        <div key={loan.id} className={`loan-item${loan.isOverdue ? ' overdue' : ''}`} onContextMenu={(e) => openContextMenu(e, buildLoanMenu(loan), displayTitle({ title: loan.title }, t('common.untitled')))}>
                          <div className="loan-item-info">
                            <strong>{displayTitle({ title: loan.title }, t('common.untitled'))}</strong>
                            <p className="meta">
                              {t('loans.borrowedBy', { name: loan.borrowerName })}
                              {loan.borrowerContact ? ` · ${loan.borrowerContact}` : ''}
                            </p>
                            <p className="meta">
                              {t('loans.due', { date: new Date(loan.dueAt).toLocaleDateString() })}
                              {loan.isOverdue && <span className="overdue-tag"> · {t('loans.overdueTag')}</span>}
                              {/* WHICH copy. With several out at once, the row has
                                  to say which one is coming back. */}
                              {loan.copyNumber != null && (
                                <span className="muted"> · {t('loans.copyN', { n: loan.copyNumber })}{loan.shelfCode ? ` · ${loan.shelfCode}` : ''}</span>
                              )}
                              {(loan.renewalCount ?? 0) > 0 && (
                                <span className="muted"> · {t('loans.renewedN', { n: loan.renewalCount ?? 0 })}</span>
                              )}
                            </p>
                          </div>
                          <div className="button-group">
                            <button className="secondary small" onClick={() => void renewLoan(loan)}>
                              {t('loans.renew')}
                            </button>
                            <button className="secondary small" onClick={() => void quickReturnByBookId(loan.bookId, displayTitle({ title: loan.title }, t('common.untitled')), loan.id)}>
                              {t('loans.return')}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* The hold shelf — copies waiting behind the desk, and the queue */}
                {holds.length > 0 && (
                  <div className="card">
                    <h3>{t('holds.heading', { n: holds.length })}</h3>
                    <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('holds.intro')}</p>
                    <div className="loan-list">
                      {holds.map((h) => (
                        <div key={h.id} className={`loan-item${h.status === 'ready' ? ' is-ready' : ''}`}>
                          <div className="loan-item-info">
                            <strong>{displayTitle({ title: h.title ?? '' }, t('common.untitled'))}</strong>
                            <p className="meta">{t('holds.forReader', { name: h.borrowerName })}</p>
                            <p className="meta">
                              {h.status === 'ready'
                                ? <>
                                    <span className="badge ready">{t('holds.ready')}</span>
                                    {h.shelfCode ? ` · ${h.shelfCode}` : ''}
                                    {h.expiresAt ? ` · ${t('holds.until', { date: new Date(h.expiresAt).toLocaleDateString() })}` : ''}
                                  </>
                                : t('holds.waitingSince', { date: new Date(h.placedAt).toLocaleDateString() })}
                            </p>
                          </div>
                          <button className="secondary small" onClick={() => void cancelHold(h)}>
                            {t('holds.cancel')}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Borrow Form */}
                <div className="card">
                  <h3>{t('loans.borrowHeading')}</h3>
                  {selectedBook ? (
                    <form onSubmit={(e) => { e.preventDefault(); void borrowBook(selectedBook); }} className="simple-form">
                      <div style={{ padding: '0.875rem 1rem', background: 'var(--accent-light)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--accent)', marginBottom: '0.25rem' }}>
                        <p style={{ fontWeight: 600 }}>{displayTitle(selectedBook, t('common.untitled'))}</p>
                        <p className="muted small">{displayAuthor(selectedBook, t('common.unknownAuthor'))}</p>
                      </div>
                      <div className="form-row">
                        <Combobox<Borrower>
                          idPrefix="borrower"
                          label={<>{t('loans.borrower')} *</>}
                          value={borrowerQuery || borrowerName}
                          onChange={(v) => {
                            setBorrowerQuery(v);
                            setBorrowerName(v);
                            setSelectedBorrowerId('');
                            if (v.trim().length >= 2) scheduleBorrowerSearch(v);
                            else setBorrowerSuggestions([]);
                          }}
                          onFocus={() => { if (!borrowerSuggestions.length) void searchBorrowers(borrowerQuery); }}
                          onPick={applyBorrowerSuggestion}
                          items={borrowerSuggestions}
                          // Once a borrower is locked in, the list stays hidden
                          // until the operator edits the name again.
                          suppressed={Boolean(selectedBorrowerId)}
                          getKey={(b) => b.id}
                          renderItem={(b) => (
                            <>
                              <span className="combo-name">{b.name}</span>
                              {b.contact && <span className="combo-contact muted small">{b.contact}</span>}
                              <span className="combo-stats muted small">
                                {t(b.totalLoans === 1 ? 'loans.suggestionLoanCount' : 'loans.suggestionLoanCountPlural', { n: fmt(b.totalLoans) })}
                                {b.overdueLoans > 0 && <span className="overdue-tag"> · {t('loans.suggestionOverdue', { n: fmt(b.overdueLoans) })}</span>}
                              </span>
                            </>
                          )}
                          placeholder={t('loans.borrowerPh')}
                          required
                          footer={selectedBorrowerId ? (
                            <p className="muted small">
                              {t('loans.borrowerProfile')}{' '}
                              <button
                                type="button"
                                className="link-btn"
                                style={{ color: 'var(--accent)' }}
                                onClick={() => { setSelectedBorrowerId(''); setBorrowerName(''); setBorrowerContact(''); }}
                              >{t('loans.change')}</button>
                            </p>
                          ) : null}
                        />
                        <div>
                          <label htmlFor="fld-loans-contact">{t('loans.contact', { optional: t('common.optional') })}</label>
                          <input id="fld-loans-contact"
                            value={borrowerContact}
                            onChange={(e) => setBorrowerContact(e.target.value)}
                            placeholder={t('loans.contactPh')}
                            disabled={Boolean(selectedBorrowerId)}
                          />
                        </div>
                      </div>
                      <div className="form-field">
                        <label htmlFor="loan-due-date">{t('loans.dueDate')}</label>
                        <input
                          id="loan-due-date"
                          type="date"
                          value={isoToLocalDateInput(dueAt)}
                          onChange={(e) => setDueAt(e.target.value ? endOfLocalDayIso(e.target.value) : '')}
                          aria-describedby="loan-due-hint"
                        />
                        {/* No longer required. Blank means "apply the library's
                            rule", which is now the normal case; typing a date is
                            an override the librarian is entitled to make. */}
                        <p id="loan-due-hint" className="muted small" style={{ marginTop: '0.35rem' }}>
                          {dueAt ? t('loans.dueOverride') : t('loans.duePolicy')}
                        </p>
                        <div className="button-group" style={{ marginTop: '0.5rem' }}>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(7)}>{t('loans.in7')}</button>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(14)}>{t('loans.in14')}</button>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(30)}>{t('loans.in30')}</button>
                          {dueAt && (
                            <button type="button" className="secondary small" onClick={() => setDueAt('')}>{t('loans.useRule')}</button>
                          )}
                        </div>
                      </div>
                      <div className="button-group">
                        <button type="submit" className="primary">{t('loans.confirmBorrow')}</button>
                        <button type="button" className="secondary" onClick={() => setSelectedBook(null)}>{t('common.cancel')}</button>
                      </div>
                    </form>
                  ) : (
                    <div className="empty-state" style={{ padding: '1.5rem 0 0.5rem' }}>
                      <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>📖</p>
                      <p style={{ fontWeight: 600 }}>{t('loans.noBookSelected')}</p>
                      <p className="muted small">{t('loans.noBookBody')} <strong>{t('detail.borrowBtn')}</strong>.</p>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ═══ IMPORT TAB ═══ */}
            {currentSection === 'handbook' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('handbook.title')}</h2>
                    <p>{t('handbook.description')}</p>
                  </div>
                  <div className="section-header-actions">
                    <button className="secondary small" onClick={() => window.print()}>
                      {t('handbook.print')}
                    </button>
                  </div>
                </div>
                <div className="card hb-card">
                  <Suspense fallback={<p className="muted">{t('common.loading')}</p>}>
                    <HandbookView mode="page" />
                    {/* Printing one chapter is almost never what someone wants
                        from a handbook, so paper gets all of them. Hidden on
                        screen, shown by the print stylesheet. */}
                    <div className="hb-print-only">
                      <HandbookPrintable />
                    </div>
                  </Suspense>
                </div>
              </>
            )}

            {currentSection === 'import' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('import.title')}</h2>
                    <p>{t('import.description')}</p>
                  </div>
                </div>

                <div className="card">
                  <h3>{t('import.heading')}</h3>
                  <p className="muted" style={{ marginBottom: '1.25rem', fontSize: '0.875rem' }}>
                    {t('import.intro')}
                  </p>
                  <form onSubmit={importFromXlsx} className="simple-form">
                    <div className="import-dropzone">
                      <p style={{ fontSize: '2.25rem', marginBottom: '0.5rem' }}>📂</p>
                      <p id="import-xlsx-label" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{t('import.choose')}</p>
                      <p className="muted small" style={{ marginBottom: '1rem' }}>{t('import.supports')}</p>
                      {/* The instruction above is a <p>, associated with nothing, so
                          this control announced only as "Choose File, button" — and
                          the MARCXML importer further down the page announced
                          identically. Two indistinguishable controls, both of which
                          overwrite catalogue records (SC 4.1.2, SC 3.3.2). The
                          paragraph is the visible label, so point at it rather than
                          inventing a second wording to keep in step with it. */}
                      <input
                        name="xlsxFile"
                        type="file"
                        accept=".xlsx,.csv"
                        required
                        aria-labelledby="import-xlsx-label"
                        style={{ width: 'auto', display: 'block', margin: '0 auto' }}
                      />
                    </div>
                    {importFileName && (
                      <p className="muted small">{t('import.selected')} <strong>{importFileName}</strong></p>
                    )}
                    <label className="checkbox-label">
                      <input type="checkbox" checked={importDryRun} onChange={(e) => setImportDryRun(e.target.checked)} />
                      {t('import.dryRun')}
                    </label>
                    {/* Disabled in flight like every other submit in the app: an import is the
                        longest write here, so it is the one where a second Enter is most
                        likely and most expensive. */}
                    <button type="submit" className="primary" disabled={isWorking}>
                      {isWorking ? t('common.saving') : importDryRun ? t('import.testBtn') : t('import.importBtn')}
                    </button>
                  </form>
                </div>

                {canExportCsv && (
                  <div className="card">
                    <h3>{t('import.exportHeading')}</h3>
                    <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                      {t('import.exportIntro')}
                    </p>
                    <button className="secondary" onClick={exportCsv}>{t('import.downloadCsv')}</button>
                  </div>
                )}

                {/* The spreadsheet above is the everyday route; this is the one
                    for talking to another library. */}
                <MarcIoCard canExport={canExportCsv} canImport={canImport} />

                <div className="card">
                  <h3>{t('import.setupHeading')}</h3>
                  <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                    {t('import.setupIntro')}
                  </p>
                  <div className="button-group" style={{ marginTop: 0 }}>
                    <button className="primary" onClick={() => void setupLibraryCatalog()}>
                      {t('import.setupCatalog')}
                    </button>
                    <button className="secondary" onClick={applyDefaultBookStructure}>
                      {t('import.setupLegacy')}
                    </button>
                  </div>
                  <p className="muted small" style={{ marginTop: '0.75rem' }}>
                    {t('import.setupNote', { n: CATALOG_FIELD_COUNT })}
                  </p>
                </div>
              </>
            )}

            {/* ═══ MAINTAINANCE TAB ═══ */}
            {currentSection === 'settings' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('settings.title')}</h2>
                    <p>{t('settings.description')}</p>
                  </div>
                </div>

                {/* Training / Start guide — replay the onboarding course anytime */}
                <LibraryIdentityCard canEdit={isAdmin} />

                <RoomsCard
                  canWrite={can('rooms.write')}
                  canDelete={can('rooms.delete')}
                  onChanged={() => { void loadRoomSummary(); void loadBooks(); }}
                />

                {canDelete && (
                  <TrashCard canDelete={canDelete} onChanged={() => { void loadBooks(); void loadRoomSummary(); }} />
                )}

                {/* Custom field manager */}
                <div className="card">
                  <h3>{t('settings.customAttrs', { n: customFields.length })}</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    {t('settings.customIntro')}
                  </p>

                  {customFields.length > 0 && (
                    <div className="cf-list">
                      {/* Two groups, in the same order every attribute list uses:
                          the everyday fields first, then the rest. */}
                      {pinnedCustomFields.length > 0 && (
                        <p className="cf-group-heading">
                          ★ {t('settings.pinnedGroup', { n: pinnedCustomFields.length })}
                        </p>
                      )}
                      {[...pinnedCustomFields, ...unpinnedCustomFields].map((f, index) => {
                        const isFirstUnpinned =
                          !f.pinned && index === pinnedCustomFields.length && pinnedCustomFields.length > 0;
                        return (
                          <Fragment key={f.id}>
                            {isFirstUnpinned && (
                              <p className="cf-group-heading">{t('settings.otherGroup', { n: unpinnedCustomFields.length })}</p>
                            )}
                            <div className={f.pinned ? 'cf-row cf-row-pinned' : 'cf-row'}>
                              <div className="cf-row-text">
                                <strong>{f.pinned ? '★ ' : ''}{f.label}</strong>
                                <span className="muted small">
                                  <code>{f.key}</code> · {f.type}{f.required ? ` ${t('settings.requiredSuffix')}` : ''}
                                  {f.type === 'enum' && f.enumOptions.length > 0 ? ` ${t('settings.optionsSuffix', { n: f.enumOptions.length })}` : ''}
                                </span>
                              </div>
                              {canManageCustomFields && (
                                <div className="cf-row-actions">
                                  {/* One click to pin/unpin — editing the whole
                                      definition just to move a field to the top
                                      is more ceremony than the action deserves. */}
                                  <button
                                    className={f.pinned ? 'secondary small cf-pin-on' : 'secondary small'}
                                    onClick={() => void toggleCustomFieldPin(f)}
                                    title={f.pinned ? t('settings.unpinTitle') : t('settings.pinTitle')}
                                    // Content wins over `title` in the accessible-name
                                    // computation, so the name was the star glyph.
                                    aria-label={f.pinned ? t('settings.cf.unpin') : t('settings.cf.pin')}
                                    aria-pressed={f.pinned}
                                  ><span aria-hidden="true">{f.pinned ? '★' : '☆'}</span></button>
                                  {f.pinned && (
                                    <>
                                      <button
                                        className="secondary small"
                                        onClick={() => void moveCustomField(f, -1)}
                                        title={t('settings.moveUp')}
                                        aria-label={t('settings.moveUp')}
                                      >↑</button>
                                      <button
                                        className="secondary small"
                                        onClick={() => void moveCustomField(f, 1)}
                                        title={t('settings.moveDown')}
                                        aria-label={t('settings.moveDown')}
                                      >↓</button>
                                    </>
                                  )}
                                  <button className="secondary small" onClick={() => beginCustomFieldEdit(f)}>{t('common.edit')}</button>
                                  <button className="danger small" onClick={() => void deleteCustomField(f)}>{t('common.delete')}</button>
                                </div>
                              )}
                            </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  )}

                  {canManageCustomFields && (
                    <details className="custom-fields-section" open={Boolean(editingCustomFieldId)} style={{ marginTop: '1rem' }}>
                      <summary>{editingCustomFieldId ? t('settings.editAttr') : t('settings.addAttr')}</summary>
                      <form onSubmit={saveCustomField} className="simple-form" style={{ marginTop: '0.75rem' }}>
                        <div className="form-row">
                          <div>
                            <label htmlFor="fld-settings-attrkey">{t('settings.attrKey')}</label>
                            <input id="fld-settings-attrkey"
                              value={fieldForm.key}
                              onChange={(e) => setFieldForm({ ...fieldForm, key: e.target.value })}
                              placeholder={t('settings.attrKeyPh')}
                              required
                            />
                          </div>
                          <div>
                            <label htmlFor="fld-settings-attrlabel">{t('settings.attrLabel')}</label>
                            <input id="fld-settings-attrlabel"
                              value={fieldForm.label}
                              onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })}
                              placeholder={t('settings.attrLabelPh')}
                              required
                            />
                          </div>
                        </div>
                        <div className="form-row">
                          <div>
                            <label htmlFor="fld-settings-attrtype">{t('settings.attrType')}</label>
                            <select id="fld-settings-attrtype"
                              value={fieldForm.type}
                              onChange={(e) => setFieldForm({ ...fieldForm, type: e.target.value as CustomField['type'] })}
                            >
                              <option value="text">{t('settings.attrType.text')}</option>
                              <option value="number">{t('settings.attrType.number')}</option>
                              <option value="boolean">{t('settings.attrType.boolean')}</option>
                              <option value="date">{t('settings.attrType.date')}</option>
                              <option value="enum">{t('settings.attrType.enum')}</option>
                            </select>
                          </div>
                          <div>
                            <label htmlFor="fld-settings-attrrequired">{t('settings.attrRequired')}</label>
                            <select id="fld-settings-attrrequired"
                              value={fieldForm.required ? 'yes' : 'no'}
                              onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.value === 'yes' })}
                            >
                              <option value="no">{t('common.no')}</option>
                              <option value="yes">{t('common.yes')}</option>
                            </select>
                          </div>
                        </div>
                        {fieldForm.type === 'enum' && (
                          <div className="form-field">
                            <label htmlFor="fld-settings-attrenumoptions">{t('settings.attrEnumOptions')}</label>
                            <input id="fld-settings-attrenumoptions"
                              value={fieldForm.enumOptionsCsv}
                              onChange={(e) => setFieldForm({ ...fieldForm, enumOptionsCsv: e.target.value })}
                              placeholder={t('settings.attrEnumPh')}
                            />
                          </div>
                        )}
                        <div className="button-group">
                          <button type="submit" className="primary" disabled={isWorking}>{isWorking ? t('common.saving') : editingCustomFieldId ? t('settings.attrSave') : t('settings.attrAdd')}</button>
                          {editingCustomFieldId && (
                            <button type="button" className="secondary" onClick={resetCustomFieldForm}>{t('common.cancel')}</button>
                          )}
                        </div>
                      </form>
                    </details>
                  )}
                </div>

                {/* Duplicate checker */}
                <div className="card">
                  <h3>{t('settings.dupHeading')}</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    {t('settings.dupIntro')}
                  </p>
                  <button className="secondary" onClick={() => void checkDuplicates()}>{t('settings.dupScan')}</button>
                </div>

                {showDuplicatesPanel && duplicateGroups.length > 0 && (
                  <div className="card" style={{ borderLeft: '3px solid var(--warning)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <strong>{t('settings.dupGroupsFound', { n: duplicateGroups.length, s: duplicateGroups.length !== 1 ? 's' : '' })}</strong>
                      <button className="secondary small" onClick={() => setShowDuplicatesPanel(false)}>{t('common.close')}</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {duplicateGroups.map((group, i) => (
                        <div key={i} style={{ background: 'var(--surface-2)', borderRadius: '6px', padding: '0.75rem' }}>
                          <p style={{ margin: '0 0 0.4rem', fontWeight: 600, fontSize: '0.875rem' }}>
                            "{displayTitle(group[0], t('common.untitled'))}" — {displayAuthor(group[0], t('common.unknownAuthor'))}
                          </p>
                          <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            {group.map((entry) => (
                              <li key={entry.id}>
                                {t('settings.dupId')} {entry.id.slice(0, 8)}…{entry.isbn ? ` | ${t('settings.dupIsbn')} ${entry.isbn}` : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* User management (admin-only) */}
                {isAdmin && (
                  <div className="card">
                    <h3>{t('users.title')}</h3>
                    <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('users.description')}</p>

                    {staffUsersLoading && staffUsers.length === 0 ? (
                      <p className="muted small">{t('common.loading')}</p>
                    ) : staffUsers.length === 0 ? (
                      <p className="muted small">{t('users.empty')}</p>
                    ) : (
                      <div className="cf-list">
                        {staffUsers.map((u) => {
                          const isSelf = u.id === currentUser?.id;
                          const isEditing = editingUserId === u.id;
                          return (
                            <div key={u.id} className="cf-row" style={{ flexWrap: 'wrap' }}>
                              <div className="cf-row-text">
                                <strong>{u.username}{isSelf ? ` (${t('users.you')})` : ''}</strong>
                                <span className="muted small">
                                  {u.active === 1 ? t('users.active') : t('users.inactive')}
                                  {' · '}{new Date(u.created_at).toLocaleDateString()}
                                </span>
                                <button
                                  type="button"
                                  className="uuid-copy muted small"
                                  title={t('users.uuidCopy')}
                                  onClick={() => {
                                    void navigator.clipboard?.writeText(u.id);
                                    toast.push('success', t('users.uuidCopied'));
                                  }}
                                >
                                  {t('users.uuid')}: {u.id}
                                </button>
                              </div>
                              <div className="cf-row-actions" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <select
                                  value={u.role}
                                  onChange={(e) => void updateStaffUserRole(u, e.target.value as StaffRole)}
                                  disabled={isSelf}
                                  aria-label={t('users.role')}
                                >
                                  <option value="admin">{t('users.role.admin')}</option>
                                  <option value="librarian">{t('users.role.librarian')}</option>
                                  <option value="viewer">{t('users.role.viewer')}</option>
                                </select>
                                <button
                                  className="secondary small"
                                  onClick={() => void toggleStaffUserActive(u)}
                                  disabled={isSelf}
                                >
                                  {u.active === 1 ? t('users.deactivate') : t('users.activate')}
                                </button>
                                <button
                                  className="secondary small"
                                  onClick={() => {
                                    setEditingUserId(isEditing ? null : u.id);
                                    setEditUserPassword('');
                                  }}
                                >{isEditing ? t('common.cancel') : t('users.resetPassword')}</button>
                                <button
                                  className="danger small"
                                  onClick={() => void deleteStaffUser(u)}
                                  disabled={isSelf}
                                  title={isSelf ? t('users.cannotDeleteSelf') : undefined}
                                >{t('common.delete')}</button>
                              </div>
                              {isEditing && (
                                <form
                                  style={{ flex: '1 1 100%', display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}
                                  onSubmit={(e) => { e.preventDefault(); void resetStaffUserPassword(u); }}
                                >
                                  <input
                                    type="password"
                                    placeholder={t('users.newPasswordPh')}
                                    value={editUserPassword}
                                    onChange={(e) => setEditUserPassword(e.target.value)}
                                    autoComplete="new-password"
                                    minLength={8}
                                    required
                                    style={{ flex: 1 }}
                                  />
                                  <button type="submit" className="primary small">{t('users.savePassword')}</button>
                                </form>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <details className="custom-fields-section" style={{ marginTop: '1rem' }}>
                      <summary>{t('users.add')}</summary>
                      <form onSubmit={createStaffUser} className="simple-form" style={{ marginTop: '0.75rem' }}>
                        <div className="form-row">
                          <div>
                            <label htmlFor="fld-users-username-2">{t('users.username')} *</label>
                            <input id="fld-users-username-2"
                              value={newUserUsername}
                              onChange={(e) => setNewUserUsername(e.target.value)}
                              autoComplete="off"
                              minLength={3}
                              required
                            />
                          </div>
                          <div>
                            <label htmlFor="fld-users-password">{t('users.password')} *</label>
                            <input id="fld-users-password"
                              type="password"
                              value={newUserPassword}
                              onChange={(e) => setNewUserPassword(e.target.value)}
                              autoComplete="new-password"
                              minLength={8}
                              required
                            />
                          </div>
                          <div>
                            <label htmlFor="fld-users-role">{t('users.role')} *</label>
                            <select id="fld-users-role" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as StaffRole)}>
                              <option value="admin">{t('users.role.admin')}</option>
                              <option value="librarian">{t('users.role.librarian')}</option>
                              <option value="viewer">{t('users.role.viewer')}</option>
                            </select>
                          </div>
                        </div>
                        <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('users.passwordHint')}</p>
                        <button type="submit" className="primary small" style={{ marginTop: '0.5rem' }} disabled={isWorking}>{isWorking ? t('common.saving') : t('users.create')}</button>
                      </form>
                    </details>
                  </div>
                )}

                {/* Roles & permissions matrix (admin-only) */}
                {isAdmin && (
                  <div className="card">
                    <h3>{t('roles.title')}</h3>
                    <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('roles.description')}</p>
                    {!permissionMatrix ? (
                      <button
                        className="secondary small"
                        onClick={() => void loadPermissionMatrix()}
                        disabled={permissionMatrixLoading}
                      >
                        {permissionMatrixLoading ? t('common.loading') : t('roles.load')}
                      </button>
                    ) : (
                      <>
                        <div style={{ overflowX: 'auto' }}>
                          <table className="perm-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                            <thead>
                              <tr>
                                <th scope="col" style={{ textAlign: 'left', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('roles.permission')}</th>
                                <th scope="col" style={{ textAlign: 'center', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('users.role.admin')}</th>
                                <th scope="col" style={{ textAlign: 'center', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('users.role.librarian')}</th>
                                <th scope="col" style={{ textAlign: 'center', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('users.role.viewer')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {permissionMatrix.catalog.map((perm) => (
                                <tr key={perm}>
                                  {/* A row HEADER, not a cell: without it the
                                      checkboxes have no header association at
                                      all and announce as "checkbox, checked". */}
                                  <th scope="row" style={{ textAlign: 'left', fontWeight: 400, padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
                                    <strong>{t(`perm.${perm}` as never)}</strong>
                                    <div className="muted small">{t(`perm.${perm}.desc` as never)}</div>
                                  </th>
                                  <td style={{ textAlign: 'center', padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }} title={t('roles.adminLocked')}>
                                    <input type="checkbox" checked disabled aria-label={`${t(`perm.${perm}` as never)} — ${t('users.role.admin')}`} />
                                  </td>
                                  <td style={{ textAlign: 'center', padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
                                    <input
                                      type="checkbox"
                                      aria-label={`${t(`perm.${perm}` as never)} — ${t('users.role.librarian')}`}
                                      checked={Boolean(permissionMatrix.matrix.librarian[perm])}
                                      onChange={() => togglePermissionCell('librarian', perm)}
                                    />
                                  </td>
                                  <td style={{ textAlign: 'center', padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
                                    <input
                                      type="checkbox"
                                      aria-label={`${t(`perm.${perm}` as never)} — ${t('users.role.viewer')}`}
                                      checked={Boolean(permissionMatrix.matrix.viewer[perm])}
                                      onChange={() => togglePermissionCell('viewer', perm)}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('roles.adminLocked')}</p>
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                          <button
                            className="primary small"
                            onClick={() => void savePermissionMatrix()}
                            disabled={permissionMatrixSaving}
                          >
                            {permissionMatrixSaving ? t('common.loading') : t('roles.save')}
                          </button>
                          <button
                            className="secondary small"
                            onClick={() => void loadPermissionMatrix()}
                            disabled={permissionMatrixSaving}
                          >
                            {t('roles.reload')}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Audit log */}
                {currentUser?.role === 'admin' && (
                  <div className="card">
                    <h3>{t('settings.auditHeading')}</h3>
                    {auditItems.length === 0 ? (
                      <p className="muted small">{t('settings.auditEmpty')}</p>
                    ) : (
                      <div className="audit-list">
                        {auditItems.map((entry) => (
                          <div key={entry.id} className="audit-row">
                            <code className="audit-action">{entry.action}</code>
                            <span className="muted small">{entry.entity_type}{entry.entity_id ? `:${String(entry.entity_id).slice(0, 8)}…` : ''}</span>
                            <span className="muted small audit-time">{new Date(entry.created_at).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Maintenance tools */}
                {currentUser?.role === 'admin' && (
                  <div className="card">
                    <h3>{t('settings.normHeading')}</h3>
                    <p className="muted small" style={{ marginBottom: '1rem' }}>
                      {t('settings.normIntro')}
                    </p>
                    <button className="secondary" onClick={() => void normalizeAllBooks()}>{t('settings.normRun')}</button>
                    <p className="muted small" style={{ margin: '1.25rem 0 1rem' }}>
                      {t('settings.searchIndexIntro')}
                    </p>
                    <button className="secondary" onClick={() => void rebuildSearchIndex()}>{t('settings.searchIndexRun')}</button>
                    <p className="muted small" style={{ margin: '1.25rem 0 1rem' }}>
                      {t('barcodes.intro')}
                    </p>
                    <button className="secondary" disabled={barcodeBusy} onClick={() => void assignBarcodes()}>
                      {barcodeBusy ? t('barcodes.working') : t('barcodes.assign')}
                    </button>
                  </div>
                )}

                {/* Loan rules: how long, how many, how often — decided once */}
                {isAdmin && (
                  <div className="card">
                    <h3>{t('policies.heading')}</h3>
                    <p className="muted small" style={{ marginBottom: '1rem' }}>{t('policies.intro')}</p>
                    {!policiesLoaded ? (
                      <button className="secondary" onClick={() => void loadLoanPolicies()}>{t('policies.load')}</button>
                    ) : (
                      <>
                        <div style={{ overflowX: 'auto' }}>
                          <table className="merge-table">
                            <thead>
                              <tr>
                                <th scope="col">{t('policies.category')}</th>
                                <th scope="col">{t('policies.itemType')}</th>
                                <th scope="col">{t('policies.loanDays')}</th>
                                <th scope="col">{t('policies.renewalLimit')}</th>
                                <th scope="col">{t('policies.maxLoans')}</th>
                                <th scope="col">{t('policies.lendable')}</th>
                                <th scope="col"><span className="sr-only">{t('common.remove')}</span></th>
                              </tr>
                            </thead>
                            <tbody>
                              {loanPolicies.map((p, i) => {
                                const isDefault = p.borrowerCategory === '*' && p.itemType === '*';
                                const upd = (patch: Partial<LoanPolicy>) =>
                                  setLoanPolicies((prev) => prev.map((q, j) => (j === i ? { ...q, ...patch } : q)));
                                return (
                                  <tr key={i}>
                                    <td>
                                      <input
                                        value={p.borrowerCategory}
                                        list="policy-categories"
                                        aria-label={t('policies.categoryFor', { n: i + 1 })}
                                        disabled={isDefault}
                                        onChange={(e) => upd({ borrowerCategory: e.target.value })}
                                      />
                                    </td>
                                    <td>
                                      <select
                                        value={p.itemType}
                                        aria-label={t('policies.itemTypeFor', { n: i + 1 })}
                                        disabled={isDefault}
                                        onChange={(e) => upd({ itemType: e.target.value })}
                                      >
                                        <option value="*">{t('policies.anyType')}</option>
                                        {policyItemTypes.map((it) => <option key={it} value={it}>{t(`itemType.${it}`)}</option>)}
                                      </select>
                                    </td>
                                    <td>
                                      <input type="number" min={1} max={365} value={p.loanDays}
                                        aria-label={t('policies.loanDaysFor', { n: i + 1 })}
                                        onChange={(e) => upd({ loanDays: Number(e.target.value) || 1 })} />
                                    </td>
                                    <td>
                                      <input type="number" min={0} max={20} value={p.renewalLimit}
                                        aria-label={t('policies.renewalLimitFor', { n: i + 1 })}
                                        onChange={(e) => upd({ renewalLimit: Number(e.target.value) || 0 })} />
                                    </td>
                                    <td>
                                      <input type="number" min={1} max={1000} value={p.maxConcurrentLoans ?? ''}
                                        placeholder={t('policies.unlimited')}
                                        aria-label={t('policies.maxLoansFor', { n: i + 1 })}
                                        onChange={(e) => upd({ maxConcurrentLoans: e.target.value ? Number(e.target.value) : null })} />
                                    </td>
                                    <td>
                                      <input type="checkbox" checked={p.lendable}
                                        aria-label={t('policies.lendableFor', { n: i + 1 })}
                                        onChange={(e) => upd({ lendable: e.target.checked })} />
                                    </td>
                                    <td>
                                      {!isDefault && (
                                        <button type="button" className="secondary small"
                                          onClick={() => setLoanPolicies((prev) => prev.filter((_, j) => j !== i))}
                                        >{t('common.remove')}</button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <datalist id="policy-categories">
                            {policyCategories.map((cat) => <option key={cat} value={cat} />)}
                          </datalist>
                        </div>
                        <div className="button-group" style={{ marginTop: '0.75rem' }}>
                          <button className="secondary small" onClick={() => setLoanPolicies((prev) => [...prev, {
                            borrowerCategory: 'standard', itemType: 'book', loanDays: 14,
                            renewalLimit: 2, renewalDays: null, maxConcurrentLoans: null, lendable: true
                          }])}>{t('policies.addRule')}</button>
                          <button className="primary small" onClick={() => void saveLoanPolicies()}>{t('policies.save')}</button>
                        </div>
                        <p className="muted small" style={{ marginTop: '0.6rem' }}>{t('policies.note')}</p>
                      </>
                    )}
                  </div>
                )}

                {canWrite && (
                  <AuthoritiesCard canWrite={canWrite} onChanged={() => { void loadBooks(); }} />
                )}

                {/* Value consistency: consolidate the librarians' spelling variants */}
                {canWrite && (
                  <div className="card">
                    <h3>{t('settings.vc.heading')}</h3>
                    <p className="muted small" style={{ marginBottom: '0.5rem' }}>{t('settings.vc.intro')}</p>
                    {/* This tool REWRITES; authority control POINTS. Two answers to
                        one librarian problem, and neither knew the other existed. */}
                    <p className="muted small callout" style={{ marginBottom: '1rem' }}>
                      {t('settings.vc.vsAuthorities')}
                    </p>
                    <div className="search-bar" style={{ alignItems: 'flex-end' }}>
                      <div className="filter-field">
                        <label htmlFor="fld-settings-vc-field">{t('settings.vc.field')}</label>
                        <select id="fld-settings-vc-field"
                          value={variantField}
                          onChange={(e) => { setVariantField(e.target.value as VariantField); setVariantsScanned(false); setValueVariants([]); }}
                        >
                          <option value="publisher">{t('library.add.publisher')}</option>
                          <option value="author">{t('library.add.author')}</option>
                          <option value="language">{t('library.add.language')}</option>
                          <option value="shelfCode">{t('library.add.shelf')}</option>
                          <option value="title">{t('library.add.bookTitle')}</option>
                        </select>
                      </div>
                      <div className="search-actions">
                        <span aria-hidden="true" className="field-spacer" />
                        <button className="secondary" disabled={variantsLoading} onClick={() => void loadValueVariants(variantField)}>
                          {variantsLoading ? t('settings.vc.scanning') : t('settings.vc.scan')}
                        </button>
                      </div>
                    </div>
                    {variantsScanned && !variantsLoading && (
                      valueVariants.length === 0 ? (
                        <p className="muted small" style={{ marginTop: '0.75rem' }}>{t('settings.vc.none')}</p>
                      ) : (
                        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                          <p className="muted small">{t('settings.vc.foundNote', { n: valueVariants.length })}</p>
                          {valueVariants.map((g) => (
                            <VariantGroupCard
                              key={g.canonical + g.total}
                              group={g}
                              mergeLabel={t('settings.vc.merge')}
                              keepLabel={t('settings.vc.useAsCanonical')}
                              onMerge={(canon) => void consolidateVariantGroup(variantField, g, canon)}
                            />
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )}

                {/* Duplicate records → one record, many copies */}
                {canWrite && (
                  <div className="card">
                    <h3>{t('settings.merge.heading')}</h3>
                    <p className="muted small" style={{ marginBottom: '1rem' }}>{t('settings.merge.intro')}</p>
                    <div className="search-bar" style={{ alignItems: 'flex-end' }}>
                      <div className="filter-field">
                        <label htmlFor="fld-settings-merge-match">{t('settings.merge.match')}</label>
                        <select id="fld-settings-merge-match"
                          value={mergeStrict ? 'strict' : 'loose'}
                          onChange={(e) => { setMergeStrict(e.target.value === 'strict'); setMergeScanned(false); setMergeGroups([]); }}
                        >
                          <option value="strict">{t('settings.merge.matchStrict')}</option>
                          <option value="loose">{t('settings.merge.matchLoose')}</option>
                        </select>
                      </div>
                      <div className="filter-field">
                        <label htmlFor="fld-settings-merge-filter">{t('settings.merge.filter')}</label>
                        <input id="fld-settings-merge-filter"
                          value={mergeQuery}
                          placeholder={t('settings.merge.filterHint')}
                          onChange={(e) => { setMergeQuery(e.target.value); setMergeScanned(false); }}
                        />
                      </div>
                      <div className="search-actions">
                        <span aria-hidden="true" className="field-spacer" />
                        <button className="secondary" disabled={mergeLoading} onClick={() => void loadMergeCandidates(mergeStrict)}>
                          {mergeLoading ? t('settings.vc.scanning') : t('settings.vc.scan')}
                        </button>
                      </div>
                    </div>
                    {mergeScanned && !mergeLoading && (
                      mergeGroups.length === 0 ? (
                        <p className="muted small" style={{ marginTop: '0.75rem' }}>{t('settings.merge.none')}</p>
                      ) : (
                        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                          <p className="muted small">{t('settings.merge.foundNote', { n: mergeTotal, shown: mergeGroups.length })}</p>
                          {mergeGroups.map((g) => (
                            <MergeGroupCard
                              key={g.key}
                              group={g}
                              t={t}
                              onPreview={previewMerge}
                              onMerge={performMerge}
                            />
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )}

                {/* System info */}
                <div className="card">
                  <h3>{t('settings.system')}</h3>
                  <ul className="system-info">
                    <li><span>{t('settings.system.api')}</span><code>{API_BASE}</code></li>
                    <li><span>{t('settings.system.user')}</span><code>{currentUser?.username} ({currentUser?.role})</code></li>
                    <li><span>{t('settings.system.books')}</span><code>{fmt(totalBooksCount)}</code></li>
                    <li><span>{t('settings.system.fields')}</span><code>{customFields.length}</code></li>
                    <li><span>{t('settings.system.theme')}</span><code>{theme}</code></li>
                    <li><span>{t('settings.system.lang')}</span><code>{lang}</code></li>
                  </ul>
                </div>
              </>
            )}

          </main>
        </>
      )}

      {isWorking && (
        <div className="working-pill" role="status" aria-live="polite">
          <span className="spinner" /> {t('app.working')}
        </div>
      )}
    </div>
  );
}

/**
 * The "?" drawer.
 *
 * A separate container from the Handbook tab for one reason: it has to be able to
 * open OVER the edit-book dialog. Switching to the Handbook tab instead would
 * unmount the form and lose everything typed into it, which is exactly what the
 * librarian was consulting the Handbook in order to finish.
 *
 * It reuses `Dialog`'s focus trap and, more importantly, its focus RESTORE — when
 * the drawer closes, focus returns to the "?" the librarian pressed, which is next
 * to the field they were filling in.
 */
function HandbookDrawer() {
  const t = useT();
  const { drawerOpen, close } = useHandbook();
  if (!drawerOpen) return null;
  return (
    /*
     * ALWAYS STACKED. Every "?" in this app sits inside a form, and most of those forms are
     * inside a dialog — the record editor, the copies editor, the add-book panel. Without this
     * the drawer rendered at the base overlay z-index, i.e. BEHIND the dialog the librarian
     * pressed "?" in: the page dimmed, the answer was underneath, and there was nothing to
     * click. Reported from the desk.
     *
     * Unconditional rather than conditional on "is a dialog open", because the drawer is the
     * innermost thing on screen whenever it is open — it is opened FROM whatever is already
     * there — and a z-index that depends on state is a z-index that will be wrong once.
     */
    <Dialog stacked onClose={close} labelledBy="hb-drawer-title" className="modal hb-drawer">
      <div className="modal-header">
        <h3 id="hb-drawer-title">📖 {t('handbook.title')}</h3>
        <button className="icon-button" onClick={close} aria-label={t('common.close')}>✕</button>
      </div>
      <Suspense fallback={<p className="muted">{t('common.loading')}</p>}>
        <HandbookView mode="drawer" />
      </Suspense>
    </Dialog>
  );
}

function Root() {
  return (
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          {/* Inside the i18n provider (it picks the language pack) and outside
              App, so a "?" six components deep inside the edit dialog can open
              the Handbook without a single prop being drilled. */}
          <HandbookProvider>
            <App />
          </HandbookProvider>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
