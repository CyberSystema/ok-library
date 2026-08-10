// The librarian's course — the first-run guide, and the only mandatory screen.
//
// This file used to hold 56 KB of its own prose: eleven chapters, every string in
// four languages side by side. That prose was written before the standards work
// and had gone quietly wrong. It had no idea copies existed, so it taught
// re-cataloguing a duplicate as a new record — the exact habit that produced the
// duplicates the merge tool now exists to clean up. It taught hand-typed due dates
// that the loan-policy engine replaced. And a librarian who read it carefully was
// worse off than one who had not.
//
// So the prose is gone and the course is now a CURATED SEQUENCE of Handbook
// chapters. One corpus, one renderer, one set of facts. A correction to the
// Handbook is a correction to the course, and the two can no longer drift into
// saying different things about the same field — which, with a reference and a
// tutorial covering the same ground, they eventually would.
//
// What stays here is the frame, and the frame is what makes it a course rather
// than a document: a welcome, a fixed order, visible progress, and an end. The
// warmth lives in those, in the four languages the interface already speaks.
import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n, useT, type Lang } from './i18n';
import type { ChapterId } from './handbook/registry';

const HandbookChapter = lazy(() =>
  import('./handbook').then((m) => ({ default: m.HandbookChapter }))
);

/**
 * The curriculum: eight Handbook chapters in the order a new librarian needs them.
 *
 * Why → how to be consistent → the names this collection is actually made of →
 * how a field is transcribed → dates, which are the first thing that looks hard →
 * the physical copies → how to find anything → what the week's work is.
 *
 * Deliberately not all thirty-one. A mandatory course that takes an afternoon
 * gets skimmed; the rest of the Handbook is there to be consulted, and the last
 * chapter of the course says so.
 */
export const COURSE_CHAPTERS: readonly ChapterId[] = [
  'what-a-catalogue-is-for',
  'consistency',
  'names',
  'titles',
  'dates',
  'copies-and-shelves',
  'searching',
  'daily-work'
];

export function OnboardingCourse({ mandatory, onFinish, onClose }: {
  mandatory?: boolean;
  onFinish: () => void;
  onClose?: () => void;
}) {
  const t = useT();
  const { lang, setLang } = useI18n();
  // Step 0 is the welcome; then one step per chapter; then the closing step.
  const [step, setStep] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const total = COURSE_CHAPTERS.length + 2;
  const isWelcome = step === 0;
  const isEnd = step === total - 1;
  const chapterIndex = step - 1;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  useLayoutEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [step]);

  /**
   * Finishing ALWAYS records completion, whether this is the first run or a
   * replay.
   *
   * It used to be `mandatory ? onFinish() : (onClose ?? onFinish)()`. A replay
   * always passes `onClose`, so pressing Finish on a replay closed the dialog and
   * never recorded anything — the librarian had read the course to the end and the
   * system did not know. It also meant a version bump could not be acknowledged by
   * anyone who reached the course voluntarily.
   */
  function finish() {
    onFinish();
    if (!mandatory) onClose?.();
  }

  return (
    <div className="ob-overlay" role="dialog" aria-modal="true" aria-label={t('course.title')}>
      <div className="ob-panel">
        <header className="ob-header">
          <div className="ob-header-title">
            <span className="ob-logo">📚</span>
            <div>
              <strong>{t('course.title')}</strong>
              <span className="ob-progress-text">
                {isWelcome ? t('course.welcomeStep')
                  : isEnd ? t('course.endStep')
                    : t('course.chapterOf', { n: chapterIndex + 1, total: COURSE_CHAPTERS.length })}
              </span>
            </div>
          </div>
          <div className="ob-header-right">
            {/* The language switcher stays in the header. A librarian who cannot
                read the course cannot consent to having read it. */}
            <label className="ob-lang" title={t('course.language')}>
              <span aria-hidden="true">🌐</span>
              <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('course.language')}>
                <option value="en">English</option>
                <option value="el">Ελληνικά</option>
                <option value="ru">Русский</option>
                <option value="ko">한국어</option>
              </select>
            </label>
            {!mandatory && onClose && (
              <button className="ob-x" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}>✕</button>
            )}
          </div>
        </header>

        <div className="ob-progress-bar">
          <div className="ob-progress-fill" style={{ width: `${((step + 1) / total) * 100}%` }} />
        </div>

        <div className="ob-main">
          <nav className="ob-toc" aria-label={t('handbook.contents')}>
            <div className="ob-toc-title">{t('handbook.contents')}</div>
            <ol>
              {COURSE_CHAPTERS.map((id, i) => (
                <li key={id}>
                  <button
                    className={`ob-toc-item${i === chapterIndex ? ' is-active' : ''}${i < chapterIndex ? ' is-done' : ''}`}
                    aria-current={i === chapterIndex ? 'true' : undefined}
                    onClick={() => setStep(i + 1)}
                  >
                    {/* Decorative: the ordinal is already carried by the <ol>, and a
                        bare "✓" in the accessible name reads as "check mark". The
                        active/done state travels on aria-current instead. */}
                    <span className="ob-toc-icon" aria-hidden="true">{i < chapterIndex ? '✓' : i + 1}</span>
                    <span className="ob-toc-label">{t(`course.chapter.${id}`)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <div className="ob-body" ref={bodyRef}>
            {isWelcome ? (
              <div className="ob-welcome">
                <div className="ob-chapter-icon">📚</div>
                <h2 className="ob-chapter-title">{t('course.welcomeTitle')}</h2>
                <p className="ob-lead">{t('course.welcomeLead')}</p>
                <p className="hb-p">{t('course.welcomeBody')}</p>
                <p className="hb-p">{t('course.welcomeTime', { n: COURSE_CHAPTERS.length })}</p>
              </div>
            ) : isEnd ? (
              <div className="ob-welcome">
                <div className="ob-chapter-icon">✓</div>
                <h2 className="ob-chapter-title">{t('course.endTitle')}</h2>
                <p className="ob-lead">{t('course.endLead')}</p>
                <p className="hb-p">{t('course.endHandbook')}</p>
                <p className="hb-p">{t('course.endReplay')}</p>
              </div>
            ) : (
              // The splash matters: the Handbook prose is a lazily-loaded chunk, so
              // on a first run the course would otherwise show an empty panel while
              // it arrives — on the one screen a librarian cannot get past.
              <Suspense fallback={<p className="muted">{t('common.loading')}</p>}>
                <HandbookChapter id={COURSE_CHAPTERS[chapterIndex]} />
              </Suspense>
            )}
          </div>
        </div>

        <footer className="ob-footer">
          {mandatory && <span className="ob-mandatory-note">{t('course.mandatoryNote')}</span>}
          <div className="ob-footer-actions">
            <button className="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              {t('course.back')}
            </button>
            {isEnd ? (
              <button className="primary" onClick={finish}>{t('course.finish')}</button>
            ) : (
              <button className="primary" onClick={() => setStep((s) => Math.min(total - 1, s + 1))}>
                {isWelcome ? t('course.begin') : t('course.next')}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
