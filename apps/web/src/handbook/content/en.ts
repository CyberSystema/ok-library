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
