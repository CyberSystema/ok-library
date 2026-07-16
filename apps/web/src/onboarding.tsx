import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n, type Lang } from './i18n';

// ─────────────────────────────────────────────────────────────────────────────
// Librarian onboarding course.
//
// A guided, demonstrative walkthrough of the whole system + the optimal way to
// catalogue books. It is MANDATORY on a librarian's first sign-in (rendered by
// App as a full-screen, un-closable gate) and replayable anytime from Settings.
//
// All course prose lives here (not in i18n.tsx) as {en, el, ru, el} objects, so
// the content is self-contained and picks the reader's language with an English
// fallback. Keep sentences tight — this is read on screen, not printed.
// ─────────────────────────────────────────────────────────────────────────────

type Loc = { en: string; el: string; ru: string; ko: string };
const pick = (l: Loc, lang: Lang): string => l[lang] || l.en;

type Block =
  | { kind: 'p'; text: Loc }
  | { kind: 'tip'; text: Loc } // a highlighted best-practice tip
  | { kind: 'rule'; text: Loc } // a "golden rule" of cataloguing
  | { kind: 'steps'; items: Loc[] }; // an ordered how-to list

interface Chapter {
  id: string;
  icon: string;
  title: Loc;
  lead: Loc;
  blocks: Block[];
}

// UI chrome (buttons, labels) — localised here too so the whole course is one file.
const UI = {
  courseTitle: { en: 'Librarian Guide', el: 'Οδηγός Βιβλιοθηκονόμου', ru: 'Руководство библиотекаря', ko: '사서 가이드' },
  mandatoryNote: {
    en: 'This short course is required the first time you sign in. You can replay it anytime from Settings.',
    el: 'Αυτό το σύντομο μάθημα είναι υποχρεωτικό την πρώτη φορά που συνδέεστε. Μπορείτε να το ξαναδείτε όποτε θέλετε από τις Ρυθμίσεις.',
    ru: 'Этот короткий курс обязателен при первом входе. Вы можете повторить его в любое время из Настроек.',
    ko: '이 짧은 과정은 처음 로그인할 때 필수입니다. 설정에서 언제든지 다시 볼 수 있습니다.'
  },
  chapterOf: { en: 'Chapter {n} of {total}', el: 'Κεφάλαιο {n} από {total}', ru: 'Глава {n} из {total}', ko: '{total}개 중 {n}번째 장' },
  back: { en: 'Back', el: 'Πίσω', ru: 'Назад', ko: '이전' },
  next: { en: 'Next', el: 'Επόμενο', ru: 'Далее', ko: '다음' },
  finish: { en: 'Finish', el: 'Τέλος', ru: 'Завершить', ko: '완료' },
  close: { en: 'Close', el: 'Κλείσιμο', ru: 'Закрыть', ko: '닫기' },
  contents: { en: 'Contents', el: 'Περιεχόμενα', ru: 'Содержание', ko: '목차' },
  tipLabel: { en: 'Tip', el: 'Συμβουλή', ru: 'Совет', ko: '팁' },
  ruleLabel: { en: 'Golden rule', el: 'Χρυσός κανόνας', ru: 'Золотое правило', ko: '핵심 규칙' },
  language: { en: 'Language', el: 'Γλώσσα', ru: 'Язык', ko: '언어' }
} satisfies Record<string, Loc>;

