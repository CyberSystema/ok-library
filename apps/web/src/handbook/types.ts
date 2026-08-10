// The Handbook's content model.
//
// One union, rendered by one component. Everything the prose can do is a `Block`,
// so a chapter is data rather than markup and the same chapter renders in the
// full-page reader, in the "?" drawer, and on paper without being written twice.
//
// Carried over from `onboarding.tsx`: `p`, `tip`, `rule`, `steps`. What is new is
// that `text` is a plain string. The course held a `Loc` — every string in all
// four languages side by side — which is right at 56 KB and catastrophic at the
// Handbook's size: it welds the languages into one chunk, so a Greek reader would
// download the Korean handbook to read a Greek page. One pack per language
// instead, with English as the fallback.
import type { AnchorId, ChapterId } from './registry';
import type { FieldFactKey } from './facts';

export type Block =
  /** Ordinary prose. */
  | { kind: 'p'; text: string }
  /** A practical aside — worth knowing, not required. */
  | { kind: 'tip'; text: string }
  /** A rule of cataloguing. Few of these; they carry weight. */
  | { kind: 'rule'; text: string }
  /** An ordered how-to. */
  | { kind: 'steps'; items: string[] }
  /** An unordered list. */
  | { kind: 'list'; items: string[] }
  /**
   * An anchored sub-heading. The anchor is what a "?" link and a cross-reference
   * point at, so it is typed: a dead link is a compile error rather than
   * something a librarian discovers.
   */
  | { kind: 'h'; text: string; anchor: AnchorId }
  /**
   * A table of catalogue fields. Rows join to `FIELD_FACTS` for the MARC tag and
   * the internal field name, so a tag is written once in the whole Handbook and
   * cannot drift between four translations.
   */
  | { kind: 'fields'; rows: Array<{ fact: FieldFactKey; note: string }> }
  /** A right-and-wrong pair. The strongest teaching device the course had. */
  | { kind: 'compare'; good: string; bad: string; why: string }
  /** What the system does on its own, so nobody does it by hand. */
  | { kind: 'auto'; text: string }
  /** A typed cross-reference to another chapter, optionally to an anchor. */
  | { kind: 'see'; chapter: ChapterId; anchor?: AnchorId; text: string }
  /** A real record, quoted from this catalogue. */
  | { kind: 'quote'; text: string; source: string };

export type Chapter = {
  id: ChapterId;
  title: string;
  /** One sentence, shown in the contents list and as the page's lead. */
  summary: string;
  blocks: Block[];
};

/** One language's chapters, keyed by id. A pack may be partial; English is the fallback. */
export type ContentPack = Partial<Record<ChapterId, Chapter>>;
