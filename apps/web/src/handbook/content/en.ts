// The Handbook, in English.
//
// This is the reference half of the librarian's guide: precise, addressable, and
// meant to be consulted rather than read through. The course is the other half —
// warm, sequential, mandatory once — and it will be rebuilt on this same renderer.
//
// Every example here is a real record from this catalogue, with its real counts.
// An invented example teaches an invented library.
//
// LAZY: this file is only ever reached through `CONTENT_LOADERS` in the registry.
// Importing it statically anywhere would put the whole Handbook in the main bundle,
// which `scripts/check_handbook.mjs` exists to prevent.
import type { ContentPack } from '../types';

const pack: ContentPack = {
  'what-a-catalogue-is-for': {
    id: 'what-a-catalogue-is-for',
    title: 'What a catalogue is for',
    summary:
      'A catalogue is not a list of books. It is a set of promises about where they are and what they are.',
    blocks: [
      { kind: 'p', text:
        'This library holds about 12,700 records. A shelf list would tell you that much. What a catalogue adds is that every one of those records answers the same questions in the same way, so a question asked once can be answered for the whole collection: what do we hold by this author, is this the edition we already have, which volume of this set is missing, where is our second copy.' },
      { kind: 'p', text:
        'Everything in this Handbook follows from that. A field is worth filling when it makes one of those answers possible, and worth filling *the same way every time* for the same reason. A field filled inconsistently is often worse than a field left empty, because an empty field is visibly empty and an inconsistent one looks answered.' },

      { kind: 'h', text: 'A record is not a copy', anchor: 'record-vs-copy' },
      { kind: 'p', text:
        'The single most important distinction in this system, and the one that saves the most work. A *record* describes a publication: its title, its author, the year it was printed. A *copy* is a physical object on a shelf: it has a shelf mark, a barcode, a condition, and it is either here or on loan.' },
      { kind: 'p', text:
        'One record can have many copies. When the library owns the same book twice — one on the front shelf, one in the back room — that is one record with two copies, never two records. Cataloguing it twice means every later correction has to be made twice, and one of the two will be missed.' },
      { kind: 'compare', good:
        'One record for “Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ”, with copy 1 on shelf 15-003 and copy 2 in the back room.',
        bad: 'Two records for “Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ”, one per shelf.',
        why: 'The second way splits the loan history, doubles every correction, and makes “how many do we hold?” unanswerable. Use Copies on the record instead.' },
      { kind: 'auto', text:
        'Every record gets one copy automatically when it is created, so nothing is ever invisible to a shelf search. Add the second copy from the Copies panel on the record.' },
      { kind: 'see', chapter: 'consistency', anchor: 'consolidate-or-authority', text:
        'If the two records already exist, the merge tool folds one into the other as a second copy.' },

      { kind: 'h', text: 'Why bother with standards', anchor: 'why-standards' },
      { kind: 'p', text:
        'Because a catalogue that only this library can read is a catalogue that dies with its software. The standards below let these records leave the building and come back: a record sent to a partner library arrives as a record and not as a spreadsheet row, and a record received from one arrives already described.' },
      { kind: 'p', text:
        'They also settle arguments. When two people disagree about how to record something, the answer is usually written down in a standard rather than a matter of taste — and this Handbook will tell you which one.' },
      { kind: 'tip', text:
        'You do not need to learn MARC. The system speaks it on your behalf. The tags in this Handbook are here so that when something goes out into the world you can see what it turned into.' },

      { kind: 'h', text: 'What this catalogue implements', anchor: 'standards-list' },
      { kind: 'p', text:
        'Only what is actually implemented is listed. A claim of conformance that the software does not honour is the same kind of error as a wrong tag, one level up.' },
      { kind: 'list', items: [
        'MARC 21 — the bibliographic and holdings format, used by export, import, SRU and OAI-PMH.',
        'Dublin Core — fifteen elements, for harvesters.',
        'ISBD — the areas of description and their punctuation, added when a record is exported so you never have to type it.',
        'IFLA LRM — the record-versus-copy distinction above, and monograph versus serial.',
        'EDTF (ISO 8601-2) — dates that are uncertain, approximate or a range.',
        'ISO 639-2/B — three-letter language codes on export.',
        'ISO 843 — romanization of Greek.',
        'ISO 15511 — the ISIL, this library’s own identifier.',
        'ISO 2789 — the statistics report.',
        'Code 128 — copy barcodes and printed labels.',
        'WCAG 2.1 AA — this interface itself, including keyboard-only use.'
      ] }
    ]
  },

  consistency: {
    id: 'consistency',
    title: 'Consistency',
    summary:
      'The same thing, written the same way, every time. This is the whole craft, and this catalogue can prove why.',
    blocks: [
      { kind: 'rule', text:
        'If two records mean the same thing, they must say it with the same characters. Not nearly the same — the same.' },
      { kind: 'p', text:
        'This is not pedantry, and this catalogue can show you the cost. Jacques-Paul Migne, whose Patrologia Graeca fills 161 volumes on these shelves, is recorded four different ways: “J.-P.MIGNE” on 154 records, “J. -P. MIGNE” on 6, “J.P. MIGNE” on 2, and “J.P.MIGNE” on the rest. A reader searching one spelling finds 154 of 163 volumes and has no way to know the other nine exist.' },
      { kind: 'quote', text: 'J.-P.MIGNE · J. -P. MIGNE · J.P. MIGNE · J.P.MIGNE',
        source: 'four spellings of one author, 163 records' },
      { kind: 'p', text:
        'The same happens to publishers. “ST. VLADIMIR’S SEMINARY PRESS” appears on 74 records and “ST VLADIMIR’S SEMINARY PRESS” — one full stop fewer — on 55. Neither is wrong. Together they are wrong, because the library now appears to deal with two presses.' },

      { kind: 'h', text: 'One spelling, chosen once', anchor: 'one-spelling' },
      { kind: 'steps', items: [
        'Before typing a name or a publisher, start typing and look at what the field offers you. The suggestions are the spellings already in the catalogue.',
        'If one of them is the same thing you are about to type, take it, even if you would have written it slightly differently.',
        'Only invent a new spelling when it really is a new thing.'
      ] },
      { kind: 'auto', text:
        'Search already ignores accents and case, so “ΓΑΒΡΙΗΛ” finds “Γαβριήλ”. It cannot ignore a missing space or an extra full stop, which is why those matter more than they look.' },

      { kind: 'h', text: 'Consolidate, or make a heading?', anchor: 'consolidate-or-authority' },
      { kind: 'p', text:
        'Two tools answer “one person, spelled several ways”, and they answer it in opposite directions. Choosing the wrong one destroys information, so this is worth reading twice.' },
      { kind: 'compare', good:
        'Spelling consistency, for “J.P.MIGNE” → “J.-P.MIGNE”. One of them is simply a typo, so overwrite it.',
        bad: 'Spelling consistency, for “Epiphanius of Salamis” → “Επιφάνιος Σαλαμίνος”.',
        why: 'Both of those are real names for one man. Overwriting either loses a name the library legitimately holds. That case wants a controlled heading, which keeps the record’s own text and stores the other forms beside it.' },
      { kind: 'p', text:
        'The rule of thumb: if one of the spellings is *wrong*, consolidate it. If all of them are *right*, make a heading and link the records to it.' },
      { kind: 'see', chapter: 'names', anchor: 'saints-and-fathers', text:
        'Fathers and saints are the usual reason to reach for a heading rather than a rewrite.' },

      { kind: 'h', text: 'Empty is not unknown', anchor: 'empty-vs-unknown' },
      { kind: 'p', text:
        'Leaving a field empty says “nobody has recorded this”. Typing “unknown” says “somebody looked and there is nothing to record”. They are different facts and the catalogue treats them differently: an empty field appears in the “needs attention” lists, and a filled one does not.' },
      { kind: 'tip', text:
        'So do not type “—”, “n/a”, “?” or “unknown” to make a field look finished. Leave it empty and let the list of empty fields be true.' },
      { kind: 'p', text:
        'The one exception is authorship, where “no author” is a real and common answer — service books, liturgical texts, anonymous editions. Leave the author field empty for those; the catalogue shows them as having no author rather than pretending to look for one.' }
    ]
  },

  titles: {
    id: 'titles',
    title: 'Titles',
    summary:
      'The title is the one field nearly every search starts from, so it is transcribed exactly and interpreted nowhere.',
    blocks: [
      { kind: 'h', text: 'The title proper', anchor: 'title-proper' },
      { kind: 'rule', text:
        'Transcribe the title from the title page, not from the spine and not from the cover. Where they disagree, the title page wins.' },
      { kind: 'p', text:
        'Copy the wording, the order and the spelling as printed. Do not expand an abbreviation, do not correct an old spelling, and do not translate. The catalogue is a record of what the library holds, and a reader holding the book in their hand should be able to match it to the record character for character.' },
      { kind: 'fields', rows: [
        { fact: 'title', note: 'What the title page says. The one field with no good reason ever to be empty.' }
      ] },
      { kind: 'tip', text:
        'A record may legitimately have no author, no publisher and no date — 3,768 records here have no author and 2,962 no publisher. It should always have a title.' },

      { kind: 'h', text: 'Other title information', anchor: 'subtitle' },
      { kind: 'p', text:
        'A subtitle, an alternative title, or the explanatory phrase that follows a colon on the title page goes in its own field rather than being run into the title. That way a search for the title finds it, and the description can still be printed in full.' },
      { kind: 'compare', good: 'Title: “Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ”. Other title information: “ερμηνευτική προσέγγιση”.',
        bad: 'Title: “Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ: ερμηνευτική προσέγγιση”.',
        why: 'In the second, the title no longer matches the title on any other edition of the same work, so the two will never be recognised as the same thing.' },
      { kind: 'auto', text:
        'The punctuation that separates the two on an exported record — the space-colon-space of ISBD — is added when the record leaves. Do not type it.' },
      { kind: 'p', text:
        'Nothing in this catalogue currently uses the field: all 12,675 records have an empty subtitle, because the import had nowhere to put one. Where you know the subtitle, adding it costs nothing and makes the record findable by it.' },

      { kind: 'h', text: 'Articles at the front', anchor: 'non-filing' },
      { kind: 'p', text:
        'Catalogues traditionally file “Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ” under Θ rather than under Η, because the article carries no information. This catalogue does not ask you to do anything about that: type the article, in its place, as printed.' },
      { kind: 'auto', text:
        'Search ignores position, so a search for “ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ” finds the record whether or not it starts with an article. On export, the record declares that it has no non-filing characters, which is true because you were not asked to strip any.' },

      { kind: 'h', text: 'When a title changes', anchor: 'title-changes' },
      { kind: 'p', text:
        'A periodical that changes its name is the awkward case. Two names means two titles, and MARC deals with it by linking two records. Until this catalogue has that link, record the run under the name it has now and put the former name in a note — which keeps it searchable and leaves the history visible.' },
      { kind: 'see', chapter: 'notes', anchor: 'when-to-note', text: 'What belongs in a note, and what does not.' }
    ]
  },

  'edition-and-imprint': {
    id: 'edition-and-imprint',
    title: 'Edition, publisher and place',
    summary:
      'Which printing this is, and who put it out. Together these are what distinguish two copies of the same work.',
    blocks: [
      { kind: 'p', text:
        'Two records for the same title by the same author are not necessarily duplicates: a second edition is a different publication, and a reprint by a different press is a different publication again. The edition and the imprint are what let you tell.' },

      { kind: 'h', text: 'Edition', anchor: 'edition' },
      { kind: 'p', text:
        'Transcribe the edition statement as printed. Greek title pages usually say “2η έκδ.” or “ἔκδοσις δευτέρα”; record what is there rather than a number you inferred.' },
      { kind: 'fields', rows: [
        { fact: 'edition', note: 'Free text. Transcribed, not normalised.' }
      ] },
      { kind: 'compare', good: '2η έκδ.', bad: '2',
        why: 'The catalogue holds 1,386 edition statements and 466 of them are the bare digit “2”. A bare number is readable by a person who already knows what it means and by nothing else — it does not say whether it is an edition, a printing or a volume.' },
      { kind: 'tip', text:
        'A reprint is not a new edition. If the title page says the same edition and only the printing differs, the edition statement stays the same; note the printing if it matters.' },

      { kind: 'h', text: 'Publisher', anchor: 'publisher' },
      { kind: 'p', text:
        'The name of the press, as printed. This is a field where consistency pays immediately: the catalogue shows every distinct spelling as a separate publisher, so “ΕΚΔΟΣΕΙΣ Π. ΠΟΥΡΝΑΡΑ” and “ΕΚΔΟΣΕΙΣ Π.ΠΟΥΡΝΑΡΑ” — 37 records and 3 — appear as two houses.' },
      { kind: 'fields', rows: [
        { fact: 'publisher', note: 'Take the suggestion the field offers if it is the same press.' }
      ] },
      { kind: 'see', chapter: 'consistency', anchor: 'consolidate-or-authority', text:
        'When two spellings of a press are already in the catalogue, one of these two tools is the answer — and which one matters.' },

      { kind: 'h', text: 'Place of publication', anchor: 'place-of-publication' },
      { kind: 'p', text:
        'Where the book was published, as printed on the title page: “ΑΘΗΝΑ”, “ΘΕΣΣΑΛΟΝΙΚΗ”, “Ἐν Ἀθήναις”. 10,401 records here carry one.' },
      { kind: 'fields', rows: [
        { fact: 'place', note: 'Transcribed. Not converted to a modern form or a country.' }
      ] },

      { kind: 'h', text: 'When there is no publisher or no date', anchor: 'no-publisher' },
      { kind: 'p', text:
        'Old and privately printed books frequently have neither, and 2,962 records here have no publisher. Leave the field empty rather than writing “χ.ε.” or “n.p.”: an empty field is a fact the catalogue can count, and a placeholder is a string it cannot.' },
      { kind: 'see', chapter: 'consistency', anchor: 'empty-vs-unknown', text:
        'Why a placeholder is worse than a blank.' },
      { kind: 'see', chapter: 'dates', anchor: 'uncertain-dates', text:
        'A date you are unsure of has its own syntax, and does not need a placeholder either.' }
    ]
  },

  extent: {
    id: 'extent',
    title: 'Extent',
    summary: 'How much of a thing it is: pages, volumes, plates, size.',
    blocks: [
      { kind: 'h', text: 'The form of the statement', anchor: 'extent-form' },
      { kind: 'p', text:
        'The extent answers “how big is it?” for someone who cannot see it. ISBD gives it a standard shape — the number of pages or volumes, then the illustrations, then the size — and the field takes it as free text so that shape can be transcribed rather than fought with.' },
      { kind: 'fields', rows: [
        { fact: 'extent', note: 'Free text, in the standard order: pages, illustrations, size.' }
      ] },
      { kind: 'compare', good: '156, [3] σ. : εικ. ; 21 εκ.', bad: '156',
        why: 'The catalogue holds 11,717 extent statements and most are a bare number like “31” or “159”. A number alone does not say whether it counts pages, leaves or volumes, and it cannot be printed in a description.' },
      { kind: 'p', text:
        'The square brackets in the good example are not decoration: they mark pages that are physically there but not numbered, which is how you record a book with three unpaginated pages at the end without inventing numbers for them.' },
      { kind: 'tip', text:
        'You are not expected to go back and rewrite 11,717 statements. Write the full form on new records, and improve an old one when you have the book in your hands for another reason.' },

      { kind: 'h', text: 'Size', anchor: 'dimensions' },
      { kind: 'p', text:
        'Height in centimetres, rounded up. A book 20.4 cm tall is 21 εκ. Size matters more than it sounds: it is often the quickest way to tell two printings apart, and it tells whoever is shelving whether the book fits.' },
      { kind: 'see', chapter: 'copies-and-shelves', anchor: 'oversize', text:
        'An oversized volume often cannot stand with the rest of its set. That is a decision about the copy.' }
    ]
  },

  classification: {
    id: 'classification',
    title: 'Classification',
    summary:
      'Two systems side by side: the shelf marks this library already uses, and Dewey for the outside world.',
    blocks: [
      { kind: 'h', text: 'The shelf classification', anchor: 'shelf-classification' },
      { kind: 'p', text:
        'The shelf marks in this library are a classification: 19-000 is a subject area, not just a location. 8,117 records carry such a code. It works, the spines are labelled with it, and nothing in this Handbook suggests changing it — re-labelling 12,675 spines to gain conformance nobody asked for would be a bad trade.' },
      { kind: 'fields', rows: [
        { fact: 'localClass', note: 'The local class number. Exported in the slot MARC keeps for exactly this.' },
        { fact: 'shelfCode', note: 'Where the copy physically stands. Usually the same code, written as a shelf mark.' }
      ] },

      { kind: 'h', text: 'Dewey', anchor: 'ddc' },
      { kind: 'p', text:
        'Dewey sits alongside the shelf mark and does not replace it. Its value is that it means the same thing everywhere: a record exported with a Dewey number can be placed by any library that receives it, which a local shelf code cannot.' },
      { kind: 'fields', rows: [
        { fact: 'ddc', note: 'The Dewey number. Optional, and only worth adding where you are confident.' }
      ] },
      { kind: 'p', text:
        'No record here has one yet. The most useful place to start is the part of the collection most likely to be shared or looked for from outside — patristics sits in 270, liturgy in 264, scripture in 220.' },
      { kind: 'auto', text:
        'A record imported from another library keeps the Dewey number it arrived with, so importing is also a way of acquiring classification you did not have to do yourself.' },
      { kind: 'tip', text:
        'A partial Dewey number is fine. “270” is true and useful; “270.0947” asserts a precision you may not have.' },

      { kind: 'h', text: 'Code or label — never both', anchor: 'code-vs-label' },
      { kind: 'p', text:
        'The import left the collection split down the middle: 8,117 records carry a category CODE and 4,216 carry a category LABEL, and not one record carries both. They came from different source sheets.' },
      { kind: 'quote', text: '8,117 with a code · 4,216 with a label · 0 with both',
        source: 'measured on the live catalogue' },
      { kind: 'p', text:
        'This is worth knowing because it explains something that otherwise looks like a bug: a subject list built from labels covers a third of the collection, and one built from codes covers two thirds, and neither covers all of it. When you are reconciling a shelf, check which of the two that part of the collection uses.' },
      { kind: 'see', chapter: 'consistency', anchor: 'one-spelling', text:
        'The labels are free text, so they drift in exactly the way names do.' }
    ]
  },

  identifiers: {
    id: 'identifiers',
    title: 'Identifiers',
    summary:
      'ISBN and ISSN: what they are for, why one of them checks itself, and what to do when it fails.',
    blocks: [
      { kind: 'p', text:
        'An identifier is the one field where two records can be compared with certainty. Titles vary, names vary, but an ISBN either matches or does not — which is why import, duplicate detection and lookup all reach for it first.' },

      { kind: 'h', text: 'ISBN', anchor: 'isbn' },
      { kind: 'fields', rows: [
        { fact: 'isbn', note: 'Type it as printed; the formatting is stripped for you. 10 or 13 digits.' }
      ] },
      { kind: 'p', text:
        'Only 602 of 12,675 records have one, and that is expected rather than a gap: ISBNs began in the 1970s and most of this collection is older. An absent ISBN is not a record that needs fixing.' },
      { kind: 'auto', text:
        'Hyphens and spaces are removed on save, so “978-960-315-733-5” and “9789603157335” are stored identically and match each other. A ten-digit ISBN is also converted to its thirteen-digit form for MATCHING only — the number you typed is what stays on the record.' },

      { kind: 'h', text: 'When an ISBN is refused', anchor: 'bad-isbn' },
      { kind: 'p', text:
        'The last digit of an ISBN is a check digit computed from the others, so most typing mistakes can be detected without looking anything up. Twenty records here have an ISBN whose check digit does not match.' },
      { kind: 'rule', text:
        'A failed check digit is a warning, never a refusal. The record saves. You are transcribing what is printed in a book, and a book with a wrong ISBN printed in it still exists.' },
      { kind: 'steps', items: [
        'Check the number against the book once more — a transposed pair of digits is the usual cause.',
        'If the book really does print that number, leave it. The record is correct and the publisher was wrong.',
        'If you cannot check the book right now, leave it and move on; the smart list will bring it back to you.'
      ] },
      { kind: 'tip', text:
        'The “Bad ISBN” smart list collects all twenty in one place, which makes them a half-hour job rather than a background worry.' },

      { kind: 'h', text: 'ISSN', anchor: 'issn' },
      { kind: 'p', text:
        'A periodical has an ISSN rather than an ISBN, and it identifies the TITLE rather than one issue — the whole run of ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ shares one ISSN. Thirteen records here carry one.' },
      { kind: 'fields', rows: [
        { fact: 'issn', note: 'Eight digits, written as four-four with a hyphen.' },
        { fact: 'bibLevel', note: 'An ISSN is the usual sign that this should be set to periodical.' }
      ] },
      { kind: 'p', text:
        'All thirteen of those records are currently catalogued as monographs, which is why the statistics report says the library holds no serials. Setting the kind of publication on each is a thirteen-record job that makes a statutory return true.' },
      { kind: 'see', chapter: 'dates', anchor: 'date-ranges', text:
        'A periodical also wants its run recorded, not one record per issue.' }
    ]
  },

  notes: {
    id: 'notes',
    title: 'Notes and attributes',
    summary:
      'Where to put something true that no field asks for — and where not to.',
    blocks: [
      { kind: 'h', text: 'What belongs in a note', anchor: 'when-to-note' },
      { kind: 'p', text:
        'A note is for something a reader would want to know that the described fields cannot carry: a dedication, a former owner, the fact that pages are missing, the language of an introduction that differs from the text, a former title.' },
      { kind: 'fields', rows: [
        { fact: 'description', note: 'Free text about the PUBLICATION — true of every copy.' }
      ] },
      { kind: 'rule', text:
        'A note about the publication goes on the record. A note about one physical volume goes on that copy. They are different fields because they are different facts.' },
      { kind: 'compare', good: 'On the record: “Περιέχει βιβλιογραφία σ. 143-156.” On the copy: “Χαλαρή ράχη· δωρεά Π. Παπαδοπούλου.”',
        bad: 'Both of those on the record.',
        why: 'The second copy is not damaged and was not donated. A note on the record says it is.' },
      { kind: 'p', text:
        'Keep notes short and factual. A note is read by someone deciding whether to walk to the shelf, not by someone who wants an essay.' },

      { kind: 'h', text: 'Attributes', anchor: 'custom-attributes' },
      { kind: 'p', text:
        'Attributes are extra fields this library added for itself, and they are how the import brought in columns the standard model has no home for. Some of them are load-bearing — the series, the place of publication, the extent and the category are all attributes — and some are notes by another name.' },
      { kind: 'tip', text:
        'Before adding a new attribute, check whether a real field already covers it. An attribute is invisible to MARC export, to Dublin Core, and to any library you send records to; a real field is not.' },
      { kind: 'p', text:
        'The everyday attributes are pinned to the top of the form, in the order the library chose, so the handful you fill on nearly every book are not buried among two dozen you rarely open.' },
      { kind: 'see', chapter: 'copies-and-shelves', anchor: 'copy-notes', text:
        'The per-copy note, and the nine other things one volume can record.' }
    ]
  },

  names: {
    id: 'names',
    title: 'Greek and Orthodox names',
    summary:
      'Monastics, bishops, Fathers and brotherhoods — the forms this collection is mostly made of, and how to record them.',
    blocks: [
      { kind: 'p', text:
        'Most cataloguing advice is written for names shaped like “Smith, John”. Very little of this library is. Around three quarters of it is Greek, and much of it is by monastics, bishops and Fathers of the Church, whose names do not have a surname in the place a form expects one — and often do not have a surname at all.' },

      { kind: 'h', text: 'The title page is in the genitive', anchor: 'greek-name-order' },
      { kind: 'p', text:
        'A Greek title page usually says whose book it is, not who the author is: “ΑΡΧΙΜ. ΝΙΚΟΔΗΜΟΥ Γ. ΑΕΡΑΚΗ” is “of Archimandrite Nikodimos G. Aerakis”. The catalogue records it in that form, because that is what is printed, and because changing it to the nominative is a judgement that a later reader cannot undo.' },
      { kind: 'quote', text: 'ΑΡΧΙΜ. ΝΙΚΟΔΗΜΟΥ Γ. ΑΕΡΑΚΗ',
        source: 'as printed, on 39 records' },
      { kind: 'rule', text:
        'Transcribe what is on the piece. Interpretation belongs in a heading, which can hold several forms at once, not in the field that records what the book says about itself.' },

      { kind: 'h', text: 'Monastics, priests and bishops', anchor: 'monastics-and-bishops' },
      { kind: 'p', text:
        'The rank is part of how these authors are known and it stays. What matters is that it is abbreviated the same way every time. This catalogue currently has both “ΑΡΧΙΜ.” and “ΑΡΧΙΜΑΝΔΡΙΤΟΥ” in use — eleven records with the word written out — which splits one author into two.' },
      { kind: 'list', items: [
        'ΑΡΧΙΜ. — archimandrite. The commonest by far here; prefer the abbreviation.',
        'Π. — priest (πατήρ). “Π. ΓΕΩΡΓΙΟΣ ΦΡΑΓΚΙΑΔΑΚΗΣ” is on 34 records, twice without the space after the full stop.',
        'ΜΟΝΑΧΟΣ / ΙΕΡΟΜΟΝΑΧΟΣ — monk, priest-monk.',
        'ΜΗΤΡΟΠΟΛΙΤΗΣ + see — a metropolitan is identified by his see, not a surname: “ΜΗΤΡΟΠΟΛΙΤΗΣ ΠΕΙΡΑΙΩΣ ΚΑΛΛΙΝΙΚΟΣ Ι. ΚΑΡΟΥΣΟΣ”.'
      ] },
      { kind: 'tip', text:
        'A bishop who is known by his see and also has a family name has effectively two names, and both are worth finding him by. That is exactly what a heading with variant forms is for.' },

      { kind: 'h', text: 'Fathers and saints', anchor: 'saints-and-fathers' },
      { kind: 'p', text:
        'A Father of the Church has no surname, is known by name plus place or epithet, and appears differently in Greek, in Latin scholarship and in English translation. Επιφάνιος Σαλαμίνος, Epiphanius of Salamis and Ἐπιφάνιος Κύπρου are one man under three legitimate names.' },
      { kind: 'p', text:
        'Record on the book what the book says. Then make one heading for him, put the other forms in it as variants, and link the records. After that, a search for any of the three finds all of them, and nothing that was printed has been overwritten.' },
      { kind: 'compare', good:
        'A heading “Επιφάνιος Σαλαμίνος”, dates 315-403, with variants “Epiphanius of Salamis” and “Ἐπιφάνιος Κύπρου”.',
        bad: 'Rewriting every record to whichever form was catalogued most often.',
        why: 'The variants are how people will actually search. Overwriting them throws away the only record that the other names exist.' },
      { kind: 'see', chapter: 'transliteration', anchor: 'parallel-fields', text:
        'The Latin form of a Greek name also has a field of its own on the record.' },

      { kind: 'h', text: 'Brotherhoods, monasteries and institutions', anchor: 'corporate-names' },
      { kind: 'p', text:
        'A brotherhood or a monastery is an author in its own right, and it is recorded as a body rather than a person. Watch the quotation marks: “ΑΔΕΛΦΟΤΗΣ ΘΕΟΛΟΓΩΝ «Ο ΣΩΤΗΡ»” appears in this catalogue as “<<Ο ΣΩΤΗΡ>>”, which is what the import made of the Greek quotation marks. Keep whichever form the catalogue already uses, consistently, rather than fixing one record at a time.' },

      { kind: 'h', text: 'When there is no author', anchor: 'no-author' },
      { kind: 'p', text:
        'Service books, liturgical texts, collections and anonymous editions often have no author, and that is a complete answer rather than a gap. Leave the field empty. The catalogue will show the record as having no author, and it will still be found by title, series and subject.' },
      { kind: 'auto', text:
        'A record with no author is stored as genuinely empty, so it appears in the author-less lists and is never invented as “Anonymous”.' }
    ]
  },

  headings: {
    id: 'headings',
    title: 'Controlled headings',
    summary:
      'One form of a name, with the other forms recorded beside it. The catalogue keeps what you typed; the heading adds the ways in.',
    blocks: [
      { kind: 'h', text: 'What a heading is', anchor: 'what-a-heading-is' },
      { kind: 'p', text:
        'A heading is a small record about a name: one preferred form, the variant forms that mean the same thing, dates if the name is a person, and an identifier if the name exists in an international file. Records point at it. They do not become it.' },
      { kind: 'rule', text:
        'A heading POINTS. It never rewrites what is on the record. The book keeps saying what its title page said.' },
      { kind: 'p', text:
        'That is the whole difference from the spelling-consistency tool, and it is why both exist. This catalogue has 5,427 distinct author strings and no headings at all yet, so every one of those 5,427 is currently its own island.' },
      { kind: 'see', chapter: 'consistency', anchor: 'consolidate-or-authority', text:
        'Which of the two tools a given problem wants.' },

      { kind: 'h', text: 'Making one', anchor: 'making-a-heading' },
      { kind: 'steps', items: [
        'Decide the preferred form: the one the catalogue will show. Write it as you want it to read in a record sent to another library.',
        'Choose the kind — person, body, publisher, subject, uniform title. It changes nothing about how the heading behaves; it is what lets you browse them separately.',
        'Add dates for a person if you know them. “315-403” is enough, and it is often the only way to tell two people with one name apart.',
        'Add the variant forms, one per line.',
        'Link the records to it from the book, or link as you go when you next touch each one.'
      ] },
      { kind: 'tip', text:
        'Do not try to build the authority file in one sitting. Start with the names that repeat: the Fathers, the standard series, the presses you buy from. A heading for a name that appears once has cost more than it saved.' },

      { kind: 'h', text: 'Variant forms', anchor: 'variant-forms' },
      { kind: 'p', text:
        'The variants are the point of the exercise. Searching finds a heading by any of them, so what belongs there is not every form that exists but every form somebody might type.' },
      { kind: 'compare', good:
        'Preferred: “Επιφάνιος Σαλαμίνος”. Variants: “Epiphanius of Salamis”, “Ἐπιφάνιος Κύπρου”, “Επιφάνιος, άγιος”.',
        bad: 'Preferred: “Επιφάνιος Σαλαμίνος”. Variants: none.',
        why: 'Without the variants the heading is a label. With them it is an index — someone who knows him only as Epiphanius of Salamis still finds him.' },
      { kind: 'p', text:
        'Include the romanized form as a variant even though the record has its own field for it. The field makes one record readable; the variant makes the whole heading findable.' },

      { kind: 'h', text: 'Correcting one', anchor: 'correcting-a-heading' },
      { kind: 'p', text:
        'Edit it. Every record that points at the heading keeps pointing at it, and they all show the corrected form at once — which is the entire reason a heading is better than 163 copies of a name.' },
      { kind: 'auto', text:
        'Editing a heading never touches the links. Retiring one and re-creating it loses every link, which is why the retire dialog suggests editing instead.' },

      { kind: 'h', text: 'Retiring one', anchor: 'retiring-a-heading' },
      { kind: 'p', text:
        'Retiring unlinks every record that used the heading. That is deliberate — a record must not point at a heading that no longer exists — but it is not reversible, so the dialog tells you how many records it will affect before it does it.' },
      { kind: 'rule', text:
        'Retire a heading only when it should never have existed. To change what it says, edit it.' }
    ]
  },

  contributors: {
    id: 'contributors',
    title: 'Editors, translators and others',
    summary:
      'Everyone involved in a book who is not its author, and the code that says what they did.',
    blocks: [
      { kind: 'p', text:
        'A great deal of this collection is edited, translated or introduced rather than written: 1,195 records name an editor and 492 name a translator. Those people are how a reader finds the book — someone looking for Ιωήλ Γιαννακόπουλος as a translator will not find him in the author field.' },

      { kind: 'h', text: 'The role codes', anchor: 'relators' },
      { kind: 'p', text:
        'A contributor is a heading plus a role. The role is a standard three-letter code, so a record sent to another library says what the person did in a form that library already understands rather than in a word it has to guess at.' },
      { kind: 'fields', rows: [
        { fact: 'contributor', note: 'The heading, plus the role code. Exported as an added entry with the role attached.' },
        { fact: 'author', note: 'Stays as transcribed. A contributor never replaces it.' }
      ] },
      { kind: 'list', items: [
        'aut — author. The main one; usually already in the author field.',
        'edt — editor. The commonest here after author.',
        'trl — translator.',
        'ill — illustrator.',
        'aui — author of an introduction.',
        'ann — annotator. Common in patristic editions.',
        'com — compiler. For a collection assembled rather than written.',
        'ctb — contributor, for anyone whose part does not fit the others.'
      ] },

      { kind: 'h', text: 'Editor and translator today', anchor: 'editor-and-translator' },
      { kind: 'p', text:
        'Both are currently free-text attributes: 623 distinct editor strings and 398 distinct translator strings, none of them linked to anything. They are searchable as text and invisible as people — the same name spelled two ways is two editors, and none of them reaches a MARC record as an added entry.' },
      { kind: 'quote', text: '1,195 records name an editor, in 623 different strings · 492 name a translator, in 398',
        source: 'measured on the live catalogue' },
      { kind: 'p', text:
        'Converting them is worth doing gradually and in order of frequency. An editor who appears on forty records is worth a heading this week; one who appears once can wait indefinitely.' },

      { kind: 'h', text: 'What to do with the free text', anchor: 'free-text-contributors' },
      { kind: 'steps', items: [
        'Leave the attribute alone. It is what the record says and it stays true.',
        'Make a heading for the person, with the spellings from the attribute as variant forms.',
        'Link the records to the heading with the right role.',
        'Do not delete the attribute afterwards — it costs nothing and it is the evidence of where the heading came from.'
      ] },
      { kind: 'see', chapter: 'headings', anchor: 'variant-forms', text:
        'The variant spellings from the attribute are exactly what the heading should carry.' }
    ]
  },

  subjects: {
    id: 'subjects',
    title: 'Subjects',
    summary:
      'What a book is about, recorded in a way that groups books rather than describing each one separately.',
    blocks: [
      { kind: 'h', text: 'A subject is a heading too', anchor: 'subject-headings' },
      { kind: 'p', text:
        'Subjects use the same machinery as names: one preferred form, variants, and records pointing at it. That is not an implementation detail — it is why a subject list is useful. Free-text keywords describe each book; a controlled subject collects them.' },
      { kind: 'fields', rows: [
        { fact: 'subject', note: 'A heading of kind “subject”, linked to the record.' }
      ] },
      { kind: 'rule', text:
        'A subject answers “what is this about”, not “what is this”. “Liturgy” is a subject; “hardback” is not.' },

      { kind: 'h', text: 'Starting from what you already wrote', anchor: 'seeding-subjects' },
      { kind: 'p', text:
        'The catalogue already contains a subject vocabulary: the category labels, 4,216 records’ worth. They were written by the people who know this collection, which makes them a far better starting point than any imported list.' },
      { kind: 'steps', items: [
        'Open the subject seeding tool from the headings card.',
        'It lists the labels with the number of records carrying each — “TRIBUTE TO PERSON · on 178 records”. Read down the list.',
        'Tick the ones that are real subject headings. Leave the ones that are shelf categories, form descriptions or one-offs.',
        'Confirm. Each becomes a heading and is linked to every record carrying that label.'
      ] },
      { kind: 'tip', text:
        'Ticking nothing is a valid outcome of a first pass. Reading the list and deciding “these thirty, not those four hundred” is the work; the software only does the typing.' },
      { kind: 'see', chapter: 'classification', anchor: 'code-vs-label', text:
        'Only a third of the collection has labels at all, so this covers a third of it. That is not a bug.' },

      { kind: 'h', text: 'Subjects that arrive from elsewhere', anchor: 'imported-subjects' },
      { kind: 'p', text:
        'A record imported from another library usually carries subject headings already, often from an international thesaurus. Those arrive as headings and are linked automatically, with the thesaurus they came from recorded — so an imported LCSH heading is marked as LCSH rather than pretending to be ours.' },
      { kind: 'auto', text:
        'Importing the same file twice does not duplicate the headings, and it never removes one you attached by hand. Import adds; it does not replace.' },
      { kind: 'p', text:
        'This is the cheapest subject cataloguing available: a record received from a library that has already done the work arrives with it done.' }
    ]
  },

  'series-and-sets': {
    id: 'series-and-sets',
    title: 'Series and multi-part works',
    summary:
      'The 161 volumes of the Patrologia Graeca are one series. Recording that is what makes a missing volume visible.',
    blocks: [
      { kind: 'h', text: 'The series statement', anchor: 'series-statement' },
      { kind: 'p', text:
        'A series is the named collection a book belongs to, printed on the title page or the half-title: ΕΛΛΗΝΙΚΗ ΠΑΤΡΟΛΟΓΙΑ, ΕΛΛΗΝΕΣ ΠΑΤΕΡΕΣ ΤΗΣ ΕΚΚΛΗΣΙΑΣ, ΒΙΒΛΙΟΘΗΚΗ ΕΛΛΗΝΩΝ ΠΑΤΕΡΩΝ. The three largest here run to 161, 102 and 72 volumes.' },
      { kind: 'fields', rows: [
        { fact: 'series', note: 'The name of the series, as printed.' },
        { fact: 'volume', note: 'Which volume of it this is.' }
      ] },
      { kind: 'p', text:
        'Nearly every record has a series value — 12,597 of 12,675 — but that number is misleading. The import copied the title into the series field where it had nothing else to put, so more than half of those are a book’s own title repeated rather than a series it belongs to.' },
      { kind: 'tip', text:
        'When you open a record whose series is identical to its title, and it is not part of anything, clear the series. It costs one keystroke and removes one false group from the browser.' },

      { kind: 'h', text: 'Multi-part works', anchor: 'multi-part-works' },
      { kind: 'p', text:
        'A work in several volumes where every volume has the same title is the commonest shape here — a 24-volume encyclopaedia, a 47-issue periodical. What makes them tractable is the volume number: with it, the catalogue can put them in order and see what is absent.' },
      { kind: 'compare', good: 'Series: “ΜΕΓΑΛΗ ΕΛΛΗΝΙΚΗ ΕΓΚΥΚΛΟΠΑΙΔΕΙΑ”. Volume: “7”.',
        bad: 'Title: “ΜΕΓΑΛΗ ΕΛΛΗΝΙΚΗ ΕΓΚΥΚΛΟΠΑΙΔΕΙΑ ΤΟΜΟΣ 7”, no series, no volume.',
        why: 'The second is findable and nothing more. The first is a member of a set, so the catalogue can tell you that volume 12 is missing.' },
      { kind: 'p', text:
        'Volume designations here are genuinely varied — “1”, “12”, “Α΄”, “τ. 3”, “1-2”, “ΜΕΡΟΣ Β΄” — and all of them are accepted as typed. Greek numerals are read as numbers, so “Α΄” counts as volume 1.' },
      { kind: 'auto', text:
        'A volume designation that cannot be read as a number is counted and shown, never silently dropped, and never used to invent a gap. A set of volumes labelled “πρώτος τόμος”, “δεύτερος τόμος” is reported as three unnumbered volumes rather than as a set with holes in it.' },

      { kind: 'h', text: 'Finding the missing volume', anchor: 'missing-volumes' },
      { kind: 'p', text:
        'The multi-part browser lists every group with two or more members and says which volumes are absent from the run. That is its whole purpose: a librarian standing at a shelf can compare what is there with what should be.' },
      { kind: 'rule', text:
        'A number in the browser opens a list of exactly that many books. If it ever does not, that is a fault worth reporting.' },
      { kind: 'p', text:
        'The browser hides groups where there is no evidence of a set at all — every member titled the same as the group and not one carrying a volume number — and says how many it hid. Those are usually the same book catalogued more than once, which is the duplicate tool’s business rather than this one’s.' },
      { kind: 'see', chapter: 'dates', anchor: 'date-ranges', text:
        'A periodical is not a multi-part monograph: record its run instead of one record per issue.' }
    ]
  },

  searching: {
    id: 'searching',
    title: 'Searching',
    summary:
      'What the search box does, so that a search that finds nothing tells you something.',
    blocks: [
      { kind: 'h', text: 'What it ignores', anchor: 'how-search-works' },
      { kind: 'p', text:
        'Search ignores accents and case. “ΓΑΒΡΙΗΛ”, “Γαβριήλ” and “γαβριηλ” are one search. This matters more in Greek than in English, because the same word appears with and without accents throughout an old catalogue, and because a keyboard set to monotonic Greek cannot type a polytonic form at all.' },
      { kind: 'auto', text:
        'Every searchable field is stored a second time with the accents removed, and the search compares against that copy. You never see it and never maintain it.' },
      { kind: 'rule', text:
        'What search cannot ignore is a missing space or an extra full stop. “J.P.MIGNE” and “J.-P.MIGNE” are two different strings to it, which is why consistency in those fields matters more than it looks.' },
      { kind: 'see', chapter: 'consistency', anchor: 'one-spelling', text:
        'The four spellings of Migne, and what they cost.' },

      { kind: 'h', text: 'Partial words and near misses', anchor: 'partial-and-fuzzy' },
      { kind: 'p', text:
        'Two switches change how forgiving a search is, and they are separate because they fail differently.' },
      { kind: 'list', items: [
        'Partial words — “λειτουργ” matches “λειτουργία” and “λειτουργικός”. Useful in Greek, where the ending changes with the case.',
        'Near misses — allows a small number of wrong letters, for a name you half remember or half heard. It will also return things you did not mean, which is the price.'
      ] },
      { kind: 'tip', text:
        'Turn near misses OFF when you are checking whether something already exists. A fuzzy match that looks like your book is exactly how a duplicate gets created.' },

      { kind: 'h', text: 'The smart lists', anchor: 'smart-lists' },
      { kind: 'p', text:
        'The smart lists are saved questions about the catalogue’s own condition rather than about its subject: records with no author, no shelf mark, no year, a failed ISBN check digit, or flagged as needing review. They are the practical form of “what is left to do”.' },
      { kind: 'p', text:
        'Each of them is finite and shrinks as you work. Twenty bad ISBNs is a half-hour; 3,768 records with no author is a fact about the collection rather than a task, because most of them genuinely have no author.' },
      { kind: 'see', chapter: 'consistency', anchor: 'empty-vs-unknown', text:
        'This is why a placeholder in an empty field is harmful: it removes the record from the list that would have brought it back to you.' }
    ]
  },

  transliteration: {
    id: 'transliteration',
    title: 'Transliteration and parallel scripts',
    summary:
      'How a Greek record is also readable by someone who does not read Greek, without the Greek being replaced.',
    blocks: [
      { kind: 'h', text: 'Why romanize at all', anchor: 'why-romanize' },
      { kind: 'p', text:
        'Because a catalogue that only contains Greek script can only be searched by someone with a Greek keyboard, and because a partner library abroad receiving these records may not be able to display them at all. A romanized form makes the record reachable without making it less Greek.' },
      { kind: 'rule', text:
        'The original script is what the record shows. The romanized form sits beside it and never replaces it.' },
      { kind: 'p', text:
        'This mattered in practice: an early version of the ISBN lookup filled the title field with “Epiphanios Salaminos Kyprou” and the Greek was gone. The romanized fields exist so that cannot happen again.' },

      { kind: 'h', text: 'ISO 843', anchor: 'iso-843' },
      { kind: 'p', text:
        'ISO 843 is the standard for turning Greek into Latin letters. Use its transliteration scheme — letter for letter, reversibly — rather than writing the name the way an English speaker would pronounce it. “Θεοδώρου” becomes “Theodorou”, not “Thedhorou”.' },
      { kind: 'tip', text:
        'You do not need to romanize everything, and today nothing in this catalogue is romanized at all — the fields are empty on all 12,700 records. Start with the authors and titles most likely to be looked for from outside: the Fathers, the standard series, anything you would send to another library.' },

      { kind: 'h', text: 'The parallel fields', anchor: 'parallel-fields' },
      { kind: 'p', text:
        'Three fields on the record hold the romanized reading, one for each thing worth finding in Latin script.' },
      { kind: 'fields', rows: [
        { fact: 'titleRomanized', note: 'The romanized title. Exported as a linked 880 field, which is how MARC carries a script pair.' },
        { fact: 'authorRomanized', note: 'The romanized author. Same treatment.' },
        { fact: 'title', note: 'Stays in Greek. This is the form the catalogue displays and prints.' },
        { fact: 'author', note: 'Likewise.' }
      ] },
      { kind: 'auto', text:
        'When a record is exported, the Greek and the romanized forms are paired automatically as a MARC 880 field with a link back to the original. You fill two boxes; the standard formatting is not your problem.' },
      { kind: 'see', chapter: 'names', anchor: 'saints-and-fathers', text:
        'For a Father known under several Latin forms, the heading holds the alternatives; the romanized field holds one.' }
    ]
  },

  dates: {
    id: 'dates',
    title: 'Dates',
    summary:
      'How to record a date you are not sure of, without either guessing or leaving it blank.',
    blocks: [
      { kind: 'p', text:
        'Older books frequently do not say plainly when they were printed. The date is missing, or given only as a decade, or printed with a question mark, or the book was issued over several years. A single year field forces a choice between an invented certainty and an empty box, and both lose information.' },

      { kind: 'h', text: 'EDTF: the date field understands more than a year', anchor: 'edtf' },
      { kind: 'p', text:
        'The date of publication is recorded in EDTF — the Extended Date/Time Format, standardised as ISO 8601-2. It is a small, readable syntax for exactly the cases above, and the field accepts it directly.' },
      { kind: 'fields', rows: [
        { fact: 'date', note: 'Accepts EDTF. “1955” is still just “1955”; the syntax only appears when you need it.' }
      ] },

      { kind: 'h', text: 'Uncertain and approximate', anchor: 'uncertain-dates' },
      { kind: 'list', items: [
        '1955 — the book says 1955.',
        '1955? — the book says 1955 and you doubt it, or the date is bracketed on the title page.',
        '1955~ — about 1955. Use for “circa”.',
        '195X — some year in the 1950s, not known which.',
        '19XX — some year in the twentieth century.'
      ] },
      { kind: 'compare', good: '[1955?] on the title page → type 1955?',
        bad: '[1955?] on the title page → type 1955',
        why: 'The second one promises a certainty the book does not offer. The question mark costs you one keystroke and keeps the doubt where a later reader can see it.' },
      { kind: 'auto', text:
        'Whatever you type, the catalogue works out the earliest and latest year it can mean and sorts and filters on those, so an uncertain date is still findable by year. It also exports correctly: MARC records an uncertain date as a questionable one rather than as fact.' },

      { kind: 'h', text: 'Ranges and runs', anchor: 'date-ranges' },
      { kind: 'list', items: [
        '1955/1957 — issued across those years. Use for a work published over a span.',
        '1880/1889 — the same, for a set or a run of a periodical.',
        '1975/ — began in 1975 and is still going. For a periodical the library still receives.'
      ] },
      { kind: 'p', text:
        'A periodical is a different kind of thing from a book, and the catalogue has a switch for it: set the kind of publication to periodical and record the run separately. Thirteen records here carry an ISSN, which is the usual sign that a record is really a periodical.' },
      { kind: 'fields', rows: [
        { fact: 'bibLevel', note: 'Monograph or periodical. Changes what the record exports as, and what the statistics count.' },
        { fact: 'serialRun', note: 'What is actually on the shelf: “τόμος 1-10 (1880-1889)”, with the gaps recorded separately.' }
      ] },
      { kind: 'tip', text:
        'ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ is currently catalogued as 47 separate books. It is one periodical with 47 issues held. Recording it that way replaces 47 records with one title and one run statement.' },
      { kind: 'p', text:
        'Nothing in this catalogue uses an uncertain date yet — every stored date is a plain year. That is not a sign the collection has no doubtful dates; it is a sign the field could not express them before.' }
    ]
  },

  'copies-and-shelves': {
    id: 'copies-and-shelves',
    title: 'Copies',
    summary:
      'The physical volumes. One record, as many copies as the library owns — and ten things each of them can say.',
    blocks: [
      { kind: 'p', text:
        'There are 12,675 copies in this catalogue and 12,675 records, which means nobody has ever recorded a second copy of anything. Where the library owns a book twice, one of the two is either uncatalogued or catalogued again as its own record.' },
      { kind: 'see', chapter: 'what-a-catalogue-is-for', anchor: 'record-vs-copy', text:
        'Why the second of those is the expensive mistake.' },

      { kind: 'h', text: 'Adding a copy', anchor: 'adding-a-copy' },
      { kind: 'steps', items: [
        'Open the record and press the copies button.',
        'Press “Add a copy”. It inherits the room, shelf and kind of the one above it, because a second copy of a book is nearly always the same sort of thing in nearly the same place.',
        'Give it whatever distinguishes it: a different shelf, a volume number, a barcode.',
        'Press Save once, at the end.'
      ] },
      { kind: 'rule', text:
        'Nothing is written until you press Save. Editing several copies and saving once is one change to the record, not one per keystroke.' },
      { kind: 'auto', text:
        'A record always keeps at least one copy. Removing the last one is refused, because a record with no copies falls out of every shelf search and out of the stock count — to remove the whole thing, delete the record.' },
      { kind: 'p', text:
        'For many records at once — “29 volumes, each also on the back shelf” — the bulk add-copies action in the library view does it in one step rather than 29.' },

      { kind: 'h', text: 'The order is the numbering', anchor: 'copy-order' },
      { kind: 'p', text:
        'Copies are numbered by their position in the list, so the arrows that move a copy up or down are how you renumber. Copy 1 is the first, and its shelf mark is the one shown on the record itself.' },
      { kind: 'tip', text:
        'That last part matters when a book is in two places: put the copy a reader is most likely to be sent to first, because that is the location the record advertises.' },

      { kind: 'h', text: 'Condition', anchor: 'copy-condition' },
      { kind: 'p', text:
        'Free text about the state of this volume: “καλή”, “χαλαρή ράχη”, “λείπει το εξώφυλλο”. It belongs to the copy and not to the record, because the other copy may be perfect.' },
      { kind: 'fields', rows: [
        { fact: 'copyNumber', note: 'Derived from the order. Not typed.' },
        { fact: 'shelfCode', note: 'Where this volume stands.' },
        { fact: 'callNumber', note: 'The classification-based location. Exported to other libraries.' },
        { fact: 'barcode', note: 'This volume’s own number, for scanning.' }
      ] },

      { kind: 'h', text: 'Notes on one volume', anchor: 'copy-notes' },
      { kind: 'p', text:
        'Provenance, a donor, a dedication written inside, the fact that this copy is water-damaged. Anything true of this physical object and not of the publication.' },
      { kind: 'see', chapter: 'notes', anchor: 'when-to-note', text:
        'The other kind of note — the one that belongs to the publication.' },

      { kind: 'h', text: 'When a volume does not fit', anchor: 'oversize' },
      { kind: 'p', text:
        'An oversized volume often cannot stand with the rest of its set, and the honest way to record that is to give that copy its own shelf mark rather than the set’s. The record still holds them together through the series; only the copy moves.' },
      { kind: 'see', chapter: 'extent', anchor: 'dimensions', text:
        'The size belongs to the publication. Where it stands belongs to the copy.' }
    ]
  },

  'shelf-marks': {
    id: 'shelf-marks',
    title: 'Shelf marks, rooms and call numbers',
    summary:
      'Three different answers to “where is it?”, and which one each is for.',
    blocks: [
      { kind: 'h', text: 'The shelf mark', anchor: 'shelf-mark-form' },
      { kind: 'p', text:
        'The shelf marks here take the form 15-003: a subject area and a position within it. They are a classification as much as a location, which is why the same code appears as both a shelf mark on the copy and a class number on the record.' },
      { kind: 'quote', text: '15-003 · 28-003 · 25-003 · 14-005 · 30-000',
        source: 'the busiest shelf marks, 185 to 123 volumes each' },
      { kind: 'auto', text:
        'Shelf marks are stored upper-cased, and Greek ones are upper-cased the Greek way — so “πισω” and “ΠΙΣΩ” are the same shelf and a search for either finds both.' },
      { kind: 'p', text:
        'Seventy-three copies have no shelf mark at all. Those are the ones a reader cannot be sent to, which makes them the most useful list in the catalogue to work through.' },
      { kind: 'see', chapter: 'searching', anchor: 'smart-lists', text:
        'The “no shelf mark” smart list collects them.' },

      { kind: 'h', text: 'Rooms', anchor: 'rooms' },
      { kind: 'p', text:
        'A room is the space the shelves are in — a reading room, a back store, a chapel library. It is worth recording when the library occupies more than one space, because a shelf mark alone then does not say which building to walk to.' },
      { kind: 'p', text:
        'There are no rooms defined here yet, and all 12,675 copies are unassigned. If everything is in one space, that is the correct state and there is nothing to do.' },
      { kind: 'rule', text:
        'Renaming a room moves every book in it. Deleting one is refused while any book is still there, including a book in the trash — the trash still points at the room.' },

      { kind: 'h', text: 'Call numbers', anchor: 'call-numbers' },
      { kind: 'p', text:
        'The call number is the location as another library would understand it, and it is the field that travels: it is exported with the holdings, so a library that receives these records knows how they are arranged.' },
      { kind: 'fields', rows: [
        { fact: 'callNumber', note: 'Exported with the copy. Usually the classification plus a cutter for the author.' },
        { fact: 'shelfCode', note: 'Local. Not exported as a classification.' }
      ] },
      { kind: 'p', text:
        'No copy here has one. That is worth changing only on the records you actually share; for internal use the shelf mark already does the job.' },
      { kind: 'see', chapter: 'classification', anchor: 'ddc', text:
        'A call number is most useful together with a standard class number.' }
    ]
  },

  barcodes: {
    id: 'barcodes',
    title: 'Barcodes and labels',
    summary:
      'A number a scanner can read, so lending a book takes one beep instead of a search.',
    blocks: [
      { kind: 'h', text: 'What a barcode is for', anchor: 'why-barcodes' },
      { kind: 'p', text:
        'It identifies one physical volume, not a publication — which is why it belongs to the copy. An ISBN says which book this is; a barcode says which of the library’s copies of it you are holding. That distinction is what lets loan history be per copy.' },
      { kind: 'fields', rows: [
        { fact: 'barcode', note: 'Unique across the whole catalogue. Exported with the holdings.' }
      ] },
      { kind: 'p', text:
        'No copy here has one yet, so every loan is currently found by searching. A handheld scanner types the number and presses Enter, and the scan box in Circulation is built for exactly that: it is the fastest path from a book in your hand to its record.' },

      { kind: 'h', text: 'Assigning them', anchor: 'assigning-barcodes' },
      { kind: 'p', text:
        'Barcodes are assigned in bulk rather than typed. The action works through the collection a few hundred copies at a time and can be stopped and resumed — running it twice does not renumber anything, because it only touches copies that have no barcode.' },
      { kind: 'steps', items: [
        'Run the assign-barcodes action from the library view.',
        'Print the labels for the copies that just got one.',
        'Stick them on. This is the slow part, and it is the only part software cannot do.'
      ] },
      { kind: 'tip', text:
        'You can also type a barcode by hand on one copy, which is what to do when a book already carries a number from a previous system. The catalogue refuses a number that is already on another copy rather than creating two volumes with one identity.' },
      { kind: 'auto', text:
        'Automatic numbers are allocated after the highest existing numeric one, and a hand-typed value that is not a number cannot disturb that sequence.' },

      { kind: 'h', text: 'Printing labels', anchor: 'printing-labels' },
      { kind: 'p', text:
        'A label carries the shelf mark, the barcode, and the volume as printed on the label field of the copy — which is why that field is separate from the volume number. “τ. Α΄” fits a spine; “Α΄” alone does not say what it counts.' },
      { kind: 'rule', text:
        'Print labels for a whole shelf at once, and stick them in the order they printed. A pile of labels in a different order from the pile of books is how a barcode ends up on the wrong volume.' },
      { kind: 'p', text:
        'The barcode symbology is Code 128, which is what library scanners expect, and every code carries a check character so a misread is detected rather than silently accepted.' }
    ]
  },

  'periodical-runs': {
    id: 'periodical-runs',
    title: 'Periodical runs',
    summary:
      'One title, many issues. Recording the run instead of 47 records.',
    blocks: [
      { kind: 'p', text:
        'ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ is catalogued here as 47 separate books. It is one periodical of which the library holds 47 issues. The difference is not tidiness: as 47 records it cannot be counted as a serial, its gaps cannot be seen, and a reader looking for the title finds 47 things that all look the same.' },
      { kind: 'see', chapter: 'identifiers', anchor: 'issn', text:
        'An ISSN on a record is the usual sign that this is what you are looking at.' },

      { kind: 'h', text: 'Recording a run', anchor: 'recording-a-run' },
      { kind: 'steps', items: [
        'Set the kind of publication on the record to periodical.',
        'Open “Record the run”.',
        'Add one line per unbroken stretch you hold: what the numbering is called, from which volume to which, and the years.',
        'Put what is missing from that stretch in its own field rather than in the numbers.'
      ] },
      { kind: 'fields', rows: [
        { fact: 'bibLevel', note: 'Periodical. Changes what the record exports as and what the statistics count.' },
        { fact: 'serialRun', note: 'The run itself. Exported as a textual holdings statement.' }
      ] },
      { kind: 'compare', good: 'One record, kind = periodical, run “τόμος 1-10 (1880-1889)”, missing “τ. 7”.',
        bad: 'Forty-seven records, one per issue.',
        why: 'The first says in one line what the second cannot say at all, and it is what a partner library receives when you send the record.' },
      { kind: 'auto', text:
        'The editor shows the statement your entry will produce as you type it, using the same code the exporter uses — so what you read is what another library gets.' },

      { kind: 'h', text: 'Gaps', anchor: 'gaps-in-a-run' },
      { kind: 'p', text:
        'A real gap statement is “τ. 7, 12-14”, and the field takes it as free text on purpose. Forcing it into a list of numbers would lose the qualification a librarian puts on it — “τ. 7 (ελλιπές)” is not the same claim as “τ. 7 λείπει”.' },
      { kind: 'rule', text:
        'The run says what you have. The gaps say what you know you are missing. Not knowing is a third state, and it is expressed by saying nothing.' },
      { kind: 'see', chapter: 'series-and-sets', anchor: 'missing-volumes', text:
        'A multi-part monograph is different: there the catalogue can work the gaps out from the volume numbers.' }
    ]
  },

  withdrawal: {
    id: 'withdrawal',
    title: 'Withdrawing a copy',
    summary:
      'A volume leaves the collection. Recording why is what makes the statistics true.',
    blocks: [
      { kind: 'h', text: 'Withdrawing', anchor: 'withdrawing-a-copy' },
      { kind: 'p', text:
        'A copy is withdrawn when the physical volume leaves the library: damaged beyond use, lost, given away, superseded. The record stays, and the other copies stay — only that volume goes.' },
      { kind: 'steps', items: [
        'Open the copies editor on the record.',
        'Press Withdraw on the copy that is leaving.',
        'Say why, in the field that appears.',
        'Save.'
      ] },
      { kind: 'rule', text:
        'A copy that is on loan or waiting on the hold shelf cannot be withdrawn. Take it back or cancel the hold first — otherwise the loan is stranded and the record of who has the book is lost.' },
      { kind: 'auto', text:
        'A withdrawn copy is not erased. It stays attached to the record with its reason and the date, which is what the statistics count and what lets a mistake be understood later.' },

      { kind: 'h', text: 'The reason', anchor: 'withdrawal-reasons' },
      { kind: 'p', text:
        'The statistics report groups withdrawals by reason. There are six withdrawn copies in this catalogue and all six are recorded as “unrecorded”, because until recently there was no field to write one in. Anything specific is better than that.' },
      { kind: 'list', items: [
        'φθορά — damaged beyond repair.',
        'απώλεια — lost, including a loan never returned.',
        'δωρεά — given away or transferred.',
        'αντικατάσταση — replaced by a better copy.',
        'διπλότυπο — a duplicate the library does not need.'
      ] },
      { kind: 'tip', text:
        'Use a short, consistent phrase rather than a sentence. The report groups by the exact text, so “φθορά” on twenty withdrawals is one line and twenty descriptions are twenty lines.' },
      { kind: 'p', text:
        'Withdrawing the last copy of a record is refused. If the library no longer holds the publication at all, delete the record — that is a different act, and it is reversible.' },
      { kind: 'see', chapter: 'trash-and-merge', anchor: 'the-trash', text:
        'What happens to a deleted record, and how to get it back.' }
    ]
  },

  'trash-and-merge': {
    id: 'trash-and-merge',
    title: 'Deleting, restoring and merging',
    summary:
      'Nothing is destroyed by accident. Two records that are one book become one record with two copies.',
    blocks: [
      { kind: 'h', text: 'The trash', anchor: 'the-trash' },
      { kind: 'p', text:
        'Deleting a record does not remove it. It goes to the trash with its copies, its loan history and everything else intact, and it stops appearing in searches and counts. Six records are there now.' },
      { kind: 'rule', text:
        'Delete a record when the library does not hold the publication. Withdraw a copy when one volume of it has gone. They are different acts with different consequences.' },

      { kind: 'h', text: 'Restoring', anchor: 'restoring' },
      { kind: 'p', text:
        'Restoring brings the record back exactly as it was, with the copies its deletion took down — and only those. A copy you had withdrawn beforehand stays withdrawn, because restoring the record is not meant to put a book back on a shelf it is not on.' },

      { kind: 'h', text: 'Purging', anchor: 'purging' },
      { kind: 'p', text:
        'Purging destroys a record permanently, along with its copies, its loan history and its links. There is no way back. It exists for records that should never have existed — a test entry, a scanning accident — and not as a tidier form of deleting.' },
      { kind: 'rule', text:
        'If you are unsure whether something should be purged, it should not be purged. The trash costs nothing to leave alone.' },

      { kind: 'h', text: 'Merging duplicates', anchor: 'merging-duplicates' },
      { kind: 'p', text:
        'When the same book has been catalogued twice, merging folds one record into the other: the copies move across as additional copies, the loan history follows, and the record that loses keeps a forwarding note saying where it went.' },
      { kind: 'steps', items: [
        'Open the duplicate finder. It groups records that match strictly — same title, same author, same identifier.',
        'Look at both records before merging. Two printings of one work are NOT duplicates, and neither are two volumes of a set.',
        'Choose which record to keep. Prefer the fuller one; its values win where the two disagree.',
        'Merge. The other record goes to the trash with a note pointing at the keeper.'
      ] },
      { kind: 'compare', good: 'Two records for the same 1987 printing → merge into one record with two copies.',
        bad: 'A 1955 edition and a 1987 edition → merge.',
        why: 'Those are two publications. Merging them loses one of the two dates, and the library then appears to hold one book where it holds two.' },
      { kind: 'auto', text:
        'A merged-away record can be restored, and the trash marks it differently from an ordinary deletion — restoring it re-creates the duplicate you removed, and it comes back with a fresh empty copy because its own copies stayed with the keeper.' },
      { kind: 'see', chapter: 'consistency', anchor: 'consolidate-or-authority', text:
        'Two records for one book is a different problem from one name spelled two ways. Merging is for the first.' }
    ]
  },

  glossary: {
    id: 'glossary',
    title: 'Glossary',
    summary: 'The words this Handbook uses, and what they mean here.',
    blocks: [
      { kind: 'h', text: 'Terms', anchor: 'glossary-terms' },
      { kind: 'p', text:
        'Library vocabulary is largely unavoidable, because the standards are written in it. Where a plainer word exists, this Handbook uses the plainer one — but you will meet these in the interface and in anything you read elsewhere.' },
      { kind: 'list', items: [
        'Record — the description of a publication. One per publication, however many you own.',
        'Copy (item) — one physical object on a shelf, belonging to a record.',
        'Holdings — what the library actually has: the copies, and for a periodical the run of issues.',
        'Monograph — a publication that is complete in itself. Most books.',
        'Serial (periodical) — a publication that keeps arriving.',
        'Authority / heading — one controlled form of a name or subject, with its variant forms recorded beside it.',
        'Variant — another form of the same name. Searched, never displayed in place of the record’s own text.',
        'Relator — the code saying what a person did: author, editor, translator, illustrator.',
        'Shelf mark — where a copy stands. Local to this library.',
        'Call number — the classification-based location, exported to other libraries.',
        'Dewey (DDC) — a standard subject classification. Sits alongside the shelf mark; it does not replace it.',
        'MARC 21 — the format libraries use to exchange records.',
        'Dublin Core — a much smaller metadata set, used by harvesters.',
        'ISBD — the rules for the areas of a description and their punctuation.',
        'EDTF — the date syntax for uncertain and approximate dates.',
        'ISIL — this library’s own standard identifier.',
        'ISSN / ISBN — the standard numbers for a periodical and for a book.',
        'Withdrawal — removing a copy from the collection. Counted in the statistics, with a reason.',
        'Hold — a reader’s place in the queue for a title all of whose copies are out.'
      ] },
      { kind: 'see', chapter: 'what-a-catalogue-is-for', anchor: 'record-vs-copy', text:
        'If you read only one entry above, read “record” and “copy”.' }
    ]
  }
};

export default pack;