const CHAPTERS: Chapter[] = [
  {
    id: 'welcome',
    icon: '🎓',
    title: { en: 'Welcome', el: 'Καλώς ήρθατε', ru: 'Добро пожаловать', ko: '환영합니다' },
    lead: {
      en: 'A short, guided tour of the system and the best way to catalogue books.',
      el: 'Μια σύντομη, καθοδηγούμενη ξενάγηση στο σύστημα και στον καλύτερο τρόπο καταλογογράφησης βιβλίων.',
      ru: 'Короткая экскурсия по системе и лучший способ каталогизировать книги.',
      ko: '시스템과 도서를 목록화하는 최적의 방법을 안내하는 짧은 둘러보기입니다.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'Welcome! This guide walks you through the whole library system and shows you the optimal, consistent way to catalogue books. It takes about ten minutes and is purely demonstrative — nothing you do here changes real data.',
        el: 'Καλώς ήρθατε! Αυτός ο οδηγός σας ξεναγεί σε ολόκληρο το σύστημα της βιβλιοθήκης και σας δείχνει τον βέλτιστο, συνεπή τρόπο καταλογογράφησης βιβλίων. Διαρκεί περίπου δέκα λεπτά και είναι καθαρά επιδεικτικός — τίποτα εδώ δεν αλλάζει πραγματικά δεδομένα.',
        ru: 'Добро пожаловать! Это руководство проведёт вас по всей системе библиотеки и покажет оптимальный, единообразный способ каталогизации книг. Занимает около десяти минут и является чисто демонстрационным — ничего из того, что вы здесь делаете, не меняет реальные данные.',
        ko: '환영합니다! 이 가이드는 도서관 시스템 전체를 안내하고 도서를 일관되게 목록화하는 최적의 방법을 보여줍니다. 약 10분이 걸리며 순수하게 데모용입니다 — 여기서 하는 어떤 것도 실제 데이터를 바꾸지 않습니다.'
      } },
      { kind: 'p', text: {
        en: 'Use Next and Back to move through the chapters, or jump around from the Contents list on the left. Pick your language at the top right at any time.',
        el: 'Χρησιμοποιήστε το Επόμενο και το Πίσω για να περιηγηθείτε στα κεφάλαια ή μεταβείτε ελεύθερα από τη λίστα Περιεχόμενα αριστερά. Επιλέξτε τη γλώσσα σας επάνω δεξιά όποτε θέλετε.',
        ru: 'Используйте «Далее» и «Назад» для перехода по главам или переходите свободно из списка «Содержание» слева. Выберите язык вверху справа в любой момент.',
        ko: '다음과 이전으로 장을 이동하거나 왼쪽 목차에서 자유롭게 이동하세요. 오른쪽 상단에서 언제든지 언어를 선택할 수 있습니다.'
      } },
      { kind: 'tip', text: {
        en: 'You can replay this whole guide whenever you like from Settings → Librarian Guide.',
        el: 'Μπορείτε να ξαναδείτε ολόκληρο τον οδηγό όποτε θέλετε από Ρυθμίσεις → Οδηγός Βιβλιοθηκονόμου.',
        ru: 'Вы можете повторить всё руководство в любой момент из Настройки → Руководство библиотекаря.',
        ko: '설정 → 사서 가이드에서 언제든지 전체 가이드를 다시 볼 수 있습니다.'
      } }
    ]
  },
  {
    id: 'layout',
    icon: '🧭',
    title: { en: 'The environment', el: 'Το περιβάλλον', ru: 'Интерфейс', ko: '환경' },
    lead: {
      en: 'Where everything lives: the tabs, the search bar, the category rail and the stat cards.',
      el: 'Πού βρίσκονται όλα: οι καρτέλες, η μπάρα αναζήτησης, η στήλη κατηγοριών και οι κάρτες στατιστικών.',
      ru: 'Где что находится: вкладки, строка поиска, панель категорий и карточки статистики.',
      ko: '모든 것의 위치: 탭, 검색창, 분류 목록, 통계 카드.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'The top bar holds the main tabs. Library is where you browse, search and add books. Circulation is lending and returns. Import/Export moves data in and out. Overview shows statistics. Settings holds tools and this guide.',
        el: 'Η επάνω μπάρα περιέχει τις κύριες καρτέλες. Η Βιβλιοθήκη είναι όπου περιηγείστε, αναζητάτε και προσθέτετε βιβλία. Οι Δανεισμοί αφορούν δανεισμό και επιστροφές. Η Εισαγωγή/Εξαγωγή μετακινεί δεδομένα. Η Επισκόπηση δείχνει στατιστικά. Οι Ρυθμίσεις περιέχουν εργαλεία και αυτόν τον οδηγό.',
        ru: 'Верхняя панель содержит основные вкладки. «Библиотека» — где вы просматриваете, ищете и добавляете книги. «Выдача» — выдача и возврат. «Импорт/Экспорт» перемещает данные. «Обзор» показывает статистику. «Настройки» содержат инструменты и это руководство.',
        ko: '상단 막대에는 주요 탭이 있습니다. 도서관은 탐색, 검색, 도서 추가를 하는 곳입니다. 대출은 대출과 반납입니다. 가져오기/내보내기는 데이터를 이동합니다. 개요는 통계를 보여줍니다. 설정에는 도구와 이 가이드가 있습니다.'
      } },
      { kind: 'p', text: {
        en: 'On the Library tab: the search bar and filters are at the top, the category rail (your shelf classification) is on the left, and the book grid fills the rest. The coloured cards at the very top count your total, available, borrowed and overdue books at a glance.',
        el: 'Στην καρτέλα Βιβλιοθήκη: η μπάρα αναζήτησης και τα φίλτρα είναι επάνω, η στήλη κατηγοριών (η ταξινόμηση των ραφιών σας) είναι αριστερά και το πλέγμα βιβλίων γεμίζει τα υπόλοιπα. Οι έγχρωμες κάρτες στην κορυφή μετρούν τα συνολικά, διαθέσιμα, δανεισμένα και εκπρόθεσμα βιβλία σας με μια ματιά.',
        ru: 'На вкладке «Библиотека»: строка поиска и фильтры вверху, панель категорий (классификация полок) слева, а сетка книг заполняет остальное. Цветные карточки вверху показывают общее число, доступные, выданные и просроченные книги.',
        ko: '도서관 탭: 검색창과 필터가 상단에, 분류 목록(서가 분류)이 왼쪽에, 도서 그리드가 나머지를 채웁니다. 맨 위 색상 카드는 전체·대출가능·대출중·연체 도서를 한눈에 보여줍니다.'
      } },
      { kind: 'tip', text: {
        en: 'The tabs you see depend on your permissions — if a tab is missing, your role may not include it.',
        el: 'Οι καρτέλες που βλέπετε εξαρτώνται από τα δικαιώματά σας — αν λείπει μια καρτέλα, ο ρόλος σας μπορεί να μην την περιλαμβάνει.',
        ru: 'Видимые вкладки зависят от ваших прав — если вкладки нет, ваша роль может её не включать.',
        ko: '보이는 탭은 권한에 따라 다릅니다 — 탭이 없다면 역할에 포함되지 않았을 수 있습니다.'
      } }
    ]
  },
  {
    id: 'search',
    icon: '🔎',
    title: { en: 'Finding books', el: 'Εύρεση βιβλίων', ru: 'Поиск книг', ko: '도서 찾기' },
    lead: {
      en: 'Search is forgiving: it ignores accents and capitalisation, so you always find the book.',
      el: 'Η αναζήτηση είναι επιεικής: αγνοεί τόνους και κεφαλαία, ώστε να βρίσκετε πάντα το βιβλίο.',
      ru: 'Поиск снисходителен: игнорирует ударения и регистр, поэтому вы всегда найдёте книгу.',
      ko: '검색은 관대합니다: 악센트와 대소문자를 무시하므로 항상 도서를 찾습니다.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'Type in the search bar to find a book by title, author, ISBN and more. Accents and upper/lower case are ignored — searching "αθηνα" finds "Ἀθῆναι". So you never have to remember exactly how something was typed.',
        el: 'Πληκτρολογήστε στη μπάρα αναζήτησης για να βρείτε ένα βιβλίο με τίτλο, συγγραφέα, ISBN και άλλα. Οι τόνοι και τα κεφαλαία/πεζά αγνοούνται — η αναζήτηση «αθηνα» βρίσκει το «Ἀθῆναι». Έτσι δεν χρειάζεται ποτέ να θυμάστε πώς ακριβώς γράφτηκε κάτι.',
        ru: 'Введите в строку поиска, чтобы найти книгу по названию, автору, ISBN и другому. Ударения и регистр игнорируются — поиск «афины» находит «Ἀθῆναι». Вам не нужно помнить, как именно что-то было набрано.',
        ko: '검색창에 입력하여 제목, 저자, ISBN 등으로 도서를 찾으세요. 악센트와 대소문자는 무시됩니다 — "athina"로 검색하면 "Ἀθῆναι"를 찾습니다. 정확히 어떻게 입력됐는지 기억할 필요가 없습니다.'
      } },
      { kind: 'p', text: {
        en: 'Narrow results with the filters (status, room, shelf, language, year) and the quick "smart list" chips — for example Needs review, No ISBN, No shelf, or Unknown author. Change the sort order to browse by title, author or newest.',
        el: 'Περιορίστε τα αποτελέσματα με τα φίλτρα (κατάσταση, αίθουσα, ράφι, γλώσσα, έτος) και τα γρήγορα «έξυπνα» τσιπ — για παράδειγμα Απαιτείται έλεγχος, Χωρίς ISBN, Χωρίς ράφι ή Άγνωστος συγγραφέας. Αλλάξτε τη σειρά ταξινόμησης για περιήγηση κατά τίτλο, συγγραφέα ή νεότερα.',
        ru: 'Сузьте результаты фильтрами (статус, зал, полка, язык, год) и быстрыми «умными» чипами — например «Требует проверки», «Без ISBN», «Без полки» или «Неизвестный автор». Меняйте сортировку по названию, автору или новизне.',
        ko: '필터(상태, 방, 서가, 언어, 연도)와 빠른 "스마트 목록" 칩(예: 검토 필요, ISBN 없음, 서가 없음, 저자 미상)으로 결과를 좁히세요. 정렬 순서를 바꿔 제목, 저자 또는 최신순으로 탐색하세요.'
      } },
      { kind: 'tip', text: {
        en: 'Press the "/" key anywhere to jump straight to the search box.',
        el: 'Πατήστε το πλήκτρο «/» οπουδήποτε για να μεταβείτε κατευθείαν στο πλαίσιο αναζήτησης.',
        ru: 'Нажмите клавишу «/» в любом месте, чтобы сразу перейти в поле поиска.',
        ko: '어디서든 "/" 키를 누르면 검색창으로 바로 이동합니다.'
      } }
    ]
  },
  {
    id: 'add-optimal',
    icon: '➕',
    title: { en: 'Adding a book, the optimal way', el: 'Προσθήκη βιβλίου, ο βέλτιστος τρόπος', ru: 'Добавление книги оптимально', ko: '최적의 도서 추가 방법' },
    lead: {
      en: 'Let the system do the typing: start from the ISBN whenever a book has one.',
      el: 'Αφήστε το σύστημα να πληκτρολογεί: ξεκινήστε από το ISBN όποτε ένα βιβλίο έχει.',
      ru: 'Пусть система печатает за вас: начинайте с ISBN, когда он есть.',
      ko: '시스템이 입력하게 하세요: 책에 ISBN이 있으면 ISBN부터 시작하세요.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'Open Library → Add book. The single most efficient habit is to enter the ISBN first and press Lookup: the system fetches the title, author, publisher and year for you, so you avoid typos and save time.',
        el: 'Ανοίξτε Βιβλιοθήκη → Προσθήκη βιβλίου. Η πιο αποδοτική συνήθεια είναι να εισάγετε πρώτα το ISBN και να πατήσετε Αναζήτηση: το σύστημα ανακτά τον τίτλο, τον συγγραφέα, τον εκδότη και το έτος για εσάς, ώστε να αποφεύγετε λάθη και να κερδίζετε χρόνο.',
        ru: 'Откройте «Библиотека» → «Добавить книгу». Самая эффективная привычка — сначала ввести ISBN и нажать «Поиск»: система сама подставит название, автора, издателя и год, избавляя от опечаток и экономя время.',
        ko: '도서관 → 도서 추가를 여세요. 가장 효율적인 습관은 ISBN을 먼저 입력하고 조회를 누르는 것입니다: 시스템이 제목, 저자, 출판사, 연도를 가져와 오타를 피하고 시간을 절약합니다.'
      } },
      { kind: 'steps', items: [
        { en: 'Enter the ISBN (if the book has one) and press Lookup to auto-fill the fields.', el: 'Εισάγετε το ISBN (αν το βιβλίο έχει) και πατήστε Αναζήτηση για αυτόματη συμπλήρωση.', ru: 'Введите ISBN (если есть) и нажмите «Поиск» для автозаполнения.', ko: 'ISBN을 입력하고(있는 경우) 조회를 눌러 자동 채우기.' },
        { en: 'Give the book a Title — this is the one required field, marked with a red asterisk.', el: 'Δώστε στο βιβλίο έναν Τίτλο — αυτό είναι το μοναδικό υποχρεωτικό πεδίο, με κόκκινο αστερίσκο.', ru: 'Укажите Название — единственное обязательное поле, отмеченное красной звёздочкой.', ko: '도서에 제목을 입력하세요 — 빨간 별표로 표시된 유일한 필수 항목입니다.' },
        { en: 'Add the author only if the book actually names one — leave it blank for liturgical and anonymous works.', el: 'Προσθέστε τον συγγραφέα μόνο αν το βιβλίο αναφέρει έναν — αφήστε το κενό για λειτουργικά και ανώνυμα έργα.', ru: 'Указывайте автора только если книга его называет — оставьте пустым для богослужебных и анонимных изданий.', ko: '책에 실제로 저자가 명시된 경우에만 저자를 추가하세요 — 전례서와 익명 저작은 비워 두세요.' },
        { en: 'Set the shelf/room code so the book can be found on the physical shelf, add a cover image, and fill any custom fields.', el: 'Ορίστε τον κωδικό ραφιού/αίθουσας ώστε το βιβλίο να βρίσκεται στο ράφι, προσθέστε εικόνα εξωφύλλου και συμπληρώστε τυχόν προσαρμοσμένα πεδία.', ru: 'Задайте код полки/зала, чтобы книгу можно было найти на полке, добавьте обложку и заполните пользовательские поля.', ko: '실물 서가에서 찾을 수 있도록 서가/방 코드를 설정하고, 표지 이미지를 추가하고, 사용자 정의 항목을 채우세요.' }
      ] },
      { kind: 'rule', text: {
        en: 'Title is required; author is optional. Many legitimate books — especially liturgical ones — have no named author, so never invent one.',
        el: 'Ο τίτλος είναι υποχρεωτικός· ο συγγραφέας προαιρετικός. Πολλά έγκυρα βιβλία — ιδίως λειτουργικά — δεν έχουν αναφερόμενο συγγραφέα, οπότε μην εφευρίσκετε ποτέ κάποιον.',
        ru: 'Название обязательно; автор — нет. У многих книг — особенно богослужебных — нет указанного автора, поэтому никогда не выдумывайте его.',
        ko: '제목은 필수, 저자는 선택입니다. 특히 전례서 등 많은 정당한 도서에는 저자가 없으므로 절대 지어내지 마세요.'
      } },
      { kind: 'tip', text: {
        en: 'Fields marked with a red asterisk (*) must be filled — the form will stop you and highlight anything missing.',
        el: 'Τα πεδία με κόκκινο αστερίσκο (*) πρέπει να συμπληρωθούν — η φόρμα θα σας σταματήσει και θα επισημάνει ό,τι λείπει.',
        ru: 'Поля с красной звёздочкой (*) обязательны — форма остановит вас и подсветит пропущенное.',
        ko: '빨간 별표(*) 항목은 반드시 채워야 합니다 — 양식이 저장을 막고 누락된 항목을 강조합니다.'
      } }
    ]
  },
  {
    id: 'consistency',
    icon: '✨',
    title: { en: 'Consistent cataloguing', el: 'Συνεπής καταλογογράφηση', ru: 'Единообразная каталогизация', ko: '일관된 목록화' },
    lead: {
      en: 'The single most important skill: spell names the same way every time.',
      el: 'Η πιο σημαντική δεξιότητα: γράφετε τα ονόματα με τον ίδιο τρόπο κάθε φορά.',
      ru: 'Самый важный навык: пишите имена одинаково каждый раз.',
      ko: '가장 중요한 능력: 이름을 매번 동일하게 표기하세요.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'As you type an author, publisher, language or shelf code, the system suggests values that already exist in the catalogue. Always pick from these suggestions instead of retyping. This keeps every book by the same author filed together and prevents accidental near-duplicates.',
        el: 'Καθώς πληκτρολογείτε συγγραφέα, εκδότη, γλώσσα ή κωδικό ραφιού, το σύστημα προτείνει τιμές που υπάρχουν ήδη στον κατάλογο. Επιλέγετε πάντα από αυτές τις προτάσεις αντί να πληκτρολογείτε ξανά. Έτσι όλα τα βιβλία του ίδιου συγγραφέα μένουν μαζί και αποφεύγονται τα κατά λάθος οιονεί διπλότυπα.',
        ru: 'Когда вы вводите автора, издателя, язык или код полки, система предлагает значения, уже существующие в каталоге. Всегда выбирайте из этих подсказок, а не печатайте заново. Так все книги одного автора хранятся вместе и предотвращаются случайные почти-дубликаты.',
        ko: '저자, 출판사, 언어 또는 서가 코드를 입력하면 시스템이 목록에 이미 있는 값을 제안합니다. 다시 입력하지 말고 항상 이 제안에서 선택하세요. 그러면 같은 저자의 모든 책이 함께 정리되고 실수로 인한 유사 중복을 방지합니다.'
      } },
      { kind: 'rule', text: {
        en: 'One name, one spelling. Choose the existing suggestion — do not create "J. Migne", "J.-P. Migne" and "Migne, J." as three different people.',
        el: 'Ένα όνομα, μία γραφή. Επιλέξτε την υπάρχουσα πρόταση — μη δημιουργείτε «J. Migne», «J.-P. Migne» και «Migne, J.» ως τρία διαφορετικά πρόσωπα.',
        ru: 'Одно имя — одно написание. Выбирайте существующую подсказку — не создавайте «J. Migne», «J.-P. Migne» и «Migne, J.» как три разных человека.',
        ko: '하나의 이름, 하나의 표기. 기존 제안을 선택하세요 — "J. Migne", "J.-P. Migne", "Migne, J."를 세 사람으로 만들지 마세요.'
      } },
      { kind: 'p', text: {
        en: 'Keep fields that must stay in the original language (like the title and author) in that language; use your library\'s agreed language for descriptive notes. Search still works across accents and case, but tidy, consistent values make browsing, filtering and reports trustworthy.',
        el: 'Κρατήστε τα πεδία που πρέπει να παραμείνουν στην αρχική γλώσσα (όπως τίτλος και συγγραφέας) σε αυτήν· χρησιμοποιήστε τη συμφωνημένη γλώσσα της βιβλιοθήκης σας για περιγραφικές σημειώσεις. Η αναζήτηση λειτουργεί ανεξαρτήτως τόνων και πεζών/κεφαλαίων, αλλά καθαρές, συνεπείς τιμές κάνουν την περιήγηση, το φιλτράρισμα και τις αναφορές αξιόπιστες.',
        ru: 'Поля, которые должны оставаться на языке оригинала (название, автор), держите на нём; для описательных заметок используйте согласованный язык вашей библиотеки. Поиск работает независимо от ударений и регистра, но аккуратные единообразные значения делают просмотр, фильтрацию и отчёты надёжными.',
        ko: '원어를 유지해야 하는 항목(제목, 저자 등)은 원어로 두고, 설명 메모에는 도서관이 합의한 언어를 사용하세요. 검색은 악센트와 대소문자와 무관하게 작동하지만, 깔끔하고 일관된 값은 탐색·필터·보고서를 신뢰할 수 있게 만듭니다.'
      } },
      { kind: 'tip', text: {
        en: 'If a title or author already exists, the system warns you after saving so you can catch duplicates early.',
        el: 'Αν ένας τίτλος ή συγγραφέας υπάρχει ήδη, το σύστημα σας προειδοποιεί μετά την αποθήκευση ώστε να εντοπίζετε έγκαιρα τα διπλότυπα.',
        ru: 'Если название или автор уже существуют, система предупредит вас после сохранения, чтобы вы вовремя заметили дубликаты.',
        ko: '제목이나 저자가 이미 있으면 저장 후 시스템이 경고하여 중복을 조기에 발견할 수 있습니다.'
      } }
    ]
  },
  {
    id: 'detail-context',
    icon: '📖',
    title: { en: 'Book details & right-click', el: 'Λεπτομέρειες & δεξί κλικ', ru: 'Детали книги и правый клик', ko: '도서 상세 및 우클릭' },
    lead: {
      en: 'Click a book to open it; right-click almost anything for quick actions.',
      el: 'Κάντε κλικ σε ένα βιβλίο για να το ανοίξετε· κάντε δεξί κλικ σχεδόν παντού για γρήγορες ενέργειες.',
      ru: 'Нажмите на книгу, чтобы открыть; щёлкните правой кнопкой почти по всему для быстрых действий.',
      ko: '도서를 클릭하면 열리고, 거의 모든 곳을 우클릭하면 빠른 작업이 나옵니다.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'Click any book card to open its full details, where you can Edit it, lend or return it, print a label, or manage its cover. Click the cover to zoom it full-screen.',
        el: 'Κάντε κλικ σε οποιαδήποτε κάρτα βιβλίου για να ανοίξετε τις πλήρεις λεπτομέρειές του, όπου μπορείτε να το Επεξεργαστείτε, να το δανείσετε ή να το επιστρέψετε, να εκτυπώσετε ετικέτα ή να διαχειριστείτε το εξώφυλλο. Κάντε κλικ στο εξώφυλλο για μεγέθυνση σε πλήρη οθόνη.',
        ru: 'Нажмите на карточку книги, чтобы открыть полные детали, где можно её изменить, выдать или вернуть, напечатать этикетку или управлять обложкой. Нажмите на обложку, чтобы увеличить её на весь экран.',
        ko: '도서 카드를 클릭하면 전체 상세가 열려 편집, 대출·반납, 라벨 인쇄, 표지 관리를 할 수 있습니다. 표지를 클릭하면 전체 화면으로 확대됩니다.'
      } },
      { kind: 'p', text: {
        en: 'Right-click a book (or a category, or a loan) to open a context menu of quick actions: view, edit, borrow/return, copy the title/author/ISBN/shelf, print a label, or delete — without opening the full record. Right-clicking empty space gives you shortcuts like Add book and Refresh.',
        el: 'Κάντε δεξί κλικ σε ένα βιβλίο (ή κατηγορία ή δανεισμό) για να ανοίξετε ένα μενού με γρήγορες ενέργειες: προβολή, επεξεργασία, δανεισμός/επιστροφή, αντιγραφή τίτλου/συγγραφέα/ISBN/ραφιού, εκτύπωση ετικέτας ή διαγραφή — χωρίς να ανοίξετε την πλήρη εγγραφή. Το δεξί κλικ σε κενό χώρο δίνει συντομεύσεις όπως Προσθήκη βιβλίου και Ανανέωση.',
        ru: 'Щёлкните правой кнопкой по книге (или категории, или выдаче), чтобы открыть контекстное меню быстрых действий: просмотр, изменение, выдача/возврат, копирование названия/автора/ISBN/полки, печать этикетки или удаление — не открывая полную запись. Правый клик по пустому месту даёт ярлыки вроде «Добавить книгу» и «Обновить».',
        ko: '도서(또는 분류, 대출)를 우클릭하면 빠른 작업 메뉴가 열립니다: 보기, 편집, 대출/반납, 제목/저자/ISBN/서가 복사, 라벨 인쇄, 삭제 — 전체 기록을 열지 않고요. 빈 공간을 우클릭하면 도서 추가, 새로고침 같은 단축 작업이 나옵니다.'
      } },
      { kind: 'tip', text: {
        en: 'In text boxes the normal browser menu still appears, so cut, copy and paste work as usual.',
        el: 'Στα πλαίσια κειμένου εμφανίζεται κανονικά το μενού του προγράμματος περιήγησης, οπότε αποκοπή, αντιγραφή και επικόλληση λειτουργούν ως συνήθως.',
        ru: 'В текстовых полях обычное меню браузера сохраняется, поэтому вырезать, копировать и вставить работают как обычно.',
        ko: '텍스트 입력란에서는 일반 브라우저 메뉴가 그대로 나타나 잘라내기, 복사, 붙여넣기가 평소처럼 작동합니다.'
      } }
    ]
  },
  {
    id: 'circulation',
    icon: '🔁',
    title: { en: 'Lending & returns', el: 'Δανεισμοί & επιστροφές', ru: 'Выдача и возврат', ko: '대출 및 반납' },
    lead: {
      en: 'Track who has what, and keep the shelf and the records in step.',
      el: 'Παρακολουθήστε ποιος έχει τι και κρατήστε το ράφι και τις εγγραφές συγχρονισμένα.',
      ru: 'Отслеживайте, у кого что, и держите полку и записи в согласии.',
      ko: '누가 무엇을 가졌는지 추적하고 서가와 기록을 일치시키세요.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'To lend a book, open it (or use the Borrow action) and record the borrower and a due date. The book\'s status becomes Borrowed and it appears in the Circulation tab. When it comes back, use Return.',
        el: 'Για να δανείσετε ένα βιβλίο, ανοίξτε το (ή χρησιμοποιήστε την ενέργεια Δανεισμός) και καταγράψτε τον δανειζόμενο και μια ημερομηνία επιστροφής. Η κατάσταση του βιβλίου γίνεται Δανεισμένο και εμφανίζεται στην καρτέλα Δανεισμοί. Όταν επιστραφεί, χρησιμοποιήστε την Επιστροφή.',
        ru: 'Чтобы выдать книгу, откройте её (или используйте действие «Выдать») и запишите читателя и срок возврата. Статус книги становится «Выдана», и она появляется во вкладке «Выдача». При возврате используйте «Вернуть».',
        ko: '도서를 대출하려면 도서를 열거나(또는 대출 작업 사용) 대출자와 반납 예정일을 기록하세요. 도서 상태가 대출중이 되고 대출 탭에 나타납니다. 돌아오면 반납을 사용하세요.'
      } },
      { kind: 'p', text: {
        en: 'The Circulation tab lists every open loan and flags overdue ones. You can return a single loan, or return all overdue items at once from the right-click menu.',
        el: 'Η καρτέλα Δανεισμοί εμφανίζει κάθε ανοιχτό δανεισμό και επισημαίνει τους εκπρόθεσμους. Μπορείτε να επιστρέψετε έναν δανεισμό ή όλα τα εκπρόθεσμα μαζί από το μενού δεξιού κλικ.',
        ru: 'Вкладка «Выдача» показывает все открытые выдачи и отмечает просроченные. Можно вернуть одну выдачу или все просроченные сразу из меню правого клика.',
        ko: '대출 탭은 모든 진행 중인 대출을 표시하고 연체를 표시합니다. 하나씩 반납하거나 우클릭 메뉴로 연체 전체를 한 번에 반납할 수 있습니다.'
      } },
      { kind: 'rule', text: {
        en: 'Always lend and return through the system, not by editing the status by hand — that keeps the loan records and the "borrowed" count honest.',
        el: 'Δανείζετε και επιστρέφετε πάντα μέσω του συστήματος, όχι αλλάζοντας την κατάσταση με το χέρι — έτσι οι εγγραφές δανεισμού και ο μετρητής «δανεισμένων» παραμένουν σωστοί.',
        ru: 'Всегда выдавайте и возвращайте через систему, а не меняя статус вручную — так записи выдач и счётчик «выдано» остаются верными.',
        ko: '상태를 수동으로 바꾸지 말고 항상 시스템을 통해 대출·반납하세요 — 그래야 대출 기록과 "대출중" 수가 정확합니다.'
      } }
    ]
  },
  {
    id: 'bulk',
    icon: '☑️',
    title: { en: 'Working in bulk', el: 'Ομαδικές ενέργειες', ru: 'Массовые действия', ko: '일괄 작업' },
    lead: {
      en: 'Change many books at once — it is faster and gentler on the system.',
      el: 'Αλλάξτε πολλά βιβλία μαζί — είναι πιο γρήγορο και πιο ήπιο για το σύστημα.',
      ru: 'Меняйте много книг сразу — это быстрее и бережнее к системе.',
      ko: '여러 도서를 한 번에 변경하세요 — 더 빠르고 시스템에 부담이 적습니다.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'Turn on selection, tick the books you want, and a bulk action bar appears. From there you can set the same status or shelf code on all of them, print labels for the batch, or delete them together.',
        el: 'Ενεργοποιήστε την επιλογή, τσεκάρετε τα βιβλία που θέλετε και εμφανίζεται μια μπάρα ομαδικών ενεργειών. Από εκεί μπορείτε να ορίσετε την ίδια κατάσταση ή κωδικό ραφιού σε όλα, να εκτυπώσετε ετικέτες για την παρτίδα ή να τα διαγράψετε μαζί.',
        ru: 'Включите выбор, отметьте нужные книги — появится панель массовых действий. Оттуда можно задать одинаковый статус или код полки для всех, напечатать этикетки для партии или удалить их вместе.',
        ko: '선택을 켜고 원하는 도서를 체크하면 일괄 작업 막대가 나타납니다. 거기서 모두에 동일한 상태나 서가 코드를 설정하고, 묶음 라벨을 인쇄하거나, 함께 삭제할 수 있습니다.'
      } },
      { kind: 'tip', text: {
        en: 'A bulk change counts as one operation. Re-shelving thirty books in bulk is much cheaper than editing them one by one.',
        el: 'Μια ομαδική αλλαγή μετράει ως μία ενέργεια. Η ομαδική αλλαγή ραφιού σε τριάντα βιβλία είναι πολύ πιο οικονομική από το να τα επεξεργαστείτε ένα-ένα.',
        ru: 'Массовое изменение считается одной операцией. Массово переставить тридцать книг намного экономнее, чем править их по одной.',
        ko: '일괄 변경은 한 번의 작업으로 계산됩니다. 서른 권을 일괄로 재배치하는 것이 하나씩 편집하는 것보다 훨씬 경제적입니다.'
      } }
    ]
  },
  {
    id: 'import-export',
    icon: '⇅',
    title: { en: 'Import & export', el: 'Εισαγωγή & εξαγωγή', ru: 'Импорт и экспорт', ko: '가져오기 및 내보내기' },
    lead: {
      en: 'Bring a spreadsheet in, or take your catalogue out — carefully.',
      el: 'Εισάγετε ένα υπολογιστικό φύλλο ή εξάγετε τον κατάλογό σας — προσεκτικά.',
      ru: 'Загрузите таблицу или выгрузите каталог — аккуратно.',
      ko: '스프레드시트를 가져오거나 목록을 내보내세요 — 신중하게.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'The Import/Export tab loads books from an Excel (.xlsx) file and exports your current view as CSV. When importing, always run the dry-run first: it previews what will be added and lists any rows it had to skip, so you can fix the sheet before committing.',
        el: 'Η καρτέλα Εισαγωγή/Εξαγωγή φορτώνει βιβλία από αρχείο Excel (.xlsx) και εξάγει την τρέχουσα προβολή ως CSV. Κατά την εισαγωγή, εκτελείτε πάντα πρώτα τη δοκιμαστική εκτέλεση: προεπισκοπεί τι θα προστεθεί και εμφανίζει τυχόν γραμμές που παρέλειψε, ώστε να διορθώσετε το φύλλο πριν την οριστικοποίηση.',
        ru: 'Вкладка «Импорт/Экспорт» загружает книги из файла Excel (.xlsx) и экспортирует текущий вид в CSV. При импорте всегда сначала выполняйте пробный прогон: он покажет, что будет добавлено, и перечислит пропущенные строки, чтобы вы исправили таблицу до фиксации.',
        ko: '가져오기/내보내기 탭은 Excel(.xlsx) 파일에서 도서를 불러오고 현재 보기를 CSV로 내보냅니다. 가져올 때는 항상 먼저 시험 실행을 하세요: 추가될 내용을 미리 보고 건너뛴 행을 나열하므로, 확정 전에 시트를 고칠 수 있습니다.'
      } },
      { kind: 'rule', text: {
        en: 'Read the skipped-rows report every time. A silently skipped row means a book that never made it into the catalogue.',
        el: 'Διαβάζετε κάθε φορά την αναφορά παραλειφθεισών γραμμών. Μια σιωπηρά παραλειφθείσα γραμμή σημαίνει ένα βιβλίο που δεν μπήκε ποτέ στον κατάλογο.',
        ru: 'Каждый раз читайте отчёт о пропущенных строках. Молча пропущенная строка — это книга, которая так и не попала в каталог.',
        ko: '매번 건너뛴 행 보고서를 읽으세요. 조용히 건너뛴 행은 목록에 들어가지 못한 도서를 의미합니다.'
      } }
    ]
  },
  {
    id: 'clean-data',
    icon: '🧹',
    title: { en: 'Keeping the catalogue clean', el: 'Διατήρηση καθαρού καταλόγου', ru: 'Чистота каталога', ko: '목록을 깨끗하게 유지' },
    lead: {
      en: 'Tools that repair the small inconsistencies that creep in over time.',
      el: 'Εργαλεία που διορθώνουν τις μικρές ασυνέπειες που εισχωρούν με τον καιρό.',
      ru: 'Инструменты, исправляющие мелкие несоответствия, накапливающиеся со временем.',
      ko: '시간이 지나며 생기는 작은 불일치를 바로잡는 도구들.'
    },
    blocks: [
      { kind: 'p', text: {
        en: 'Even with careful entry, small variants appear over months — "Athos Publications" and "ATHOS Publications". In Settings, the Value consistency tool groups these spelling variants together and lets you merge them into one canonical spelling in a couple of clicks.',
        el: 'Ακόμη και με προσεκτική καταχώριση, εμφανίζονται μικρές παραλλαγές με τους μήνες — «Εκδόσεις Άθως» και «ΕΚΔΟΣΕΙΣ ΑΘΩΣ». Στις Ρυθμίσεις, το εργαλείο Συνέπεια τιμών ομαδοποιεί αυτές τις παραλλαγές γραφής και σας επιτρέπει να τις συγχωνεύσετε σε μία κανονική γραφή με λίγα κλικ.',
        ru: 'Даже при аккуратном вводе за месяцы появляются мелкие варианты — «Издательство Афон» и «ИЗДАТЕЛЬСТВО АФОН». В «Настройках» инструмент «Единообразие значений» группирует такие варианты написания и позволяет объединить их в одно каноническое написание в пару кликов.',
        ko: '신중히 입력해도 몇 달이 지나면 작은 변형이 생깁니다 — "Athos 출판사"와 "ATHOS 출판사". 설정의 값 일관성 도구는 이런 표기 변형을 묶어 몇 번의 클릭으로 하나의 표준 표기로 병합해 줍니다.'
      } },
      { kind: 'p', text: {
        en: 'The Needs review list gathers books that look incomplete, and the Duplicate checker finds records that may be the same book entered twice. Sweep these occasionally to keep the catalogue trustworthy.',
        el: 'Η λίστα Απαιτείται έλεγχος συγκεντρώνει βιβλία που φαίνονται ελλιπή και ο Έλεγχος διπλότυπων βρίσκει εγγραφές που μπορεί να είναι το ίδιο βιβλίο δύο φορές. Ελέγχετέ τα περιοδικά για να διατηρείτε τον κατάλογο αξιόπιστο.',
        ru: 'Список «Требует проверки» собирает книги, выглядящие неполными, а «Проверка дубликатов» находит записи, которые могут быть одной и той же книгой дважды. Просматривайте их время от времени, чтобы каталог оставался надёжным.',
        ko: '검토 필요 목록은 불완전해 보이는 도서를 모으고, 중복 검사기는 같은 책이 두 번 입력됐을 수 있는 기록을 찾습니다. 이따금 정리하여 목록의 신뢰성을 유지하세요.'
      } }
    ]
  },
  {
    id: 'finish',
    icon: '🎉',
    title: { en: 'Tips & finish', el: 'Συμβουλές & ολοκλήρωση', ru: 'Советы и завершение', ko: '팁 및 마무리' },
    lead: {
      en: 'A few habits that keep you fast and keep the system healthy.',
      el: 'Μερικές συνήθειες που σας κρατούν γρήγορους και το σύστημα υγιές.',
      ru: 'Несколько привычек, которые ускоряют вас и берегут систему.',
      ko: '빠르게 일하고 시스템을 건강하게 유지하는 습관 몇 가지.'
    },
    blocks: [
      { kind: 'steps', items: [
        { en: 'Start from the ISBN, and always pick existing suggestions instead of retyping names.', el: 'Ξεκινάτε από το ISBN και επιλέγετε πάντα υπάρχουσες προτάσεις αντί να ξαναπληκτρολογείτε ονόματα.', ru: 'Начинайте с ISBN и всегда выбирайте существующие подсказки вместо повторного ввода имён.', ko: 'ISBN부터 시작하고, 이름을 다시 입력하지 말고 항상 기존 제안을 선택하세요.' },
        { en: 'Press "/" to search; right-click for quick actions anywhere.', el: 'Πατάτε «/» για αναζήτηση· δεξί κλικ για γρήγορες ενέργειες παντού.', ru: 'Нажимайте «/» для поиска; правый клик — быстрые действия везде.', ko: '검색은 "/", 어디서나 우클릭으로 빠른 작업.' },
        { en: 'Prefer one bulk change over many single edits — it is faster and lighter on the system.', el: 'Προτιμάτε μία ομαδική αλλαγή αντί για πολλές μεμονωμένες — είναι πιο γρήγορη και πιο ελαφριά.', ru: 'Предпочитайте одно массовое изменение множеству одиночных — быстрее и легче для системы.', ko: '여러 개별 편집보다 하나의 일괄 변경을 선호하세요 — 더 빠르고 가볍습니다.' },
        { en: 'The catalogue is cached, so you don\'t need to refresh repeatedly — the list updates itself after a change.', el: 'Ο κατάλογος αποθηκεύεται προσωρινά, οπότε δεν χρειάζεται να ανανεώνετε συνεχώς — η λίστα ενημερώνεται μόνη της μετά από αλλαγή.', ru: 'Каталог кэшируется, поэтому не нужно постоянно обновлять — список сам обновляется после изменения.', ko: '목록은 캐시되므로 반복해서 새로고침할 필요가 없습니다 — 변경 후 목록이 스스로 갱신됩니다.' }
      ] },
      { kind: 'p', text: {
        en: 'That\'s everything you need to work confidently. You can reopen this guide anytime from Settings → Librarian Guide. Welcome aboard, and happy cataloguing!',
        el: 'Αυτά είναι όλα όσα χρειάζεστε για να εργάζεστε με αυτοπεποίθηση. Μπορείτε να ανοίξετε ξανά αυτόν τον οδηγό όποτε θέλετε από Ρυθμίσεις → Οδηγός Βιβλιοθηκονόμου. Καλώς ήρθατε και καλή καταλογογράφηση!',
        ru: 'Это всё, что нужно, чтобы работать уверенно. Вы можете открыть это руководство в любой момент из Настройки → Руководство библиотекаря. Добро пожаловать и удачной каталогизации!',
        ko: '자신 있게 일하는 데 필요한 모든 것입니다. 설정 → 사서 가이드에서 언제든 다시 열 수 있습니다. 환영하며, 즐거운 목록화 되세요!'
      } }
    ]
  }
];

