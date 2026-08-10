// One renderer, two containers.
//
// The same chapter has to appear in a full-page reader, inside a drawer opened by
// a "?" next to a form field, and on paper. Writing it three times would guarantee
// three different answers, so `Blocks` renders the union and the containers only
// decide where it sits.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FIELD_FACTS } from './facts';
import { CHAPTER_ORDER, chapterForAnchor, type AnchorId, type ChapterId } from './registry';
import type { Block, Chapter } from './types';
import { useT } from '../i18n';
import { useHandbook } from './context';

function Blocks({ blocks, onNavigate }: {
  blocks: Block[];
  onNavigate: (chapter: ChapterId, anchor?: AnchorId) => void;
}) {
  const t = useT();
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'p':
            return <p key={i} className="hb-p">{b.text}</p>;
          case 'h':
            // The anchor is the id, so a link to it works in the page container and
            // scroll-into-view works in the drawer.
            return (
              <h3 key={i} id={`hb-${b.anchor}`} className="hb-h">
                {b.text}
              </h3>
            );
          case 'tip':
            return (
              <div key={i} className="hb-callout hb-tip">
                <span className="hb-callout-label">💡 {t('handbook.tip')}</span>{b.text}
              </div>
            );
          case 'rule':
            return (
              <div key={i} className="hb-callout hb-rule">
                <span className="hb-callout-label">⭐ {t('handbook.rule')}</span>{b.text}
              </div>
            );
          case 'auto':
            return (
              <div key={i} className="hb-callout hb-auto">
                <span className="hb-callout-label">⚙ {t('handbook.auto')}</span>{b.text}
              </div>
            );
          case 'steps':
            return <ol key={i} className="hb-steps">{b.items.map((s, j) => <li key={j}>{s}</li>)}</ol>;
          case 'list':
            return <ul key={i} className="hb-list">{b.items.map((s, j) => <li key={j}>{s}</li>)}</ul>;
          case 'compare':
            return (
              <div key={i} className="hb-compare">
                <div className="hb-compare-row hb-good">
                  <span className="hb-compare-label">✓ {t('handbook.good')}</span>
                  <span>{b.good}</span>
                </div>
                <div className="hb-compare-row hb-bad">
                  <span className="hb-compare-label">✗ {t('handbook.bad')}</span>
                  <span>{b.bad}</span>
                </div>
                <p className="hb-compare-why">{b.why}</p>
              </div>
            );
          case 'quote':
            return (
              <figure key={i} className="hb-quote">
                <blockquote>{b.text}</blockquote>
                <figcaption>{b.source}</figcaption>
              </figure>
            );
          case 'fields':
            return (
              // Wide content scrolls inside its own box rather than pushing the
              // page sideways — the same rule the rest of the app follows.
              <div key={i} className="hb-fields-wrap">
                <table className="hb-fields">
                  <thead>
                    <tr>
                      <th scope="col">{t('handbook.field')}</th>
                      <th scope="col">MARC 21</th>
                      <th scope="col">{t('handbook.note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row) => {
                      const fact = FIELD_FACTS[row.fact];
                      return (
                        <tr key={row.fact}>
                          <th scope="row">
                            {fact.label}
                            <code className="hb-fieldkey">{fact.field}</code>
                          </th>
                          <td><code>{fact.marc ?? '—'}</code></td>
                          <td>{row.note}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          case 'see':
            return (
              <p key={i} className="hb-see">
                <button className="link-button" onClick={() => onNavigate(b.chapter, b.anchor)}>
                  → {b.text}
                </button>
              </p>
            );
          default: {
            // Exhaustiveness: a new block kind is a compile error here rather than
            // silently rendering nothing.
            const never: never = b;
            return never;
          }
        }
      })}
    </>
  );
}

