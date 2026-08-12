# Korean Handbook — for review before deploy

All thirty-one chapters are in Korean. The Handbook is now complete in every
language the interface offers.

**Nothing here is deployed.** This is committed so the terminology can be read in
place and annotated, as the Greek and Russian packs were.

---

## The method changed, because the same thing broke twice

Greek and Russian were each written first and reviewed second, and each shipped a
draft containing a **concept collision** — one word doing two jobs, in a sentence
that read perfectly and instructed the opposite:

- Greek used `σειρά` for both a publisher's *series* and a periodical's *run*, so
  "record its run" told the librarian to record the series.
- Russian did the identical thing with `комплект`.
- Greek used one verb for a reader *collecting* a hold and the library *taking a
  volume back*, and `διαγραφή` for both *erasing* a reader's personal data and
  *deleting* the reader — in the chapter that exists to distinguish them.

None of that is visible to a compiler, to a fluent reader of one language, or to
the block-structure checks: the prose is grammatical and the structure is intact.

So for Korean the vocabulary was settled **before any prose was written** — three
independent proposals (one grounded in 『한국목록규칙 제4판』 and KORMARC, one in what
a working Korean library's staff interface actually says, one working backwards
from the collision list), reconciled into a single glossary of 116 terms that all
thirty-one chapters were then written against. Each chapter was afterwards read by
three separate reviewers with non-overlapping briefs: collisions, fidelity of
instruction, and whether it reads like a Korean library manual rather than
translated English.

**The collisions are now a build check.** `check_handbook.mjs` asserts per chapter
which words must appear and which must not — `총서` cannot appear in the
periodical-runs chapter, `소장권호` cannot appear in the series chapter, `제적` and
`폐지` cannot cross, `삭제` can never take `개인정보` as its object. Each of the eight
rules was confirmed to fail when the corresponding collision is injected. The
Greek and Russian failures could not ship today.

---

## ⚑ Three decisions I would rather you settled

Each is used consistently throughout, so changing one is a single find-and-replace.

### 1. `표제` for title, and `서명` banned outright

This is the one Korean-specific landmine, and it is worse than the Greek and
Russian equivalents. **`서명` is the standard KORMARC word for *title* — and also
the everyday word for a *signature*.** This catalogue has both: a `Signed Copy`
field and a `Signature Notes` field, discussed in the same chapter as titles.

So `서명` is banned from the pack entirely. Title is `표제` (본표제 · 부제 ·
대등표제 · 표제면); signature is `자필` (「저자 자필」, 「자필 관련 주기」). The cost is
that a KORMARC-trained reader meets a word KORMARC does not use in its field
captions, and the glossary says so out loud rather than hiding it.

Note that **the interface itself currently commits this collision** — `서명`
appears in five Korean UI strings meaning *title*. See the sweep below.

### 2. `서가실` for room

This is the system's own coinage, not standard Korean library vocabulary. No rooms
are defined yet — all 12,528 copies are unassigned — so nothing depends on it. If
the monastery calls its spaces `자료실` or `서고`, that word should win for the
label, with `소장처` kept for the concept.

### 3. `면장수` for extent

Right register, and it covers `권책수` where `쪽수` cannot, but only moderate
confidence that it is the exact KORMARC subfield wording. `형태사항` is the
alternative. A real value is shown beside it on first use in each chapter either
way.

---

## A finding that is not about the Handbook: the Korean interface

The glossary work was checked against `apps/web/src/i18n.tsx`, and two generations
of Korean translation coexist there. The newer `copies.*`, `serials.*` and
`authorities.*` strings are careful (`소장본`, `소장 범위`, `결호`, `채택형`, `제적`,
`청구기호`). The older ones are not, and one error is systematic:

> **`사본` is used 38 times to mean a physical copy the library owns.**
> `사본` means a *photocopy* or *reproduction*.

`library.copies.hint` reads 「실물 사본」 — "physical photocopy". `library.copies.nth`
renders "Copy 1" as 「사본 1」. 「보유 사본 (3)」 tells a Korean librarian this library
holds *three photocopies* of the book. The 39th use, in `identity.shareOnBody` (a
harvester keeping its own copy), is the one that is correct.

Alongside it, four smaller collisions the Handbook now contradicts:

| key | says today | should say | why |
|---|---|---|---|
| `borrowers.erase` | 「개인정보 삭제」 | 「개인정보 파기」 | the data-protection chapter's whole argument is that 삭제 and 파기 are different acts |
| `authorities.retire` | 「폐기」 | 「폐지」 | 폐기 would serve as both *retire a heading* and *withdraw a copy* |
| `trash.purgeBody` / `trash.intro` | 파기 | 영구 삭제 | reserves 파기 for the statutory sense |
| `serials.heading` | 「소장 범위」 | 「소장권호」 | matches the exported 866 line |

**The Handbook is coherent as it stands** — where it quotes a screen label it
quotes the label as it reads *today*, in 「 」, so the manual never sends the
librarian to a button that does not exist. But the pack and a sweep of the Korean
dictionary want to land together, and the sweep is a change to what 40-odd screens
say in Korean, so it is your call rather than mine. I have not touched it.

---

## Korean settles a question Russian left open