function Blocks({ blocks, lang }: { blocks: Block[]; lang: Lang }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'p') return <p key={i} className="ob-p">{pick(b.text, lang)}</p>;
        if (b.kind === 'tip') return (
          <div key={i} className="ob-callout ob-tip"><span className="ob-callout-label">💡 {pick(UI.tipLabel, lang)}</span>{pick(b.text, lang)}</div>
        );
        if (b.kind === 'rule') return (
          <div key={i} className="ob-callout ob-rule"><span className="ob-callout-label">⭐ {pick(UI.ruleLabel, lang)}</span>{pick(b.text, lang)}</div>
        );
        return (
          <ol key={i} className="ob-steps">
            {b.items.map((it, j) => <li key={j}>{pick(it, lang)}</li>)}
          </ol>
        );
      })}
    </>
  );
}

export function OnboardingCourse({ mandatory, onFinish, onClose }: {
  mandatory?: boolean;
  onFinish: () => void;
  onClose?: () => void;
}) {
  const { lang, setLang } = useI18n();
  const [step, setStep] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const total = CHAPTERS.length;
  const chapter = CHAPTERS[step];
  const isLast = step === total - 1;

  // Lock the page scroll while the course is open and scroll the body to the top
  // on each chapter change so every chapter starts from its title.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  useLayoutEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [step]);

  const t = (l: typeof UI[keyof typeof UI], vars?: Record<string, number>) => {
    let s = pick(l, lang);
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  };

  return (
    <div className="ob-overlay" role="dialog" aria-modal="true" aria-label={pick(UI.courseTitle, lang)}>
      <div className="ob-panel">
        <header className="ob-header">
          <div className="ob-header-title">
            <span className="ob-logo">📚</span>
            <div>
              <strong>{pick(UI.courseTitle, lang)}</strong>
              <span className="ob-progress-text">{t(UI.chapterOf, { n: step + 1, total })}</span>
            </div>
          </div>
          <div className="ob-header-right">
            <label className="ob-lang" title={pick(UI.language, lang)}>
              <span aria-hidden="true">🌐</span>
              <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={pick(UI.language, lang)}>
                <option value="en">English</option>
                <option value="el">Ελληνικά</option>
                <option value="ru">Русский</option>
                <option value="ko">한국어</option>
              </select>
            </label>
            {!mandatory && onClose && (
              <button className="ob-x" onClick={onClose} title={pick(UI.close, lang)} aria-label={pick(UI.close, lang)}>✕</button>
            )}
          </div>
        </header>

        <div className="ob-progress-bar"><div className="ob-progress-fill" style={{ width: `${((step + 1) / total) * 100}%` }} /></div>

        <div className="ob-main">
          <nav className="ob-toc" aria-label={pick(UI.contents, lang)}>
            <div className="ob-toc-title">{pick(UI.contents, lang)}</div>
            <ol>
              {CHAPTERS.map((c, i) => (
                <li key={c.id}>
                  <button
                    className={`ob-toc-item${i === step ? ' is-active' : ''}${i < step ? ' is-done' : ''}`}
                    onClick={() => setStep(i)}
                  >
                    <span className="ob-toc-icon">{i < step ? '✓' : c.icon}</span>
                    <span className="ob-toc-label">{pick(c.title, lang)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <div className="ob-body" ref={bodyRef}>
            <div className="ob-chapter-icon">{chapter.icon}</div>
            <h2 className="ob-chapter-title">{pick(chapter.title, lang)}</h2>
            <p className="ob-lead">{pick(chapter.lead, lang)}</p>
            <Blocks blocks={chapter.blocks} lang={lang} />
          </div>
        </div>

        <footer className="ob-footer">
          {mandatory && <span className="ob-mandatory-note">{pick(UI.mandatoryNote, lang)}</span>}
          <div className="ob-footer-actions">
            <button className="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>{pick(UI.back, lang)}</button>
            {isLast ? (
              <button className="primary" onClick={() => (mandatory ? onFinish() : (onClose ?? onFinish)())}>{pick(UI.finish, lang)}</button>
            ) : (
              <button className="primary" onClick={() => setStep((s) => Math.min(total - 1, s + 1))}>{pick(UI.next, lang)}</button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