/** Load the pack for a language, falling back to English per chapter. */
function useChapters(): { chapters: Chapter[]; loading: boolean } {
  const { pack, fallback, loading, ensure } = useHandbook();
  // The pack is fetched on first use rather than at startup, and "first use"
  // includes simply opening the Handbook tab — not only pressing a "?".
  useEffect(() => { ensure(); }, [ensure]);
  // Chapter by chapter, not pack by pack. A translation in progress shows the
  // translated chapters in the reader's language and the rest in English, which
  // is the only useful behaviour: the alternative is a blank page for a chapter
  // nobody has got to yet.
  const chapters = useMemo(
    () => CHAPTER_ORDER
      .map((id) => pack?.[id] ?? fallback?.[id])
      .filter((c): c is Chapter => Boolean(c)),
    [pack, fallback]
  );
  return { chapters, loading };
}

export function Handbook({ mode }: { mode: 'page' | 'drawer' }) {
  const t = useT();
  const { chapters, loading } = useChapters();
  const { target, openAt } = useHandbook();
  const [current, setCurrent] = useState<ChapterId>(CHAPTER_ORDER[0]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // A "?" names an ANCHOR, never a chapter — so reorganising the Handbook cannot
  // break a form. The chapter is looked up from the anchor.
  useEffect(() => {
    if (!target) return;
    setCurrent(target.anchor ? chapterForAnchor(target.anchor) : target.chapter ?? CHAPTER_ORDER[0]);
  }, [target]);

  // Scroll to the anchor once the chapter it lives in has rendered.
  useEffect(() => {
    if (!target?.anchor || loading) return;
    const el = bodyRef.current?.querySelector(`#hb-${target.anchor}`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' });
    else bodyRef.current?.scrollTo({ top: 0 });
  }, [target, current, loading, chapters]);

  const chapter = chapters.find((c) => c.id === current) ?? chapters[0];

  return (
    <div className={mode === 'drawer' ? 'hb hb-drawer-body' : 'hb hb-page'}>
      <nav className="hb-contents" aria-label={t('handbook.contents')}>
        <ol>
          {CHAPTER_ORDER.map((id, index) => {
            const c = chapters.find((x) => x.id === id);
            return (
              <li key={id}>
                <button
                  className={`hb-contents-link${id === current ? ' is-active' : ''}`}
                  aria-current={id === current ? 'true' : undefined}
                  onClick={() => openAt({ chapter: id })}
                >
                  <span className="hb-contents-n">{index + 1}</span>
                  {c ? c.title : id}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="hb-body" ref={bodyRef}>
        {loading && !chapter ? (
          <p className="muted">{t('common.loading')}</p>
        ) : !chapter ? (
          <p className="muted">{t('handbook.notWritten')}</p>
        ) : (
          <article>
            <h2 className="hb-title">{chapter.title}</h2>
            <p className="hb-summary">{chapter.summary}</p>
            <Blocks
              blocks={chapter.blocks}
              onNavigate={(c, a) => openAt({ chapter: c, anchor: a })}
            />
            <div className="hb-chapter-nav">
              {CHAPTER_ORDER.indexOf(current) > 0 && (
                <button
                  className="secondary small"
                  onClick={() => openAt({ chapter: CHAPTER_ORDER[CHAPTER_ORDER.indexOf(current) - 1] })}
                >
                  ← {chapters.find((x) => x.id === CHAPTER_ORDER[CHAPTER_ORDER.indexOf(current) - 1])?.title}
                </button>
              )}
              {CHAPTER_ORDER.indexOf(current) < CHAPTER_ORDER.length - 1 && (
                <button
                  className="secondary small"
                  onClick={() => openAt({ chapter: CHAPTER_ORDER[CHAPTER_ORDER.indexOf(current) + 1] })}
                >
                  {chapters.find((x) => x.id === CHAPTER_ORDER[CHAPTER_ORDER.indexOf(current) + 1])?.title} →
                </button>
              )}
            </div>
          </article>
        )}
      </div>
    </div>
  );
}

/** The whole Handbook, for printing. Every chapter, no navigation. */
export function HandbookPrintable() {
  const { chapters } = useChapters();
  return (
    <div className="hb hb-print-all">
      {chapters.map((c) => (
        <article key={c.id} className="hb-print-chapter">
          <h2 className="hb-title">{c.title}</h2>
          <p className="hb-summary">{c.summary}</p>
          <Blocks blocks={c.blocks} onNavigate={() => { /* no navigation on paper */ }} />
        </article>
      ))}
    </div>
  );
}
