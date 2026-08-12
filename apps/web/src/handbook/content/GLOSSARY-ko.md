# 사서 편람 — 한국어 용어집 (GLOSSARY-ko)

The single terminology authority for the Korean Handbook (ko.ts, 29 chapters).
Reconciled from three independent proposals. Where the proposals disagreed, the
decision and the rejected alternative are both recorded, so a later editor does
not silently reopen a settled question.

**Two rules govern every choice below.**

1. A term that **cannot collide** beats a term that is marginally more idiomatic.
   This Handbook has been mistranslated twice by collision (Greek σειρά /
   παραλαμβάνω / διαγραφή, Russian комплект / изъятие / экземпляр) and never once
   by stiffness.
2. **Formal correctness wins for anything that leaves the building** (a MARC
   field, an exported record, a statistics row); **the working librarian's word
   wins for a daily instruction** (a button, a step, a screen the reader is
   looking at while reading).

Where those two rules pull apart, the term is split into two entries — a formal
one for the exported/standard sense and a plain one for the instruction — and the
glossary says which chapter uses which. That is deliberate, not indecision.

---

## 0. Banned words

Every collision in this pack is enforced by an **absence**. A later editor who
does not know why a word is missing will reintroduce it, so the bans are stated
first and belong at the top of `ko.ts` as a comment.

| Banned | Why | Use instead |
| --- | --- | --- |
| 사본 | Means a reproduction or photocopy. 「사본 3권」 would say the library owns three photocopies. | 소장본 (physical volume), 개별자료 (the item layer) |
| 서명 | The standard cataloguing word for TITLE **and** the everyday word for a signature. This catalogue has both. Given to neither sense. | 표제 (title), 자필 (signature) |
| 폐기 | Would happily name both withdrawing a volume and retiring a heading — exactly the Russian изъятие failure. | 제적 (a copy), 표목 폐지 (a heading), 처분 (physically discarding an object, if ever needed) |
| 복본 | Legitimate Korean for an additional copy, but one syllable from 중복 (the duplicate-record error), and the pack does not need it. | 추가 소장본, 「같은 판의 소장본 두 권」 |
| 시리즈 | A loanword vague enough to slide between 총서, 다권본 and 소장권호 — collision (a) and (l) in one word. | 총서 / 다권본 / 소장권호, each in its own place |
| 세트 | Same risk, spoken register. Survives only inside the quoted screen label 「다권 세트」. | 다권본 |
| 전자(轉字) | One syllable from 전사 (transcription), which the pack uses constantly for a different act. | 로마자 표기 |
| 갱신 | Reserved by the import screens for "an existing record was updated". A renewals paragraph beside an import paragraph would collide. | 연장 / 대출 연장 |
| 공유 | Suggests handing a file to a named colleague. The act is making the catalogue publicly readable. | 공개 / 목록 공개 |
| 기록 (for a record) | Means a log entry; this system already has 활동 기록 and 대출 이력. | 레코드 / 서지 레코드 |
| 카탈로그 | The loanword for a sales catalogue. | 목록 |
| 메모 (as the term) | A private jotting. Quoted where a screen says 「메모」, never as the concept. | 주기 / 주기사항 |
| 수확 | A literal calque of "harvest". | 수집 / 수집기 |
| 시뮬레이션, 테스트, 모의 실행 | Three names for one thing in the current UI. | 시험 실행 |
| 방 | A room in a house. | 서가실 (the entity), 소장처 (the concept) |
| 인수 · 인계 · 받다 · 수취 · 회수 · 픽업 | Each can name either direction of a loan transaction. Collision (b). | 반납 처리 (library receives) / 수령 (reader collects) |
| 통합 | Taken by KORMARC 통합서지용. | 병합 |
| 서가기호 without its mnemonic | Korean practice sometimes uses it loosely for 청구기호 — the precise trap of collision (f). | 서가기호 **plus** the mnemonic clause (see collision f) |

Cheapest build check, if `check_handbook.mjs` is to carry one: grep `ko.ts` for
**사본 · 서명 · 폐기 · 복본 · 시리즈 · 전자 · 수확 · 카탈로그**. Any hit is a bug.

---

## 1. Register

### Statements — 합니다체

Formal written Korean throughout: `-습니다 / -ㅂ니다`, `-입니다` for definitions.
Full sentences; the subject is dropped where Korean prefers it.

- No 해요체 and no 한다체 in the Handbook's own voice. The one exception is a rule
  quoted directly from 『한국목록규칙 제4판』, which keeps its own 한다체
  (…그대로 전사한다) and is marked as a quotation by the 겹낫표 citation.
- Terse to match the English: one clause where the English has one clause. No
  padding (다양한, 효율적으로, 매우, 아주), no hedging (~라고 할 수 있습니다,
  ~되겠습니다), no rhetorical questions, no exclamation marks, no emoji, no idiom.
- Glossary and list entries may open as a noun phrase, but any explanatory clause
  after it is a full 합니다체 sentence.
- **No `-어 주다` benefactive when the subject is the system, a standard or the
  catalogue.** 「표준은 논쟁도 정리합니다」, 「시스템이 대신 말합니다」,
  「이 목록 자체가 증명합니다」 — not 정리해 줍니다 / 말해 줍니다 / 증명해 줍니다.
  The benefactive gives the manual a helpful-assistant warmth the English does not
  have, and it was the single most repeated register fault in the foundations
  review. It is allowed only where the giving is literally the point and the plain
  form would misread (「이 편람은 그것이 어느 표준인지 알려 줍니다」). Where a plain
  form reads badly, rewrite the verb rather than restore the benefactive:
  「일을 가장 많이 덜어 주는 구분」 → 「일을 가장 많이 줄이는 구분」.
- Rules (원칙 blocks) are stated as facts or obligations, not commands:
  `-합니다` / `-해야 합니다`.

### Instructions — 하십시오체

Every instruction the librarian is to carry out takes `-하십시오`, matching the
formal plural imperative of the Greek and Russian:

- 표제면에 나타난 대로 그대로 전사하십시오.
- 먼저 반납 처리를 하십시오.
- 시험 실행으로 먼저 확인하십시오.

Never `-하세요` (too warm for a manual), never `-하라` / `-할 것` (military-terse),
never a bare `-하기` as a heading verb. Prohibitions are `-하지 마십시오`
(사본이라는 말은 쓰지 마십시오) or, where it is a rule rather than an order,
`-하지 않습니다` / `-해서는 안 됩니다`. Conditions precede the imperative:
「ISBN이 없으면 비워 두십시오.」

A destructive action takes the imperative plus exactly one 합니다체 consequence
sentence in the same block: 「영구 삭제하십시오. 영구 삭제한 뒤에는 복원할 수
없습니다.」

**Quoted UI strings keep their own register.** The interface is written in
`~하세요`, so a verbatim label or toast carries 하세요 into a 하십시오 pack. That is
intended: a quoted label is evidence of what the screen says. Do not "correct" it.

### Numbers and spacing

- Comma as thousands separator: **12,528**. Not the Russian 12 500 spacing, not
  1만 2528. The exact figure is used wherever the claim is exact — the Greek
  review caught a rounded 12.700 standing in for it.
- **A translator does not correct a figure the English states.** Where the English
  block itself hedges (`about 12,500 records`), the Korean renders the hedge
  (「약 12,500건」) and the correction is raised against the English source, which is
  where all four languages read it from. The foundations review proposed a
  corrected figure in Korean alone; that was declined, because a per-language
  repair of a shared fact desynchronises the pack and teaches every later
  translator to overrule the source. Exact figures in the Korean are exact only
  because the English is.
- **And the source itself has to be measured, not remembered.** The figure this
  section taught as exact was 12,675, and it was never the size of this
  collection: it counted soft-deleted test rows alongside the real ones. The
  catalogue holds 12,528 records — the April import, every one of them still live
  — which is the number the rest of the repository had all along. Nine counts
  moved with it (ISBNs 602→559, series 12,597→12,513, category labels
  4,216→4,097, records with no author 3,768→3,690, no publisher 2,962→2,957,
  extent statements 11,717→11,571, author strings 5,427→5,395, editors
  1,195→1,156 in 623→607 spellings, failing check digits twenty→eighteen). The
  figures that reproduced exactly — 8,117 · 13 · 73 · 492 · 398 — were the ones
  no test row could contribute to, which is how the cause was identified. A
  count is quoted only from a query that excludes what the audit wrote.
