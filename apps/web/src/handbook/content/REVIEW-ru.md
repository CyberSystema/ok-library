# Russian Handbook — terms flagged for review

All thirty-one chapters are in Russian. The review pass caught eighteen problems
and the clear-cut ones are fixed; what remains below is where I would rather ask
than guess, because getting Russian bibliographic terminology subtly wrong is the
kind of error a librarian notices and I would not.

Korean is not written yet — it falls back to English chapter by chapter, so the
Handbook is complete in every language a reader can select.

---

## Fixed without asking — the pack contradicted itself

These were not judgement calls. In each case the Russian used one word for two
different things, or two words for one thing, *within the same pack*:

| what | was | now |
|---|---|---|
| a periodical's **run** vs a multi-part **set** | `комплект` for both, in three chapters | `комплект выпусков` for the run, `многотомник` for the set |
| two **publications** | `два экземпляра` — the reserved word for a physical copy | `два разных издания` |
| **retiring a heading** vs **withdrawing a copy** | `изъятие` for both | heading: `вывести из употребления`; copy stays `списание` |
| **call number** vs **shelf mark**, one line apart in the glossary | `шифр хранения` given as the *exported* one | `шифр хранения` is the local one, as Russian usage has it; the exported one is `классификационный индекс` |
| **withdrawal**, standing alone in the glossary | `Исключение` — reads first as "exception" | `Списание` |

The run/set collision is the same failure the Greek pass found, where `σειρά`
served for both *series* and *run* and the instruction came out backwards. It is
apparently the single most likely way this Handbook gets mistranslated.

---

## ⚑ Three I would rather you settled

### 1. "printing" / "impression" — currently `тираж`

Used in four places, e.g. *«он часто самый быстрый способ различить два тиража»*
for "the quickest way to tell two printings apart".

The reviewer's objection is that in Russian bibliographic usage `тираж` is the
**number of copies printed**, not a distinguishable printing of an edition. I did
not change it because every alternative I can think of has its own problem —
`переиздание` means a new edition, which is precisely what the chapter says a
reprint is *not*, and `завод` is printing-trade vocabulary a librarian would not
expect.

What phrase does a Russian catalogue use for "this is the 1987 printing of the
1955 edition"?

### 2. "title" as a counting unit — `название` vs `заглавие`

The statistics chapter counts *«названий и томов в фонде»*, while the titles and
series chapters call a title `заглавие`. Both are defensible — `название` is the
natural counting noun and `заглавие` the cataloguing term — but it is two words
for a concept the glossary otherwise pins down. Keep the split, or unify?

### 3. "room" — `помещение`

The chapter fixes on `помещение` throughout, matching the interface. Flagging it
only because the reviewer noted the chapter also reaches for `зал` and
`хранилище` in passing prose; those are now consistent, but if the library calls
its spaces something else, that is the word to use.

---

## Also worth knowing

**Register.** Russian follows the same register as the approved Greek: precise, a
little dry, plural imperative, no idiom. Two colloquialisms were removed.

**Numbers** are carried across with Russian spacing — `12 500`, not `12,500`.

**Greek stays Greek.** Quoted catalogue values — `ΑΡΧΙΜ. ΝΙΚΟΔΗΜΟΥ Γ. ΑΕΡΑΚΗ`,
`<<Ο ΣΩΤΗΡ>>`, `Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ` — are left in Greek script in the Russian pack,
because they are quoted as evidence of what is in this catalogue. A Russian reader
who cannot read them still learns the point being made about them.

**Standard names stay Latin**: MARC 21, ISBD, Dublin Core, EDTF, ISO 843, SRU,
OAI-PMH, Code 128. A MARC tag *with its subfield* never appears in the prose —
those live in `facts.ts` once, and the build fails if one is copied into a pack.
The bare `880` in the transliteration chapter is the deliberate exception, and the
build check holds it to `facts.ts` and to the other three packs rather than
ignoring it.

**Field labels in the tables stay English, and the pack cannot change it.** A
`fields` row is `{ fact, note }` — the pack owns the note and nothing else — so
the Russian reader sees `Publisher`, `Kind of publication` and `Shelf mark`
beside a form that says Издатель, Вид издания, Полочный индекс. Core fields only:
a custom attribute's label is stored in the database and rendered as stored, so
`Edition` is English on the Russian screen too. Until the renderer takes a
translation key, name the field in Russian **inside the note**, which is the part
of the row this pack does own.