`REVIEW-ru.md` asks what a Russian catalogue calls "the 1987 printing of the 1955
edition", because `тираж` means the *number of copies printed* rather than a
distinguishable printing. Korean has exact words for all three, printed on every
Korean copyright page:

| concept | Korean |
|---|---|
| edition | `판` — 초판, 재판, 제2판, 개정판 |
| printing, impression | `쇄` — 제3쇄 |
| print run size | `발행 부수` |

So 「1955년 초판의 1987년 3쇄」 is ordinary Korean. This suggests the Russian problem
is a missing *phrase* rather than a missing word: `тираж` is the `발행 부수` concept,
and the printing sense needs saying another way.

---

## Register

`합니다체` for statements, `하십시오체` for instructions — the same formality as the
approved Greek and Russian, and deliberately drier than the interface, which uses
`해요체` for buttons and toasts. Where the Handbook quotes a button verbatim it
carries the screen's `하세요` into a `하십시오` page; that is intended, because a
quoted label is evidence of what the screen says.

Quotation marks are split three ways and used consistently: `“ ”` for stored
catalogue values and literal strings the librarian types, `「 」` for interface
objects, `『 』` for a cited publication or standard. `« »` is *not* used, because
the catalogue's own data contains `« »` and `<<>>` that must stay distinguishable
from the Handbook's own punctuation.

Numbers keep the comma as thousands separator (`12,528`), take no space before a
counter (`12,528종`, `3쇄`, `21cm`), and always state their unit — `건 · 종 · 책 ·
권 · 명 · 호`. Exact counts stay exact: `12,528`, never `12,500`.

---

## Three corrections to the English

The Korean pass read the English closely enough to find real errors in it, and
they are fixed in all four languages:

1. **`transliteration`** said "Three fields on the record hold the romanized
   reading". The table beneath it has four rows, of which **two** are romanized —
   the other two are the Greek forms shown for contrast. Now: "Two fields on the
   record hold the romanized reading — one for the title, one for the author."
2. **`sharing`** said "Only bibliographic data is ever served." Holdings go out
   too: verified against `/api/books/:id/marc`, which emits `852` with the room,
   shelf mark, call number, barcode and copy number, and SRU and OAI-PMH build
   their records with the same function. A librarian deciding whether to open
   sharing could have read the old sentence as "not my shelf marks". Now it names
   what goes out, and still says readers, loans, holds and staff accounts do not.
3. **`series-and-sets`** gave two labelled volumes as an example and called them
   "three unnumbered volumes". Now two.

A fourth report — that the same `sharing` chapter used "holdings" loosely two
blocks later — was investigated and **rejected**: holdings genuinely are served,
so the word was right and the `auto` block above it was the wrong half.

---

## What was not translated, and why

**Quoted catalogue values stay exactly as stored**, in Greek script and upper
case, including the `<<>>` the spreadsheet import made of Greek quotation marks.
`ΑΡΧΙΜ. ΝΙΚΟΔΗΜΟΥ Γ. ΑΕΡΑΚΗ`, `ΑΔΕΛΦΟΤΗΣ ΘΕΟΛΟΓΩΝ <<Ο ΣΩΤΗΡ>>`,
`ΜΕΓΑΛΗ ΕΛΛΗΝΙΚΗ ΕΓΚΥΚΛΟΠΑΙΔΕΙΑ`. They are quoted as evidence of what is in this
catalogue, so tidying them would remove the point; the Korean gloss goes beside
them, never instead of them.

**Standard names stay in Latin script**: MARC 21, KORMARC, KCR4, ISBD, Dublin
Core, EDTF, ISO 843, ISO 2789, ISO 15511, SRU, OAI-PMH, Code 128, DDC.

**A MARC tag with its subfield is not in the prose at all** — those live in
`facts.ts`, once, untranslated, and the build fails if one appears in any content
pack. A *bare* tag is the deliberate exception: `880` stands in the
transliteration chapter of every pack, because it is the token a librarian quotes
to a partner library, and 표시기호 is in the glossary for exactly that moment. The
build check covers it rather than ignoring it — the tag must still be declared in
`facts.ts`, and every pack must name it as often as the English does, so no
translation can quietly drop it as the Greek one did.

**Field labels in the tables are in English, and no pack can change that.** A
`fields` row is `{ fact, note }`, so a pack translates the note and nothing else,
and the renderer prints `FIELD_FACTS.label` raw: the Korean reader sees
`Kind of publication` where the screen says 자료 유형, and `Shelf mark` where the
screen says 「서가 기호」 (spaced, as §Numbers-and-spacing notes the interface does).
`facts.ts` used to describe the label as "translated per pack", which no mechanism
has ever done; that comment is corrected.

Core fields only: a custom attribute's label is stored in
`custom_field_definitions` and rendered as stored, so `Editor` and `Volume Number`
are English on the Korean screen as well. Those rows already match the screen —
in the wrong language, which is a different problem from this one.

The decision, until a `labelKey` and a `t()` in the renderer make it moot: the
columns this table exists FOR — the API field key and the MARC tag — are
identifiers and language-independent, and the label is a gloss. The translator's
job meanwhile is to name the field in Korean **inside the note**, the one part of
the row a pack owns, so the reader meets 자료 유형 in the third column even when
the first is in English.