- No space before a counter: 12,528종 · 3,690건 · 3쇄 · 2책 · 21cm.
- Every number states its unit: 건 (records/transactions), 종 (titles),
  책 (volumes, statistics **only** — see §4k), 권 (volumes, prose), 명 (readers),
  호 (issues). A record is counted in 건, never in 개: 「별개의 두 레코드」,
  「모두 두 건 만듭니다」.
- Sino-Korean library compounds are written **closed**: 서가기호, 청구기호,
  소장권호, 총서사항, 발행사항, 형태사항, 주제명표목, 전거레코드 → but note that
  where the interface's own label spaces it (「서가 기호」, 「서지 레코드」), the
  quoted label keeps the screen's spacing. Phrases stay **open**: 제적 사유,
  이용자 구분, 대출 규칙, 사용자 지정 속성, 개인정보 파기, 시험 실행.
- A loanword head takes a space: 서지 레코드, 전거 레코드, 스마트 목록, 패싯 탐색.
- Thin space between a Hangul word and an adjacent Latin token: KORMARC 필드,
  MARC 866, DDC 기호.

---

## 2. Quoting and typography

Three marks, one job each, everywhere in the pack.

| Mark | Job | Example |
| --- | --- | --- |
| “ ” | A stored catalogue value, or any literal string the librarian types | “Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ”, “15-003”, “270 ΚΛΗ”, “ΑΔΕΛΦΟΤΗΣ ΘΕΟΛΟΓΩΝ &lt;&lt;Ο ΣΩΤΗΡ&gt;&gt;” |
| 「 」 | An interface object: screen, tab, button, field label, menu item | 「소장본」 탭, 「제적」 버튼, 「서가 기호」 항목, 「영구 삭제」 |
| 『 』 | A cited publication or standard document | 『한국목록규칙 제4판』, 『KORMARC 통합서지용』 |

`‘ ’` for a quote inside a quote. **Not used:** « » (the Greek and Russian
convention — importing it would also make the Handbook's punctuation
indistinguishable from the data, which contains « », ‹ › and the import artefact
&lt;&lt;Ο ΣΩΤΗΡ&gt;&gt;), straight `"` and `'`, and 〈 〉.

Rationale for the “ ” / 「 」 split rather than 낫표 everywhere: most sentences in
this Handbook say *type this value into that field*, and the reader can see which
is which without parsing. The existing Korean interface already uses “ ” for
values, so the pack is continuous with the screen.

- Greek and Latin script inside a quotation stays **exactly as stored** — upper
  case, accents, and the &lt;&lt;&gt;&gt; the import made of Greek quotation marks.
- Latin standard names stay unquoted and in Latin script: MARC 21, KORMARC, KCR4,
  Dublin Core, ISBD, EDTF, ISO 843, ISO 2789, ISO 15511, SRU, OAI-PMH, Code 128.
- **Particles after a foreign string may not be guessed.** 은/는 and 이/가 cannot
  be chosen by sound for a string the reader will not pronounce. Write
  「“Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ”의 경우」, or the doubled form the interface already uses
  (“{title}”이(가)), or restructure the sentence.

---

## 3. Glossary

### 3.1 Records, copies, duplicates

| English | Korean | Notes |
| --- | --- | --- |
| catalogue (the thing itself) | 목록 | The library word. 목록 unqualified always means the catalogue, which is why result lists are 검색 결과, a list of copies is 소장본 일람, and an autocomplete drop-down is 제안 (see the next row). Rejected: 카탈로그 (a sales catalogue; still in the import toasts). |
| autocomplete suggestions (the drop-down a field offers while you type) | 제안 (동사는 제안하다) | Added after the foundations review, which found the pack's only 목록 collision here: 「항목이 제시하는 목록을 보십시오. 제시되는 것은 이미 목록에 있는 표기입니다」 made 목록 mean the drop-down and then the catalogue one clause apart. The settled wording is 「몇 글자를 입력하고 항목이 무엇을 제안하는지 보십시오. 제안되는 것은 이미 목록에 있는 표기입니다.」 and the step that follows says 제안된 표기. Rejected: 자동완성 목록 / 제시 목록 (both put 목록 on a non-catalogue list), 후보 (reads as a shortlist the librarian must adjudicate), 드롭다운. |
| record (bibliographic record) | 서지 레코드 (약칭 레코드) | KORMARC's own unit of description; carries no physical connotation, so 「하나의 서지 레코드에 소장본이 여러 권 딸립니다」 stays sayable. 레코드 alone after first mention in a chapter — and "first mention" means the chapter's first block of any kind, including a `rule` or the summary, which is where both foundations chapters had gone bare (「약 12,700건의 레코드」, 「두 레코드가 같은 것을 뜻한다면」). The pairing is what later lets the reader see 서지 레코드 and 전거 레코드 as two record types in one system, so the headings chapter arrives with an anchor instead of a new noun. Rejected: 기록 / 서지기록 — 기록 is a log entry, and this system has 활동 기록 and 대출 이력. |
| copy (one physical volume on a shelf) | 소장본 | The unit the library owns, shelves, lends and withdraws. Chosen over the formally exact 개별자료 because this word appears in almost every instruction; chosen over 사본 because 사본 means a photocopy. Counter in prose: 소장본 두 권. Rejected: 사본 (banned), 낱권, 등록본. |
| item layer (the copy as a data structure / MARC holdings) | 개별자료 | The IFLA LRM term (저작·표현형·구현형·개별자료) and KORMARC 소장정보용 876–878. Used **only** where the chapter is about the items layer as structure, or about what a partner library receives in MARC 852. Everywhere else the volume is a 소장본. |
| copy number | 소장본 번호 | Matches the screen's 「{n}번 소장본」; derived from list order, not typed. The KORMARC caption for MARC 852 $t is 복본기호 — name it once, in the exchange chapter, and nowhere else. Rejected: 복본기호 as the pack's term (복본 is banned), 사본 번호. |
| copy type (the loan-rule dimension) | 소장본 종류 | The dimension the loan rules match on. Rejected: 자료 종류 (collides with the ISO 2789 자료 유형 breakdown), 사본 종류 (the current label — must change). |
| additional copy ("we hold three copies") | 추가 소장본 / 「같은 판의 소장본 두 권」 | Deliberately a phrase, not a word. 복본 is the standard Korean term and is banned here only because it sits one syllable from 중복 and the pack has no need of it: 종/판 already carry the bibliographic sense and 소장본 the physical one. Rejected: 복본, 중복본. |
| duplicate (one publication catalogued twice — what the merge tool fixes) | 중복 레코드 | Always keep 레코드 attached: bare 중복 could be read as a second copy, which is normal and desirable. Rejected: 복본 (would say the library owns two copies — the opposite of the problem), 이중등록. |
| merge (two records into one) | 병합 | The interface's word (병합됨 badge). Rejected: 통합 (taken by KORMARC 통합서지용), 합치기. |
| trash | 휴지통 | A reversible holding area. A record in the 휴지통 still exists. |
| restore (from the trash) | 복원 | Reserved for the trash, so the backup chapter's 복구 stays a different act. Trap the chapter must state: restoring a merged record recreates the duplicate. |
| recovery (from a backup file) | 복구 | Named as its own entry so 복원 and 복구 are never interchangeable: 복원 = 휴지통에서 되살림, 복구 = 백업 파일에서 되살림. |
| deletion (of a record) | 레코드 삭제 | Reversible: it goes to the 휴지통. Keep 레코드 attached in any sentence where 개인정보 파기 or 제적 is nearby. Never touches a volume (제적) or personal data (파기). |
| purge (irreversible removal from the trash) | 영구 삭제 | Built on 삭제 on purpose — it is the same act at greater depth, and 영구 warns that 복원 is gone. Rejected: 파기 (reserved for personal data), 완전 삭제, 소거. |
| needs review (the flag) | 검토 필요 | Quoted from the smart-list rail; identical wherever the flag is named. |

### 3.2 What kind of publication

