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
      { kind: 'see', chapter: 'what-a-catalogue-is-for', anchor: 'record-vs-copy', text:
        'Size belongs to the publication; where an oversized volume actually stands belongs to the copy.' }
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
      { kind: 'see', chapter: 'what-a-catalogue-is-for', anchor: 'record-vs-copy', text:
        'A note about one physical volume belongs to the copy, which is a different object from the record.' }
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