| English | Korean | Notes |
| --- | --- | --- |
| monograph | 단행본 | 단행본 in running prose; 단행자료 only where the pack names the value of 서지 수준. Rejected: 모노그래프. |
| serial / periodical | 연속간행물 | One Korean word for both English words, on purpose: the distinction the chapters draw is 단행본 vs 연속간행물. 정기간행물 is glossed once in this glossary as the everyday synonym and then never used, so the pack cannot drift into two names for one bibliographic level. Rejected: 정기간행물, 잡지, 시리즈. |
| kind of publication (monograph vs serial) | 서지 수준 | Exactly MARC leader/07, bibliographic level. Heavier than 자료 유형, and necessary: 자료 유형 is spent on the ISO 2789 material breakdown, and reusing it would collide in the statistics chapter. Values: 단행자료 / 연속간행물. Rejected: 자료 종류, 발행 형태. |
| material type / document category (ISO 2789) | 자료 유형 | leader/06 and the report's 「자료 유형별」 breakdown: 문자자료, 지도자료, 녹음자료, 필사본. Recorded here only to keep it apart from 서지 수준 — conflating them is the Korean equivalent of the Greek είδος / κατηγορία τεκμηρίου drift. |
| issue (one number of a periodical) | 호 | 제12호. 권 is the volume, 호 the issue, 권호 the two together. Native three-way, no gloss needed. |
| volume-and-issue designation | 권호 | The pair a periodical is numbered by; needed so 소장권호 reads as a compound the librarian already knows. |
| run (the issues we hold) | 소장권호 — 화면 라벨은 「소장 범위」 | The most dangerous term in the pack: it broke both Greek and Russian. 소장권호 is KORMARC 소장정보용 863–866 and contains 소장, so 「소장권호를 기록하십시오」 cannot invert into "record its series". The serials editor is currently labelled 「소장 범위」 — quote that label where the reader is sent to the control, and recommend renaming it. Rejected: 소장 범위 as the term (vague enough to reopen collision a), 총서, 시리즈, 세트. |
| holdings statement (the exported line, MARC 866) | 소장사항 | The sentence a partner library receives, as distinct from 소장권호, which is what we hold. Gaps travel in $z, not folded into $a. |
| gap / missing issue | 결호 | The standard serials word and already the interface's. Belongs to 연속간행물 only. Rejected: 누락호, 공백. |
| missing volume (of a multi-part work) | 결권 | Belongs to 다권본 only. Korean has two exact words where Greek and Russian had to say the same phrase twice; never use 결호 for a set or 결권 for a periodical. |
| series (a publisher's series) | 총서 | KCR4 총서사항 / MARC 490·830. ΕΛΛΗΝΙΚΗ ΠΑΤΡΟΛΟΓΙΑ is a 총서. Series number = 총서번호 (490 $v). Rejected: 시리즈 (banned), 문고 (one kind of 총서). |
| series statement (the field) | 총서사항 | Names the field, when telling the librarian where to type. |
| multi-part work / set | 다권본 | KCR4's term for one work published in several volumes — structurally distinct from 총서 (many publications under one series title). Its parts are 권; its absences are 결권. The grouping view is quoted as 「다권 세트」 because that is the screen's label, never as the concept's name. Rejected: 세트, 전집 (narrower). |
| collected works (an ΑΠΑΝΤΑ-type set) | 전집 | Permitted only where the publication genuinely is the collected or complete works of one author or corpus (ΕΠΕ, a Patrologia). A 전집 is one kind of 다권본, never a synonym for it, never a 총서, never a periodical's run. If in doubt, write 다권본. |
| volume (a division of a work) | 권 | 제3권. Never a statistics unit — see 책. |
| volume designation (the field) | 권차 | Already the interface label and KORMARC's own word; it holds “Α΄”, “τ. 3”, “ΜΕΡΟΣ Β΄” exactly as typed. Keeps 권 free for the volume itself. |
| edition | 판 | 초판, 재판, 제2판, 개정판. Printed on every Korean copyright page, so the librarian has read it a thousand times. Rejected: 에디션. |
| edition statement (the field) | 판사항 | KCR4 판사항 / MARC 250. |
| printing / impression | 쇄 | Korean has the exact word Russian lacked: 「1955년 초판의 1987년 3쇄」 is ordinary Korean, printed on the 판권지. Rejected: 인쇄 (the process, and it also reads as "a print-out" in an interface — the trap that produced the Greek εκτύπωση/ανατύπωση error), 중쇄 (a reprinting event, not the identified impression), 재판 (means a new edition — the opposite). |
| print run size (how many copies were printed) | 발행 부수 | The other half of the 쇄 settlement: 쇄 is which printing, 발행 부수 is how many were printed. This is the concept Russian тираж actually names. Rejected: 부수 alone, 쇄수 (how many impressions). |

### 3.3 Titles

| English | Korean | Notes |
| --- | --- | --- |
| title (the concept and the family) | 표제 | The decision of this pack. KCR4 supplies the whole family — 표제, 본표제, 대등표제, 표제관련정보, 표제면 — so nothing is lost, and 서명 is removed from the pack entirely rather than left to mean one of its two senses. Cost, stated plainly: several KORMARC captions read 서명 (246 여러 형태의 서명, 통일서명), so a librarian consulting KORMARC documentation meets a word this Handbook does not use. One cross-reference line in this glossary pays for it: **KORMARC 필드 이름에 나오는 “서명”은 표제를 뜻합니다.** Rejected: 서명 (collision g), 제목 as the cataloguing unit. |
| title proper | 본표제 | What is on the 표제면, transcribed. Used where the chapter distinguishes it from 부제 and 대등표제. Rejected: 본서명, 정표제. |
| title — the form field as labelled | 「제목」 | The screen says 「제목」 and the Handbook quotes screens as they are. Write 표제/본표제 when the distinction matters, 「제목」 when telling the reader where to click. |
| subtitle / other title information | 부제 | ISBD/KCR4's name is 표제관련정보 (MARC 245 $b) and is stated once here; the pack uses 부제 in prose because 본표제 vs 표제관련정보 are too similar to skim apart, while 본표제 vs 부제 differ at the front of the word. A metadata specialist would prefer 표제관련정보 throughout — logged as a known departure. |
| parallel title (the other-script title) | 대등표제 | KCR4 대등표제; the Phase B parallel-script fields, MARC 880. A 대등표제 is printed on the 표제면 by the publisher — it is not a 로마자 표기 the library produced. Rejected: 병렬표제, 병기 표제. |
| title page | 표제면 | KCR4's term, and the source of 전사: 「표제면에서 본표제를 그대로 전사하십시오」 is one consistent family. Rejected: 표제지 (also current, but 면 matches the KCR4 wording), 속표지 (a physical part). |
| non-filing characters | 배열 제외 문자 (수치는 배열 제외 문자수) | MARC 245 second indicator: the leading article that must not sort. For this catalogue that is Greek “Η ”, “Ο ”, “ΤΟ ”. The term says what it does, which matters because the librarian is typing a digit. Rejected: 비배열 문자, 불용문자 (reads as "forbidden"), 관사 (names only one cause). |
| title as a COUNTING unit (ISO 2789) | 종 (집계는 종수) | 「12,528종」. A counter, never the word for the title text, so there is no route back into 표제. Also the clean way to say two publications: 두 종. Rejected: 서명 수 (the current statistics label — it reads as "number of signatures"), 제목 수, 표제 수. |
| volume as a COUNTING unit (ISO 2789) | 책 (집계는 책수) | 「N책」 **in a statistics context only**. Rule that protects it, corrected after the foundations review: 책 appears only in a statistics row or a sentence about one (소장 책수, 「12,675종 · N책」), never as the ordinary word for a book (that is 도서, or 소장본 for the object) — and never as a prose counter of volumes, which is 권. The earlier wording ("only with a numeral or as 책수") licensed 「161책을 차지하는 Patrologia Graeca」 and 「163책 가운데 154책」 in the consistency chapter, where the sentence is prose and the unit must be 권. If the sentence is not reporting a statistic, count in 권. Rejected: 권수 — it reads as "which volume number". |

### 3.4 Headings, authorities, subjects, classification

| English | Korean | Notes |
| --- | --- | --- |
| heading | 표목 | The Korean cataloguing word for a controlled form used as an entry point, and already the interface's (전거 표목). Rejected: 헤딩, 제목, 기본표목 (KCR4 abolished main entry — do not revive it). |
| access point | 접근점 | Named once, in the headings chapter, as the standards-level concept that partner libraries and RDA-era systems use. Not a second running word for 표목. |
| authority record | 전거 레코드 | KORMARC 전거통제용. Parallel in shape to 서지 레코드, which helps the reader see two record types in one system. Rejected: 권위레코드 (a calque nobody uses). |
| authorized / preferred form (the form that displays) | 채택형 | The interface's label, and it states the act — this form was adopted. 전거표목 (KORMARC 1XX) is named once in the exchange chapter. Rejected: 전거형, 정형, 기본형. |
| variant form | 이형 (전체 형태는 이형 표기) | Searched, never displayed in place of the record's own text — exactly the Handbook's rule, and KORMARC 4XX's own word. Distinct from 오기, a plain mistake, which is what the consistency tool handles. Rejected: 변형 (suggests corruption), 별칭. |
| retiring a heading | 표목 폐지 | Resolution of collision (d) — see §4d. **Correction of fact:** two of the three proposals assumed a retired heading survives and keeps resolving searches, and chose 사용 중지 accordingly. It does not: `DELETE /api/authorities/:id` removes the heading and unlinks every record pointing at it, as the confirm dialog itself says. 폐지 (abolishing something that was in use) is therefore the accurate word, and it cannot be read as discarding an object. Chapters must state that it is irreversible and that editing preserves the links. Rejected: 표목 사용 중지 (understates an irreversible act), 표목 폐기 (폐기 banned), 표목 삭제 (collides with the reversible 레코드 삭제). |
| subject heading | 주제명표목 (약칭 주제명) | 국립중앙도서관 주제명표목표 is the controlled list; MARC 650. 주제명 in prose after first mention. Rejected: 주제어 (an uncontrolled keyword — the distinction the subjects chapter draws), 주제 표제. |
| classification | 분류 | The act and the scheme; the scheme is 분류법, the number 분류기호. Keeps "classify" and "the number you type" off one noun. |
| class number | 분류기호 | Never written bare in this pack: there are three 기호 (DDC 기호 · 청구기호 · 서가기호) and the qualifier is what keeps them apart. |
| shelf classification (local) | 자체 분류 (기호는 자체 분류기호) | `customFields.category_code`, MARC 09X — the block reserved for a library's own numbers. 자체 says in two syllables that it is not DDC and not shared, matching 자체 작성 in the authorities screen. The rail is quoted as 「카테고리」 where the screen says so. Rejected: 서가분류 (invites confusion with 서가기호), 별치기호 (a collection-location prefix — a different thing), 로컬 분류. |
| Dewey number | DDC 기호 | 듀이십진분류법(DDC) spelled out once per chapter, then DDC 기호. Always with the DDC qualifier. Rejected: bare 분류기호, 듀이 번호 (a classification is a 기호, not a 번호). |
| call number (exported — how another library would locate it) | 청구기호 | 분류기호 + 저자기호, MARC 852 $h, which is exactly what this system exports. The 청구 morpheme (to call for) carries the export sense, which is the structural protection against collision (f). Rejected: 소장기호, 등록기호, 서가기호. |
| cutter / author number | 저자기호 | The second half of a 청구기호; explains why a call number is more than a class number. |
| shelf mark (local — where the volume stands, “15-003”) | 서가기호 — 완전형 서가위치기호, 화면 라벨 「서가 기호」 | MARC 852 $c. The pack uses the interface's 서가기호 because the reader has it in front of them, and gives 서가위치기호 in this entry as the disambiguating full form — 위치 in the word is what makes it unmistakably physical. Bare 서가기호 is banned **without its mnemonic clause**, because Korean practice sometimes uses it loosely for 청구기호 and that looseness is what let the Russian glossary swap the two. See §4f. Rejected: 배가기호 (more distinct, but not the screen's label). |
| shelving (placing volumes in order) | 배가 | 배가 순서, 배가 위치. The morpheme behind MARC 852 $b's caption 배가처. Rejected: 진열 (retail display). |
| room | 서가실 — 개념은 소장처 | The entity and the screen: 서가실, the space that holds shelves (rooms.* and copies.room already say it). The concept "where it is held", and MARC 852 $b, is 소장처. 서가실 is this system's own coinage rather than standard Korean library vocabulary — accepted because it names exactly *a space holding shelves* without committing the library to 자료실 (a reading room) or 서고 (closed stacks). Fix 「방」 → 「서가실」 in detail.room and library.bulk.field.roomCode. Rejected: 방 (a room in a house), 자료실 / 서고 / 열람실 (each names one kind of space), 소장기관 (the holding institution — a different level). |
| holdings (what we own — the copies layer) | 소장 정보 (구어 소장 현황) | Which copies exist, where, in what condition. Neighbouring 소장권호 by design — a serial's run really is part of holdings — and no instruction turns on the pair. Rejected: 장서 (the stock as an aggregate — a different statistic; keep it for 장서에서 빠집니다), 소장 자료. |
| collection / stock (the aggregate) | 장서 | Used where the sentence is about the whole: 장서 기준일, 장서에서 빠집니다, 장서 제적. |
| barcode | 바코드 | Established; Code 128 stays Latin. Keep it separate from 등록번호: the barcode is what the scanner reads and may or may not be the accession number. Rejected: 막대부호. |
| accession number | 등록번호 | The per-volume number in the accession register, MARC 852 $p territory. Worth one sentence in the barcodes chapter, because a Korean librarian will assume the barcode *is* the 등록번호 unless the Handbook says whether it is. Rejected: 입수번호. |
| label (spine / shelf label) | 라벨 | Interface word; printed with QR and Code 128. |

### 3.5 Withdrawal, deletion, personal data

| English | Korean | Notes |
| --- | --- | --- |
| withdrawal (of a copy) | 제적 | 장서 제적 — striking the volume from the register. What ISO 2789 counts, what the interface already says, and countable with a reason. Shares no morpheme with 삭제, 파기 or 폐지. Rejected: 폐기 (banned — it is physical disposal, and it would happily also name heading retirement, which is the изъятие failure), 제거, 말소. |
| withdrawal reason | 제적 사유 | The report groups on the exact text, so the values are short fixed phrases. Korean equivalents of the five the English chapter lists (φθορά · απώλεια · δωρεά · αντικατάσταση · διπλότυπο): **파손 · 분실 · 양도 · 대체 · 중복 소장**. Offer these as what to type; a Korean librarian will type Korean. Rejected: 제적 이유, and 폐기 as a reason value (it would put a banned word into the data). |
| physically discarding an object | 처분 | Needed at most once, for what happens to the volume after 제적. Deliberately not 폐기, which is banned so nothing can slide between 제적 and 표목 폐지. |
| erasure of a reader's personal data | 개인정보 파기 | 파기 is the term 「개인정보 보호법」 itself uses (개인정보의 파기), so the chapter names its legal basis rather than describing it. Always with the 개인정보 qualifier; bare 파기 is banned so nothing slides between 영구 삭제 and 개인정보 파기. Rejected: 개인정보 삭제 (the collision itself — and the current button label), 익명화 (the mechanism, not the obligation). |
| anonymisation (the mechanism: the loans survive, the person is not identifiable) | 익명 처리 | Also statutory (익명처리 / 가명처리). Where the system keeps loan history for statistics and severs the identity, say 익명 처리 for the mechanism and 개인정보 파기 for the effect — both, once, in the same paragraph. Rejected: 비식별화 (older policy jargon). |
| activity log | 활동 기록 | The evidence that the library responded, which the data-protection chapter points at. Quote 「감사 로그」 where that is the heading. This is the one place 기록 is correct. |

### 3.6 Readers and circulation

| English | Korean | Notes |
| --- | --- | --- |
| reader / library user | 이용자 | ISO 2789's registered user and the interface's word; the subject of 대출, 예약, 연체 and of the personal-data chapter. Rejected: 회원 / 고객 (commercial), 독자 (a reader of a text), 사용자 (reserved for staff accounts, which the settings screen already uses it for). |
| borrower (the person currently holding a loan) | 대출자 | Permitted **only** where the sentence needs the role rather than the person — 「연체 자료의 대출자」. Not used in the readers chapter or the data-protection chapter, which must have one subject. `toast.borrowerRequired` should become 이용자. Rejected: 차용자, and 대출자 as a general synonym. |
| reader category | 이용자 구분 | Already the label in both the borrowers screen and the loan-rules table; 구분 avoids a third use of 유형/종류. The chapter's rule — the category on the reader must match the rule exactly — reads naturally with it. Rejected: 이용자 유형. |
| loan | 대출 | 대출/반납 is the pair every Korean circulation desk uses. Rejected: 차출. |
| loan rules (the policy table) | 대출 규칙 | The interface's word. Sets 대출 기간, 연장 횟수, 이용자 구분별 한도. Rejected: 대출 정책 (reads as strategy), 대출 규정 (used in one place — settle on 규칙). |
| lending out (the library hands the volume over) | 대출 처리 | The third moment, named so that collision (b) has three words and no shared verb. |
| check-in (the library receives the volume back) | 반납 처리 | 반(返) is the return itself, so direction is inside the word; 처리 marks the librarian's recording of it. 「먼저 반납 처리를 하십시오.」 — and `copies.onLoan` already says exactly that, so chapter and screen agree. Rejected: 수령 / 인수 / 받기 / 회수 — every one of them can name either direction, which is the Greek παραλαμβάνω failure. |
| due date | 반납예정일 | The Korean OPAC word. Derived by the 대출 규칙, never typed by hand, and the Handbook says so. Rejected: 만기일, 기한일. |
| hold / reservation | 예약 | The queue is 예약 대기열 and the position 예약 대기 순번. Rejected: 보류 (means suspended), 대기 alone. |
| hold shelf | 예약 서가 | Interface word. A copy on the 예약 서가 can neither be lent nor 제적 처리 되지 않습니다. |
| hold pickup (the reader collects the held volume) | 수령 (예약 자료 수령) | 수령 is the reader taking possession — the opposite direction from 반납, and lexically unrelated to it. 「예약 자료 수령 기한」 for the shelf-hold expiry. Rejected: 인수 (an 인수/인계 handover pair drifts toward the library side), 픽업, 찾아가기. |
| renewal (extending a loan) | 연장 (대출 연장) | 연장 = extend the period. Kept off 갱신, which the import screens use for "an existing record was updated". Rejected: 갱신, 재대출 (suggests a new loan). |
| overdue | 연체 | 연체 자료, 연체일수, 연체 3건. Distinct from 미반납, which merely states the volume is out. Rejected: 기한 초과. |

### 3.7 Description and cataloguing practice

| English | Korean | Notes |
| --- | --- | --- |
| cataloguing (the activity) | 목록 작업 | The work this Handbook is about; the verb phrase is 목록에 올리다 (「같은 판이 두 번 목록에 올라간 경우」 — not 같은 책이, which would break §3.3's own rule on 책). 편목(編目) is the professional term (수서·편목 is the desk this Handbook sits on) and is named once, in the opening chapter. Rejected: 편목 as the running term (formally better but not what the reader says), 정리 업무 (names a department), 카탈로깅. |
| cataloguing rules | 목록규칙 — 근거는 『한국목록규칙 제4판』(KCR4), 형식은 KORMARC | Naming KCR4 once, early, licenses every other choice in this pack. Cite it in 겹낫표 as a publication. Rejected: 목록법. |
| description (the ISBD areas) | 기술 | Used only where a standard is being named (ISBD 기술 요소, 기술 언어), never as a synonym for 전사. |
| transcription (copying the title page exactly as printed) | 전사 | KCR4's own principle (전사 원칙; 표제면에 나타난 대로 전사한다), so using the rules' verb makes the "do not tidy it" argument sound like the rule it is: 「표제면에 나타난 대로 그대로 전사하십시오.」 Safe only because 전자(轉字) is banned — say so in the pack's own notes. Rejected: 필사 (hand-copying), 그대로 기재 (true, but not the rule's word). |
| transliteration / romanization | 로마자 표기 | `titleRomanized` / `authorRomanized` are ISO 843 romanizations of Greek; MARC 880 on export. Rejected: 전자 (banned — one syllable from 전사; this is the Greek μεταγραφή/μεταγραμματισμός problem avoided by not using the near-homophone at all), 음역 (phonetic only), 번역. |
| imprint | 발행사항 | KCR4 발행사항 / MARC 260·264. Its parts are 발행지, 발행처, 발행연도 — one family matching the three fields the form asks for. Rejected: 출판사항. |
| publisher | 발행처 — 화면 라벨 「출판사」 | 발행처 covers a monastery, brotherhood or society as well as a commercial house, which this catalogue needs: much of it was issued by “ΑΔΕΛΦΟΤΗΣ ΘΕΟΛΟΓΩΝ &lt;&lt;Ο ΣΩΤΗΡ&gt;&gt;”. Quote 「출판사」 when sending the reader to the form. Rejected: 출판사 as the term (implies a commercial publisher). |
| place of publication | 발행지 | MARC 264 $a; `customFields.place_of_publication`. |
| date of publication | 발행연도 | MARC 264 $c; `dateEdtf`. 연도 because this catalogue records years and EDTF's uncertainty markers attach to the year: “1955?”, “[195X]”. Rejected: 출판일 (implies a full date). |
| physical description (the whole statement) | 형태사항 | The ISBD shape the extent field is transcribing: 면장수 : 삽화 ; 크기. |
| extent | 면장수 | MARC 300 $a, whose KORMARC caption is 면장수 또는 권책수 — which is exactly what this field must hold, since Phase A made extent free text that may read “156, [3] σ. : εικ. ; 21 εκ.” or “2 τ.”. Moderate confidence that 면장수 is the exact subfield wording; high confidence it is the right register, and 쪽수 is certainly wrong because it excludes leaves and volumes. Show a real value in the same sentence on first use in a chapter. Rejected: 쪽수 (pages only), 수량 (reads as bare "quantity"), 분량. |
| dimensions | 크기 | MARC 300 $c; height in cm, rounded up: 21cm. Rejected: 규격, 치수, 판형. |
| liturgical (the rite, its books and its texts) | 전례 (전례서 · 전례 본문) | One confessional register for the whole pack. This is a Greek Orthodox collection, so 전례 carries every sense the chapters need, and **예배 is not used** — the foundations chapter had 「전례서, 예배 본문」 in one list of three, which puts two Korean confessional registers side by side for one rite. Corrected to 「전례서, 전례 본문」. Rejected: 예배 (Protestant register), 미사 (Roman rite specifically), 성찬예배 (correct Korean Orthodox usage for the Divine Liturgy itself, but not a general adjective for service books). |
| note | 주기 (필드는 주기사항) | MARC 5XX 주기사항 — a cataloguing note, evidence and qualification, as opposed to a private memo. The record/copy distinction reads cleanly as 레코드 주기 / 소장본 주기. The screens say 「설명」 and 「이 소장본 메모」 — quote those, use 주기 for the concept, and recommend the labels follow. Rejected: 메모, 비고. |
| custom attribute | 사용자 지정 속성 | 속성 rather than 필드, because 필드 is taken by KORMARC 필드 and the exchange chapter's whole point is that a custom attribute is invisible to MARC while a real field is not. The interface has three names for this today; this is the dominant one. Rejected: 사용자 정의 필드, 사용자 정의 항목, 카탈로그 속성. |
| signature / autograph (a signed name in a book) | 자필 | 서명 is banned pack-wide rather than kept for this sense, because the reader's own KORMARC training — and this system's own screens — read 서명 as *title*. 자필 (in the person's own hand) cannot be misread. Stated cost: 서명본 is the Korean book-trade term for a signed copy and is being given up deliberately; the payoff is that a grep for 서명 in `ko.ts` becomes a valid build check. Rejected: 서명, 저자 서명본, 사인, 싸인. |
| signed copy (`signed_copy`) | 저자 자필 | 「저자 자필 있음」. Rejected: 저자 서명본, 사인본, 서명 사본. |
| signature notes (`signature_notes`) | 자필 관련 주기 | Built from 자필 + 주기, so it inherits both settled words and reads as what it is: a note recording whose hand, where. Rejected: 서명 관련 주기, 서명 메모. |

### 3.8 Exchange, protocols, statistics, interface

| English | Korean | Notes |
| --- | --- | --- |
| MARC tag | 표시기호 | KORMARC's word for the three-digit tag. Worth having even though tags live only in `facts.ts`: if the librarian must quote “880” to a partner library, they should hear it called what KORMARC calls it. Rejected: 태그. |
| MARC subfield code | 식별기호 | KORMARC's caption for $a, $b. A librarian reading MARC documentation meets 식별기호, not 서브필드. Rejected: 서브필드. |
| MARC indicator | 지시기호 | KORMARC's own word, and the field the non-filing count sits in (245 제2지시기호). Rejected: 인디케이터. |
| language code (ISO 639-2/B) | 언어부호 (세 글자) | KORMARC's own caption for 041, and 부호 keeps it clear of the four 기호 the pack already spends (표시기호 · 식별기호 · 지시기호 · 분류기호). The codes are alphabetic — gre, rus, eng — so they are **세 글자**, never 세 자리, which counts digit positions and misdescribes what the librarian sees on export. Rejected: 언어 기호 (ad-hoc, and a fifth 기호), 언어 코드. Note that ISIL keeps 도서관 식별기호 as its fixed first-mention gloss: that value really is an identifier for a body, not a coded value from a list. |
| value consistency (the tool that overwrites one stored spelling with another) | 「값 일관성」 | The heading on the settings screen (`settings.vc.heading`), so that is what the Handbook quotes when it sends the reader to the control. Do **not** write 「표기 일관성」, which only `authorities.vsConsistency` says and which reads as a tool about forms of a name — 표기 is already spent on a spelling of a name (네 가지 표기, 이형 표기) and on 로마자 표기, while the tool in fact rewrites stored values of any field. Upstream, the English has the same split (the blurb says “Spelling consistency”, the heading says “Value consistency”); the Korean chapters follow the heading in both languages' interest. See the sweep item in §5.2. |
| export | 내보내기 | Interface word, symmetrical with 가져오기: 「MARC 내보내기」, 「스프레드시트 내보내기」. Rejected: 반출, 추출, 익스포트. |
| import | 가져오기 | Interface word: 「MARCXML 가져오기」. The authorities screen's stored source value 「반입」 is quoted as data; the action is always 가져오기. Rejected: 반입, 임포트. |
| dry run | 시험 실행 | Two of three proposals and the MARC screen's own wording; the point is that nothing is written, which 시험 conveys. Because 시험 can also read as "try running it", every first mention adds the consequence: 「아무것도 저장되지 않습니다.」 Rejected: 시뮬레이션, 테스트 (both current, in different screens), 모의 실행, 드라이런. |
| harvesting (OAI-PMH) | 수집 (수집기; 첫 언급은 메타데이터 수집) | The standard Korean term, and the sharing screen already calls the client a 수집기. Distinct from 가져오기: 가져오기 is the librarian pulling a file in, 수집 is somebody else pulling from us — 「외부 수집기가 수집합니다.」 Rejected: 수확 / 수확기 (a crop calque, current in the MARC screen), 하베스팅, 채집. |
| sharing (opening SRU / OAI-PMH publicly) | 공개 (기능 이름은 목록 공개) | 공개 states what happens — the catalogue becomes publicly readable — while 공유 suggests handing a file to a named partner. Say 외부 공개 where the boundary being crossed is the point. Rejected: 공유 (banned), 개방. |
| backup | 백업 | The spreadsheet export is the 백업; the MARC export is not. Recovery from a backup is 복구, deliberately not 복원. Rejected: 예비 저장, 안전 사본 (contains a banned word). |
| smart list | 스마트 목록 | The screen's own label, and a 스마트 목록 is literally a saved view of the 목록. Accepted against the objection that 목록 means the catalogue: the protection is that no *other* list may be called 목록 — search results are 검색 결과, a record's copies are 소장본 일람, and a field's autocomplete is 제안. One consequence the foundations chapter had to apply: a named smart list is referred to **by its quoted label**, 「검토 필요」 목록, never descriptively (「빈 항목 목록」 was corrected to 「검토 필요」 목록), so every non-catalogue 목록 in the pack is either 스마트 목록 or a 「 」 label the reader can see on screen. Rejected: 저장 검색 (clearer but breaks the link to the screen), 자동 목록, 스마트 리스트. |
| facet browsing | 패싯 탐색 | 패싯 is current in Korean LIS writing and standard in discovery interfaces; 탐색 rather than 검색, because faceting narrows a result set rather than issuing a query. Facet counts must reproduce as filtered lists, and that promise is stated with 건수. Rejected: 분면 탐색 (accurate but now reads as classification theory), 측면 검색, 그룹 보기. |
| library code (ISIL) | ISIL(도서관 식별기호) | ISO 15511; MARC 003 and 852 $a. Latin acronym first with the Korean gloss in parentheses on first mention per chapter, ISIL alone thereafter — the librarian reads this token on partner correspondence, and the value is Latin (“GR-ThALK”). 기호 not 식별자, matching the value's form. Rejected: 국제 표준 도서관 식별자 (the current hint — correct but too long to repeat), 도서관 코드. |
| statistics | 통계 | 도서관 통계, following ISO 2789. Rows state their unit: 소장 종수 · 소장 책수 · 대출 건수 · 제적 건수. Rejected: 집계 (the act of totalling). |
| spreadsheet | 스프레드시트 | The import path accepts .xlsx and .csv from any tool, so the generic word is right. 엑셀 파일 is permitted exactly once, where the reader is being told which file to pick. Rejected: 엑셀 as the term, 표 계산 파일. |
| the Handbook / the course | 편람 (사서 편람) / 교육 과정 | Already the tab names. The two halves are named apart — reference and warm — exactly as intended. |

---

## 4. Collision resolutions

Each names **both** words, and each is written so a reviewer can check it by grep.

### a. series vs a periodical's run vs a multi-part set

Three words, no shared morpheme:

- **총서** = a publisher's series (statement 총서사항, MARC 490/830; ΕΛΛΗΝΙΚΗ ΠΑΤΡΟΛΟΓΙΑ).
- **소장권호** = the issues of a periodical we hold (MARC 863–866; the field is
  `serialHoldings`, exported as 소장사항 / 866 $a). The screen label is quoted as
  「소장 범위」.
- **다권본** = one monograph published in several volumes, with **전집** reserved
  for a collected-works corpus.

Because 소장권호 carries 소장 inside it, the sentence that broke Greek cannot break
here: "record its run" is 「이 연속간행물의 소장권호를 기록하십시오.」 and could not
be misread as recording a series. **시리즈 and 세트 are banned**, so no neutral
loanword exists to blur the three. Even the absences differ: a missing member is
**결호** in a run and **결권** in a 다권본. Enforcement: 총서 must not appear in the
periodical-runs chapter, and 소장권호 must not appear in the series-and-sets chapter.

### b. hold pickup vs check-in

Direction is built into each noun, and no verb is shared:

- **반납 처리** = the library receives the volume back (반(返) is the return itself;
  처리 marks the desk's recording of it).
- **수령** (예약 자료 수령) = the reader collects a held volume.
- **대출 처리** = the library hands it out — the third moment, named so that none
  of the three has to borrow another's word.

「먼저 반납 처리를 하십시오.」 / 「이용자가 예약 자료를 수령합니다.」 /
「예약 자료 수령 기한」. Banned in the circulation chapter: **인수, 인계, 받다,
수취, 회수, 픽업** — each can name either direction, which is the Greek
παραλαμβάνω failure. `copies.onLoan` already says 「먼저 반납 처리하세요」, so
chapter and screen agree.

### c. erasing personal data vs deleting the reader record

Two legal acts, two words, both grounded in 「개인정보 보호법」:

- **개인정보 파기** = erasing the reader's personal data. Always with the 개인정보
  qualifier; bare 파기 is banned. The mechanism, where loan counts survive and the
  identity is severed, is **익명 처리**.
- **이용자 레코드 삭제** = deleting the reader record. Reversible; it goes to the 휴지통.

The chapter can therefore state the distinction it exists to draw:
「이용자 레코드를 삭제하는 것과 개인정보를 파기하는 것은 다른 조치입니다.
파기하면 대출 건수는 익명 처리된 통계로 남습니다. 삭제하면 대출 기록이 함께
사라집니다.」 **삭제 never takes 개인정보 as its object anywhere in the pack**, and
the button currently labelled 「개인정보 삭제」 must be relabelled 「개인정보 파기」 —
otherwise the screen commits the collision the chapter exists to prevent.

### d. withdrawing a copy vs retiring a heading

- **제적** = withdrawing a copy (장서 제적: struck from the register, with a
  제적 사유, counted by ISO 2789). Reserved exclusively for copies.
- **표목 폐지** = retiring a heading. Abolishing something that was in use.

No morpheme in common, and neither borrows 삭제 or 파기. **폐기 is banned pack-wide**
precisely because it is the word that would happily do both jobs — that is the
Russian изъятие failure exactly. The heading term is 폐지 rather than 사용 중지
because the act is irreversible: the API DELETE removes the heading and unlinks
every record pointing at it, so a word implying survival would misdescribe it. The
current label 「폐기」 in the authorities screen must become 「폐지」, and 폐지 must
never appear in the withdrawal chapter nor 제적 in the headings chapter.

### e. two publications vs two copies of one publication

- Two publications = 「서로 다른 두 판」 or 「별개의 두 서지 레코드」, counted as
  **두 종**.
- Two copies of one publication = 「같은 판의 소장본 두 권」, or in record-model
  prose 「하나의 서지 레코드에 개별자료 두 건」.

**소장본** is reserved absolutely for a physical volume this library owns, exactly
as Russian reserves экземпляр, and the pack has **판** and **종** available for the
bibliographic sense, so it never needs to reach for a copy word. Hard rules:
소장본 may never take a modifier implying bibliographic difference (no 다른 소장본
meaning a different edition), and 종/판 may never count physical objects. The merge
warning states itself: 「1955년판과 1987년판은 두 종입니다. 병합하면 한 종으로
줄어듭니다.」

### f. call number vs shelf mark

- **청구기호** = the exported, classification-based call number (분류기호 +
  저자기호, MARC 852 $h) — how another library would locate the book.
- **서가기호** = the local shelf mark, where this volume physically stands
  (MARC 852 $c): “15-003”.

The words alone are not enough — Russian had two distinct words and still swapped
them one line apart — so the pack fixes **mnemonic clauses that must appear with
each term on first mention** in the classification and shelf-mark chapters:
「청구기호는 밖으로 내보내는 기호입니다.」 / 「서가기호는 이 도서관 서가에서 찾는
기호입니다.」

**Where the pack's first 서가기호 actually falls, and the sentence now in place.**
The first appearance is not in the classification chapter at all — it is in
`what-a-catalogue-is-for`, in the block that defines 소장본. §0 bans bare 서가기호
absolutely, so the mnemonic goes there too, and the foundations chapter now ends
that block with 「서가기호는 이 도서관 서가에서 그 소장본을 찾는 기호입니다.」 Later
chapters should repeat that sentence rather than paraphrase it: the reader meeting
청구기호 for the first time in the classification chapter must recognise the
서가기호 half as something already said, not as a competing definition. The 청구 (to call for) morpheme carries the export sense, and the full
form 서가위치기호 is available in the glossary where 위치 needs saying out loud.

Korean needs one sentence Greek and Russian did not: **Korean libraries normally
shelve by the 청구기호, and this library does not.** 「이 도서관은 청구기호로
배가하지 않습니다. 실제 위치는 서가기호입니다.」 Without it a Korean librarian
reads the two fields as one thing described twice and starts typing the shelf code
into the call number.

### g. 서명 — title or signature

**Neither.** 서명 is banned from the Korean pack entirely.

- Title takes **표제**: 본표제 · 부제 · 대등표제 · 표제면, with the form label
  quoted as 「제목」.
- Signature takes **자필**: the two custom fields become 「저자 자필」
  (`signed_copy`) and 「자필 관련 주기」 (`signature_notes`).

Two of the three proposals kept 서명 for the signature sense, on the grounds that
서명본 is the Korean book-trade term. Rejected, on the collision rule: a librarian
trained on KORMARC reads 서명 as *title* — and so does this system's own interface
today (`course.chapter.titles` = 「서명」, `authorities.kind.uniform_title` =
「통일서명」, `iso.titles` = 「소장 서명 수」). A pack that used 서명 for signatures
would have one string meaning both things across screen and book. Total absence is
also checkable: grep 서명 in `ko.ts`.

Cost, stated once in the glossary so the reader is not ambushed:
**KORMARC 필드 이름에 나오는 “서명”은 표제를 뜻합니다.** The chapter that mentions
both now reads 「표제면의 본표제」 and 「저자 자필」 — no shared morpheme.

### h. 사본 — banned as "copy"

**사본** is banned as a translation of *copy* anywhere in the pack: it means a
reproduction or photocopy, and 「사본 3권」 would say the library owns three
photocopies.

- One physical volume the library owns = **소장본** (counter 권).
- The item layer as a data structure, and MARC 852/876–878 holdings = **개별자료**.
- An additional copy of the same edition = **추가 소장본** /
  「같은 판의 소장본 두 권」 (복본 is banned too — see §0).

사본 is admitted only in its true sense — a reproduction, a photocopy, a facsimile
— and the one existing sentence that legitimately uses it (「수집기는 자체 사본을
보관하므로」) is exactly that sense and may stay. This is not only a translation
rule: the Korean interface uses 사본 for *copy* in 39 places against 소장본 in 11,
so the pack and a sweep of the ko dictionary must land together, or every chapter
will describe a screen that says something else.

### i. 삭제 · 파기 · 폐기 — and the acts they must not share

Five acts, five words, one deliberate family, and one word removed:

| Act | Word | Reversible? |
| --- | --- | --- |
| delete a record or a reader | **레코드 삭제** / **이용자 레코드 삭제** | yes — 휴지통, undone by 복원 |
| purge from the trash | **영구 삭제** | no |
| destroy a reader's personal data | **개인정보 파기** | no (statutory) |
| withdraw a copy from the stock | **제적** (사유 기록) | the record and other copies remain |
| retire a heading | **표목 폐지** | no — every link is severed |

영구 삭제 deliberately keeps 삭제, because purging is the endpoint of deletion, not
a fourth kind of act. **폐기 is banned** so nothing can slide between 제적 and 폐지,
and **bare 파기 is banned** so nothing can slide between 영구 삭제 and 개인정보 파기.
Where a volume is physically thrown out, the word is 처분. Three UI strings block
this today: `trash.purgeBody` (사본·…파기됩니다 → 소장본·…영구 삭제됩니다),
`trash.intro` (파기되지 않고 → 영구 삭제되지 않고) and `authorities.retire`
(폐기 → 폐지).

### j. 판 vs 쇄 — confirmed, and it settles the Russian question

Confirmed, unanimously and confidently: **Korean has the exact words Russian
lacked.**

- **판** = edition (초판, 재판, 제2판, 개정판; statement 판사항, MARC 250).
- **쇄** = printing / impression (제3쇄).
- **발행 부수** = print run size, how many copies were printed.

「1955년 초판의 1987년 3쇄」 is ordinary Korean, and a Korean 판권지 prints 초판 and
3쇄 on the same line, so the librarian has been reading this distinction all their
working life. The printing chapter needs no circumlocution and no loanword.
**인쇄 is banned in that chapter**, because it also reads as "a print-out" in an
interface — the same trap that produced the Greek εκτύπωση/ανατύπωση error — and
**재판** is banned there too, since it means a new edition, the opposite of what the
chapter says.

Consequence for the merge chapter: two records differing only in 쇄 are the same 판
and may merge; two records differing in 판 are 두 종 and may not.

Upstream: the Russian pack's open question (тираж) is answered by analogy. тираж
is the 발행 부수 concept — the number of copies printed — so it cannot carry
"printing"; Russian needs a *phrase* for 쇄, not a synonym for 판.

### k. 종 vs 책 — the two ISO 2789 counting units

- **종** counts titles: 「12,528종」. Statistics row 소장 종수.
- **책** counts physical volumes: 「N책」. Statistics row 소장 책수.

Both appear in the statistics chapter because ISO 2789 counts them separately, as
do Korean national library statistics. Two rules protect the pair: **권 is never a
statistical counter** (권 is a designation — 제3권, 권차 — and 권수 would read as
"which volume number"), and **책 appears only where a statistic is being reported**
— never as the ordinary word for a book (that is 도서, or 소장본 for the object),
and never as a prose counter of volumes.

The second rule is stated this way because its first draft ("책 appears only with a
numeral or as 책수") was not enough: the Korean consistency chapter came back with
「이 서가에서 161책을 차지하는 Patrologia Graeca」 and 「163책 가운데 154책」, all
four with numerals and all four wrong, because that paragraph is prose and prose
counts volumes in 권. **Test for the translator: if the sentence could not appear as
a row of the ISO 2789 report, the unit is 권.** The consequence is that a chapter
can hold 「161권을 차지하는 Patrologia Graeca」 and 「소장 책수」 without teaching the
reader that 권 and 책 do one job.

The chapter states the identity once, because that sentence is what makes the two
numbers readable side by side: 「한 종에 소장본이 여러 권 딸릴 수 있으므로 책수는
종수보다 큽니다.」 And 제적은 사유별로 집계됩니다, which is why withdrawal is a
counted act and deletion is not. UI: `iso.titles` 「소장 서명 수」 → 「소장 종수」,
`iso.items` 「소장 책 수」 → 「소장 책수」, `iso.serials` 「연속간행물 서명」 →
「연속간행물 종수」.

### l. 총서 vs 전집 vs 시리즈 vs 다권본

- **총서** = a publisher's series: many separate publications issued under one
  series title (총서사항, 총서번호, MARC 490/830).
- **다권본** = one work published in several volumes — the general term for a
  multi-part work or set. Its parts are 권, its absences 결권.
- **전집** = a collected-works corpus (the complete works of a Father, an ΑΠΑΝΤΑ,
  a Patrologia). One particular kind of 다권본, never a synonym for it.
- **시리즈** = not used at all. It is a loanword whose vagueness would let a
  translator slide between all three, and between them and a periodical's 소장권호.
  **세트** survives only inside the quoted screen label 「다권 세트」.

Test sentence for reviewers: 「총서는 여러 종을 묶고, 다권본은 한 종을 여러 책으로
나누며, 소장권호는 연속간행물에서 우리가 가진 호를 가리킵니다.」

### m. Quotation marks

**“ ”** for a stored catalogue value or any literal string the librarian types;
**「 」** for an interface object (screen, tab, button, field label, menu item);
**『 』** for a cited publication or standard document. **‘ ’** for a quote inside a
quote. Nothing else: no « » (the Greek and Russian convention), no 〈 〉, no straight
`"` or `'`.

The “ ” / 「 」 split does real work, because most sentences in this Handbook say
*type this value into that field* and the reader can see which is which without
parsing. 『 』 is kept, against one proposal that dropped it, because the pack cites
『한국목록규칙 제4판』 and a book title needs a mark that is neither a value nor a
button. The existing Korean interface already uses “ ” for values, so the pack is
continuous with the screen. Quoted values keep their stored characters verbatim
inside the marks, including the &lt;&lt;&gt;&gt; the import made of Greek quotation
marks: “ΑΔΕΛΦΟΤΗΣ ΘΕΟΛΟΓΩΝ &lt;&lt;Ο ΣΩΤΗΡ&gt;&gt;”. A particle after a Greek or
Latin string is never guessed — 「“…”의 경우」 or the interface's 이(가) form.

---

## 5. Before the chapters are written

### 5.1 Two files block delivery

`CONTENT_LOADERS` in `apps/web/src/handbook/registry.ts:216` maps `ko` to
`./content/en`, and `TRANSLATED_LANGS` (line 222) is `['en', 'el', 'ru']`. Until
both change, a finished `ko.ts` will never be served. The per-chapter English
fallback means the pack can ship partially, as Greek did.

### 5.2 The UI sweep, in priority order

The Korean dictionary in `apps/web/src/i18n.tsx` (Korean block, roughly lines
1138–2233) contains two generations of translation: the newer `copies.*`,
`serials.*` and `authorities.*` blocks are careful (소장본, 소장 범위, 결호, 채택형,
제적, 청구기호, 서가 기호), while older blocks contradict them. A chapter that says
소장본 in prose and then quotes a button labelled 「사본」 teaches the reader that the
two are different things. Verified counts: 사본 39, 소장본 11.

1. 사본 → 소장본 in `library.copies.*`, `library.bulk.addCopies`,
   `copies.editHeading`, `copies.editIntro`, `copies.saved`, `loans.copyN`,
   `loans.duePolicy`, `holds.intro`, `toast.holdReady`,
   `toast.holdCancelledPassed`, `toast.bookBorrowedCopy`, `policies.itemType`,
   `policies.itemTypeFor`, `settings.merge.*`, `labels.toolbarHint`,
   `confirm.addCopies*`, `trash.purgeBody`, `trash.restoreMergedBody`.
2. `trash.intro` and `trash.purgeBody`: 파기 → 영구 삭제, so 파기 belongs to
   personal data alone.
3. `borrowers.erase` 「개인정보 삭제」 → 「개인정보 파기」.
4. `authorities.retire*` 「폐기」 → 「폐지」 (label, title, body, toast, and the
   editKeepsLinks sentence).
5. `iso.titles` 「소장 서명 수」 → 「소장 종수」; `iso.items` → 「소장 책수」;
   `iso.serials` 「연속간행물 서명」 → 「연속간행물 종수」; `iso.itemsLent`
   「대출된 사본 수」 → 「대출된 소장본 수」.
6. `course.chapter.titles` 「서명」 → 「표제」; `authorities.kind.uniform_title`
   「통일서명」 → 「통일표제」; `library.sets.suppressed` 「모든 서명이…」 →
   「모든 표제가…」.
7. `detail.room` and `library.bulk.field.roomCode` 「방」 → 「서가실」.
8. `marc.harvest*` 「수확 / 수확기」 → 「수집 / 수집기」.
9. `toast.*DryRun*` 「시뮬레이션」 → 「시험 실행」.
10. `toast.borrowerRequired` 「대출자」 → 「이용자」.
11. `library.adv.field.custom` 「사용자 정의 필드」 and `library.add.attributes`
    「카탈로그 속성」 → 「사용자 지정 속성」.
12. `authorities.vsConsistency` “표기 일관성” → “값 일관성”, matching
    `settings.vc.heading`, which is the screen the sentence points at. The
    foundations chapter already quotes 「값 일관성」, so screen and chapter must land
    together or the reader hunts for a heading that does not exist. The English
    string has the same fault (“Spelling consistency” vs the heading “Value
    consistency”) and should be fixed in `en` at the same time.
13. `serials.heading` / `serials.editHeading` 「소장 범위」 → 「소장권호」;
    `library.sets.mode` 「다권 세트」 → 「다권본」; `identity.shareOnBody` 공유 → 공개;
    note labels 「메모」 → 「주기」 where they are cataloguing notes.

Until a string is fixed, quote it **as it stands** inside 「 」 and give the pack's
term in the surrounding prose.

### 5.3 Three decisions to confirm with the librarian

1. **표제 over 서명 for title** (collision g). The only way to make the hazard
   structurally impossible, at the cost that a KORMARC-trained reader meets a word
   KORMARC does not use in its field captions. Fallback if refused: title = 서명
   (본서명 / 부서명), signature = 자필 only, 서명본 still banned — not recommended,
   because 서명 사항 and 서명본 are too close for a reader skimming the notes chapter.
2. **서가실 for room.** It is this system's coinage, not standard Korean library
   vocabulary, and no rooms are defined yet — all 12,528 copies are unassigned. If
   the monastery names its spaces 자료실 or 서고, that word should win for the label,
   with 소장처 kept for the concept.
3. **면장수 for extent.** Right register and it covers 권책수, which 쪽수 cannot,
   but only moderate confidence that it is the exact KORMARC subfield wording. Show
   a real value beside it on first use in each chapter.

### 5.4 A review gate for the Korean pack

Six sentences whose mistranslation is the whole risk. A grep for the banned word
inside each is a static check `check_handbook.mjs` could carry, which would make
the Korean pack the first one where these failures cannot ship.

1. 「소장권호를 기록하십시오.」 — must not contain 총서.
2. 「먼저 반납 처리를 하십시오.」 — must not contain 수령.
3. 「예약 자료 수령 기한」 — must not contain 반납.
4. 「개인정보를 파기하십시오.」 — must not contain 삭제.
5. 「이 표목을 폐지하십시오.」 — must not contain 폐기 / 삭제 / 제적.
6. 「서가기호는 이 도서관 안의 위치이고 청구기호는 밖으로 내보내는 기호입니다.」 —
   the two must not be swapped.

Plus the flat greps of §0: 사본 · 서명 · 폐기 · 복본 · 시리즈 · 전자 · 수확 · 카탈로그.

### 5.5 What the catalogue's own values do

Nothing in this pack translates the catalogue's values. Greek stays Greek —
“ΑΡΧΙΜ. ΝΙΚΟΔΗΜΟΥ Γ. ΑΕΡΑΚΗ”, “Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ”,
“ΑΔΕΛΦΟΤΗΣ ΘΕΟΛΟΓΩΝ &lt;&lt;Ο ΣΩΤΗΡ&gt;&gt;” — because they are quoted as evidence
about this catalogue, and the Korean gloss goes beside them, never instead of them.
The one exception is the five withdrawal reasons: because the report groups on
exact text and a Korean librarian will type Korean, the pack offers
**파손 · 분실 · 양도 · 대체 · 중복 소장** as what to type, alongside the Greek the
English chapter lists (φθορά · απώλεια · δωρεά · αντικατάσταση · διπλότυπο).
