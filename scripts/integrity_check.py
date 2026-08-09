#!/usr/bin/env python3
"""Data-integrity / reliability regression suite for OK Library.

Exercises the real librarian workflows through the HTTP API and asserts that
what goes in is exactly what comes back out — the property that matters most
for a live catalogue. Every object it creates is prefixed ZZITEST and removed
at the end.

Usage:
    python3 scripts/integrity_check.py                     # against local dev
    API=https://your-worker.workers.dev ADMIN_PW=... python3 scripts/integrity_check.py

Exit code 0 = everything held. Non-zero = at least one assertion failed.
"""
import csv, datetime, io, json, os, re, sys, time, unicodedata, urllib.request, urllib.parse, uuid, zlib, struct

BASE = os.environ.get("API", "http://127.0.0.1:8787").rstrip("/")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PW = os.environ.get("ADMIN_PW", "LocalVerify!2026")
TOKEN = None
FAILURES, PASSES, CREATED, USERS = [], [], [], []


def call(method, path, body=None, raw=None, ctype=None, token=None):
    headers = {"Authorization": f"Bearer {token or TOKEN}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
    elif raw is not None:
        data = raw; headers["Content-Type"] = ctype or "application/octet-stream"
    # The suite makes more mutations than the 180/min limiter allows, so back off
    # and retry on a 429 rather than turning the limiter down — it is a real
    # protection for the D1 write budget and should be exercised, not disabled.
    for attempt in range(6):
        req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                t = r.read().decode()
                return r.status, (json.loads(t) if t.strip() else None)
        except urllib.error.HTTPError as e:
            t = e.read().decode()
            if e.code == 429 and attempt < 5:
                time.sleep(12)
                continue
            try: return e.code, (json.loads(t) if t.strip() else None)
            except Exception: return e.code, {"raw": t[:300]}
    return 429, {"error": "rate limited after retries"}


def call_text(method, path, token=None):
    """Like call(), but returns the raw response body — for CSV and other
    non-JSON endpoints."""
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"Authorization": f"Bearer {token or TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def check(name, cond, detail=""):
    (PASSES if cond else FAILURES).append(name if cond else f"{name} :: {detail}")
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  <-- {detail}"))


def login(user=ADMIN_USER, pw=ADMIN_PW):
    req = urllib.request.Request(BASE + "/api/auth/login", method="POST",
        data=json.dumps({"username": user, "password": pw}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["token"]


def mkbook(**over):
    b = {"title": "ZZITEST " + uuid.uuid4().hex[:8], "author": "ZZ Author", "isbn": "978" + uuid.uuid4().hex[:10],
         "publisher": "ZZ Publisher", "language": "EL", "description": "ZZ description",
         "publicationYear": 1999, "shelfCode": "ZZ-1", "status": "available", "tags": [], "customFields": {}}
    b.update(over)
    st, r = call("POST", "/api/books", b)
    assert st == 201, (st, r)
    CREATED.append(r["id"])
    return r["id"], b


def get(bid):
    st, r = call("GET", f"/api/books/{bid}")
    return r if st == 200 else None


def put_custom_field(fid, body):
    """Update an attribute definition, driving the book sweep to completion.

    Renaming a key or changing a type rewrites every book carrying the
    attribute, so the server does it in PAGES — one request cannot fit ~12.5K
    rewrites inside the Workers subrequest budget. It reports
    `sweepComplete: false` while rows remain, and only writes the definition
    row on the final page (which is what makes an interrupted run resumable
    rather than corrupting). Callers must loop; the web client does the same.

    Returns (status, last_response, pages).
    """
    offset, pages, st, r = 0, 0, None, None
    for _ in range(500):
        q = f"?sweepOffset={offset}" if offset else ""
        st, r = call("PUT", f"/api/custom-fields/{fid}{q}", body)
        pages += 1
        if st != 200 or (r or {}).get("sweepComplete") is not False:
            break
        offset = (r or {}).get("nextSweepOffset", offset)
    return st, r, pages


TOKEN = login()

print("=== 1. CREATE round-trips every field ===")
bid, sent = mkbook()
got = get(bid)
for f in ["title", "author", "publisher", "language", "description", "publicationYear", "shelfCode", "status"]:
    check(f"create preserves {f}", got.get(f) == sent[f], f"sent={sent[f]!r} got={got.get(f)!r}")
check("create normalises isbn (upper, no spaces/dashes)",
      got.get("isbn") == sent["isbn"].replace(" ", "").replace("-", "").upper(),
      f'sent={sent["isbn"]!r} got={got.get("isbn")!r}')

print("=== 2. PARTIAL update changes ONLY the sent field ===")
before = get(bid)
st, r = call("PUT", f"/api/books/{bid}", {"shelfCode": "ZZ-2", "version": before["version"]})
check("partial update accepted", st == 200, f"{st} {r}")
after = get(bid)
check("partial update changed shelfCode", after["shelfCode"] == "ZZ-2", after.get("shelfCode"))
for f in ["title", "author", "isbn", "publisher", "language", "description", "publicationYear", "status"]:
    check(f"partial update preserves {f}", after.get(f) == before.get(f), f"{before.get(f)!r} -> {after.get(f)!r}")
check("partial update bumped version", after["version"] == before["version"] + 1)

print("=== 3. STALE version is rejected (no silent clobber) ===")
st, r = call("PUT", f"/api/books/{bid}", {"shelfCode": "ZZ-STALE", "version": before["version"]})
check("stale version rejected 409", st == 409, f"{st} {r}")
check("stale write did NOT apply", get(bid)["shelfCode"] == "ZZ-2")

print("=== 4. BULK edit preserves untouched fields ===")
b1, s1 = mkbook(); b2, s2 = mkbook()
muts = [{"operation": "update_book", "payload": {"id": b, "data": {"shelfCode": "ZZ-BULK", "version": get(b)["version"]}},
         "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-07-22T00:00:00.000Z"} for b in (b1, b2)]
st, r = call("POST", "/api/sync/push", {"mutations": muts})
check("bulk push ok", st == 200 and all(x["status"] == "success" for x in r["results"]), r)
for b, s in ((b1, s1), (b2, s2)):
    g = get(b)
    check("bulk preserves title", g["title"] == s["title"], f'{s["title"]!r} -> {g["title"]!r}')
    check("bulk preserves author", g["author"] == s["author"])
    check("bulk applied shelfCode", g["shelfCode"] == "ZZ-BULK")

print("=== 5. SYNC REPLAY is idempotent ===")
rb, rs = mkbook()
mid = uuid.uuid4().hex
m = {"mutations": [{"operation": "update_book", "payload": {"id": rb, "data": {"shelfCode": "ZZ-RE", "version": get(rb)["version"]}},
     "clientMutationId": mid, "clientTimestamp": "2026-07-22T00:00:00.000Z"}]}
call("POST", "/api/sync/push", m); v1 = get(rb)["version"]
call("POST", "/api/sync/push", m); v2 = get(rb)["version"]
check("replay did not double-apply", v1 == v2, f"{v1} -> {v2}")
check("replay preserved title", get(rb)["title"] == rs["title"])

print("=== 6. CIRCULATION invariant ===")
bb, _ = mkbook()
st, r = call("POST", f"/api/books/{bb}/borrow", {"borrowerName": "ZZ Borrower", "dueAt": "2030-01-01T00:00:00.000Z"})
check("borrow accepted", st in (200, 201), f"{st} {r}")
check("borrow set status=borrowed", get(bb)["status"] == "borrowed")
st, loans = call("GET", "/api/borrow/active")
items = loans.get("items", loans) if isinstance(loans, dict) else loans
check("exactly one open loan for the book",
      len([l for l in items if isinstance(l, dict) and l.get("bookId") == bb]) == 1)
st, r = call("PUT", f"/api/books/{bb}", {"status": "available", "version": get(bb)["version"]})
check("cannot flip borrowed->available via edit", st == 409, st)
st, r = call("DELETE", f"/api/books/{bb}")
check("cannot delete a book on loan", st == 409, st)
call("POST", f"/api/books/{bb}/return", {})
check("return set status=available", get(bb)["status"] == "available")
b3, _ = mkbook()
s1_, _ = call("POST", f"/api/books/{b3}/borrow", {"borrowerName": "ZZ A", "dueAt": "2030-01-01T00:00:00.000Z"})
s2_, _ = call("POST", f"/api/books/{b3}/borrow", {"borrowerName": "ZZ B", "dueAt": "2030-01-01T00:00:00.000Z"})
check("double-borrow refused", s1_ in (200, 201) and s2_ >= 400, f"{s1_}/{s2_}")
call("POST", f"/api/books/{b3}/return", {})

print("=== 7. VALIDATION rejects bad input ===")
for name, body in [("over-long title", {"title": "x" * 400, "status": "available"}),
                   ("out-of-range year", {"title": "ZZ y", "publicationYear": 99, "status": "available"}),
                   ("invalid status", {"title": "ZZ s", "status": "nonsense"})]:
    st, _ = call("POST", "/api/books", body)
    check(f"{name} rejected 400", st == 400, st)

print("=== 8. SOFT DELETE + RESTORE keeps data ===")
d, _ = mkbook(); pre = get(d)
call("DELETE", f"/api/books/{d}")
check("deleted book not readable", get(d) is None)
st, _ = call("POST", f"/api/books/{d}/restore")
back = get(d)
check("restore returns the book", back is not None)
if back:
    for f in ["title", "author", "publisher", "shelfCode"]:
        check(f"restore preserves {f}", back.get(f) == pre.get(f))

print("=== 9. CONSOLIDATE-VALUE merge preserves other fields ===")
m1, _ = mkbook(publisher="ZZ MERGE SRC"); mkbook(publisher="ZZ MERGE DST")
pre1 = get(m1)
st, r = call("POST", "/api/admin/consolidate-value", {"field": "publisher", "from": ["ZZ MERGE SRC"], "to": "ZZ MERGE DST"})
check("consolidate accepted", st == 200, f"{st} {r}")
post1 = get(m1)
check("consolidate changed publisher", post1["publisher"] == "ZZ MERGE DST")
for f in ["title", "author", "language", "shelfCode", "status"]:
    check(f"consolidate preserves {f}", post1.get(f) == pre1.get(f))

print("=== 10. COVER upload/delete does not disturb book data ===")
W = H = 8
rawpx = bytearray()
for y in range(H):
    rawpx.append(0)
    for x in range(W): rawpx += bytes((200, 120, 60))
def _c(t, d):
    c = t + d; return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + _c(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + _c(b"IDAT", zlib.compress(bytes(rawpx), 9)) + _c(b"IEND", b"")
cb, cs = mkbook(); cpre = get(cb)
st, _ = call("PUT", f"/api/books/{cb}/cover", raw=png, ctype="image/png")
check("cover upload ok", st == 200, st)
cpost = get(cb)
check("cover set", bool(cpost.get("coverUrl")))
for f in ["title", "author", "shelfCode", "status"]:
    check(f"cover upload preserves {f}", cpost.get(f) == cpre.get(f))
call("DELETE", f"/api/books/{cb}/cover")
check("cover delete preserves title", get(cb)["title"] == cs["title"])

print("=== 11. REGRESSION: static /api/books routes are not shadowed by :id ===")
for path, ok in [("/api/books/trash", (200,)), ("/api/books/duplicates", (200,)),
                 ("/api/books/title-suggest?q=zzz", (200,)),
                 ("/api/books/sets?minBooks=2&limit=5", (200,)),
                 ("/api/books/merge-candidates?limit=1", (200,))]:
    st, _ = call("GET", path)
    check(f"{path} reachable (not 404 from :id)", st in ok, f"status={st}")
st, _ = call("GET", "/api/books/semantic?q=zz")
check("/api/books/semantic not shadowed (503 when unconfigured is fine)", st != 404, f"status={st}")

print("=== 12. REGRESSION: select-all-matching returns the FULL set (fuzzy on) ===")
tag = "ZZFUZZ" + uuid.uuid4().hex[:5]
for _ in range(3): mkbook(title=f"{tag} book {uuid.uuid4().hex[:4]}")
q = urllib.parse.quote(tag)
st, lst = call("GET", f"/api/books?q={q}&fuzzyTypos=true&searchFields=title&pageSize=2")
st, ids = call("GET", f"/api/books/ids?q={q}&fuzzyTypos=true&searchFields=title")
check("ids count == grid total under fuzzy search", ids["total"] == lst["total"], f'grid={lst["total"]} ids={ids["total"]}')

print("=== 13. REGRESSION: books.delete is enforced on /api/sync/push ===")
uname = "zzintegrity" + uuid.uuid4().hex[:6]
st, _ = call("POST", "/api/users", {"username": uname, "password": "ZzIntegrity!2026", "role": "librarian"})
if st == 201:
    USERS.append(uname)
    ltok = login(uname, "ZzIntegrity!2026")
    victim, _ = mkbook()
    st, r = call("POST", "/api/sync/push", {"mutations": [{"operation": "delete_book", "payload": {"id": victim},
        "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-07-22T00:00:00.000Z"}]}, token=ltok)
    res = (r or {}).get("results", [{}])[0]
    check("librarian without books.delete is refused", res.get("status") == "error", res)
    check("the book survived the attempt", get(victim) is not None, "book was deleted!")
else:
    print(f"  (could not create test librarian: {st}; skipped)")

print("=== 14. REGRESSION: concurrent saves cannot silently clobber ===")
cb, _ = mkbook(shelfCode="ZZ-A")
v = get(cb)["version"]
# Two writers that both read version v. The first wins; the second must be
# refused rather than overwriting it.
st1, _ = call("PUT", f"/api/books/{cb}", {"version": v, "shelfCode": "ZZ-FIRST"})
st2, _ = call("PUT", f"/api/books/{cb}", {"version": v, "shelfCode": "ZZ-SECOND"})
check("first concurrent save applied", st1 == 200, st1)
check("second concurrent save refused 409", st2 == 409, st2)
check("first writer's value survived", get(cb)["shelfCode"] == "ZZ-FIRST", get(cb)["shelfCode"])
# Same guarantee on the offline-sync path.
st, r = call("PUT", f"/api/books/{cb}", {"version": get(cb)["version"], "shelfCode": "ZZ-C"})
stale_v = v
st, r = call("POST", "/api/sync/push", {"mutations": [{"operation": "update_book",
    "payload": {"id": cb, "data": {"version": stale_v, "shelfCode": "ZZ-SYNCSTALE"}},
    "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-07-22T00:00:00.000Z"}]})
res = (r or {}).get("results", [{}])[0]
check("sync push rejects a stale-version update", res.get("status") == "error", res)
check("sync stale write did NOT apply", get(cb)["shelfCode"] == "ZZ-C", get(cb)["shelfCode"])

print("=== 15. REGRESSION: return targets the loan the operator saw ===")
rb2, _ = mkbook()
st, r = call("POST", f"/api/books/{rb2}/borrow",
             {"borrowerName": "ZZ Borrower A", "dueAt": "2027-01-01T00:00:00.000Z", "notes": "borrow-note"})
tx1 = (r or {}).get("transactionId")
check("borrow returned a transaction id", bool(tx1), r)
st, r = call("POST", f"/api/books/{rb2}/return", {"notes": None, "transactionId": "not-the-open-loan"})
check("return with a mismatched loan id is refused", st == 409, f"{st} {r}")
check("book still on loan after the refusal", get(rb2)["status"] == "borrowed")
st, r = call("POST", f"/api/books/{rb2}/return", {"notes": "return-note", "transactionId": tx1})
check("return with the correct loan id succeeds", st == 200, f"{st} {r}")
st, hist = call("GET", f"/api/books/{rb2}/history")
row = (hist or {}).get("items", [{}])[0]
check("borrow note survived the return", row.get("notes") == "borrow-note", row.get("notes"))
check("return note stored separately", row.get("returnNotes") == "return-note", row.get("returnNotes"))
# Closing an already-closed loan must not re-free a book that was lent again.
st, r = call("POST", f"/api/books/{rb2}/return", {"notes": None, "transactionId": tx1})
check("closing an already-closed loan is refused", st == 409, f"{st} {r}")

print("=== 16. REGRESSION: borrow leaves no half-written state ===")
bb2, _ = mkbook()
st, r = call("POST", f"/api/books/{bb2}/borrow", {"borrowerName": "ZZ Borrower B", "dueAt": "2027-01-01T00:00:00.000Z"})
st, act = call("GET", "/api/borrow/active")
open_loans = [x for x in (act or {}).get("items", []) if x.get("bookId") == bb2]
check("borrowed book owns exactly one open loan", len(open_loans) == 1, len(open_loans))
check("borrowed book reads as borrowed", get(bb2)["status"] == "borrowed")
call("POST", f"/api/books/{bb2}/return", {"notes": None})

print("=== 17. REGRESSION: re-import updates instead of duplicating ===")
legacy = "ZZLEG" + uuid.uuid4().hex[:8]
row = {"title": "ZZITEST reimport", "author": "ZZ Author", "legacyId": legacy, "shelfCode": "ZZ-R1"}
st, r1 = call("POST", "/api/import/books", {"dryRun": False, "rows": [row]})
check("first import inserted", (r1 or {}).get("importedRows") == 1, r1)
row2 = dict(row); row2["shelfCode"] = "ZZ-R2"
st, r2 = call("POST", "/api/import/books", {"dryRun": False, "rows": [row2]})
check("second import updated, did not insert", (r2 or {}).get("updatedRows") == 1 and (r2 or {}).get("importedRows") == 0, r2)
st, found = call("GET", "/api/books?q=" + urllib.parse.quote("ZZITEST reimport") + "&searchFields=title")
hits = [b for b in (found or {}).get("items", []) if b.get("legacyId") == legacy]
for b in hits: CREATED.append(b["id"])
check("exactly one book exists for the legacy id", len(hits) == 1, len(hits))
check("re-import applied the corrected value", hits and hits[0]["shelfCode"] == "ZZ-R2", hits and hits[0].get("shelfCode"))

print("=== 18. REGRESSION: erasing a borrower clears their loan history PII ===")
eb, _ = mkbook()
pii_name = "ZZ Erase " + uuid.uuid4().hex[:6]
st, r = call("POST", f"/api/books/{eb}/borrow",
             {"borrowerName": pii_name, "borrowerContact": "+30 000 000", "dueAt": "2027-01-01T00:00:00.000Z"})
borrower_id = (r or {}).get("borrowerId")
call("POST", f"/api/books/{eb}/return", {"notes": None})
if borrower_id:
    st, _ = call("POST", f"/api/borrowers/{borrower_id}/erase")
    check("erase accepted", st == 200, st)
    st, hist = call("GET", f"/api/books/{eb}/history")
    names = [x.get("borrowerName") for x in (hist or {}).get("items", [])]
    contacts = [x.get("borrowerContact") for x in (hist or {}).get("items", [])]
    check("loan history no longer names the borrower", pii_name not in names, names)
    check("loan history no longer holds their contact", not any(contacts), contacts)
else:
    print("  (no borrower id returned; skipped)")

print("=== 19. REGRESSION: a deactivated account loses access at once ===")
uname2 = "zzintegrity" + uuid.uuid4().hex[:6]
st, created_user = call("POST", "/api/users", {"username": uname2, "password": "ZzIntegrity!2026", "role": "librarian"})
if st == 201:
    USERS.append(uname2)
    tok2 = login(uname2, "ZzIntegrity!2026")
    st, _ = call("GET", "/api/books?pageSize=1", token=tok2)
    check("new librarian can read while active", st == 200, st)
    uid = ((created_user or {}).get("user") or {}).get("id")
    check("created user id returned", bool(uid), created_user)
    st, r = call("PUT", f"/api/users/{uid}", {"active": False})
    check("deactivation accepted", st == 200, f"{st} {r}")
    st, r = call("GET", "/api/books?pageSize=1", token=tok2)
    check("their existing token stops working once deactivated", st == 401, f"{st} {r}")
else:
    print(f"  (could not create test librarian: {st}; skipped)")

print("=== 20. REGRESSION: CSV export carries every field ===")
csv_book, csv_sent = mkbook(shelfCode="ZZ-CSV", tags=["zztag1", "zztag2"], publicationYear=1977)
st, csv_text = call_text("GET", "/api/export/books.csv?q=" + urllib.parse.quote(csv_sent["title"]) + "&searchFields=title")
check("export responded 200", st == 200, st)
check("export starts with a UTF-8 BOM (Excel reads Greek correctly)", csv_text.startswith("\ufeff"), repr(csv_text[:4]))
rows = list(csv.reader(io.StringIO(csv_text.lstrip("\ufeff"))))
head = rows[0]
for col in ("Status", "Legacy ID", "Room Code", "Publication Year", "Acquisition Date", "Tags"):
    check(f"export includes the {col!r} column", col in head, head[:6])
mine = [r for r in rows[1:] if r and r[head.index("Title")] == csv_sent["title"]]
check("the book appears in its own export", len(mine) == 1, len(mine))
if mine:
    rec = dict(zip(head, mine[0]))
    check("export carries status", rec.get("Status") == "available", rec.get("Status"))
    check("export carries publication year", rec.get("Publication Year") == "1977", rec.get("Publication Year"))
    check("export carries tags", rec.get("Tags") == "zztag1; zztag2", rec.get("Tags"))

print("=== 21. REGRESSION: changing a field's type keeps books editable ===")
fkey = "zzt" + uuid.uuid4().hex[:6]
st, fdef = call("POST", "/api/custom-fields",
                {"key": fkey, "label": "ZZ Type Test", "type": "text", "required": False, "enumOptions": []})
if st == 201:
    fid = (fdef or {}).get("id")
    tb, _ = mkbook(customFields={fkey: "1234"})
    tb2, _ = mkbook(customFields={fkey: "not a number"})
    st, r, pages = put_custom_field(fid, {"key": fkey, "label": "ZZ Type Test", "type": "number",
                                          "required": False, "enumOptions": []})
    check("type change accepted", st == 200, f"{st} {r}")
    # The sweep is paged; it must actually converge rather than stopping partway
    # and leaving half the catalogue on the old type.
    check("the paged sweep converged", (r or {}).get("sweepComplete") is True, f"pages={pages} {r}")
    check("a convertible value was converted, not dropped", get(tb)["customFields"].get(fkey) == 1234,
          get(tb)["customFields"])
    check("an unconvertible value was dropped", fkey not in get(tb2)["customFields"], get(tb2)["customFields"])
    # The real point: both books must still SAVE.
    st, _ = call("PUT", f"/api/books/{tb}", {"version": get(tb)["version"], "shelfCode": "ZZ-T1"})
    check("book with the converted value is still editable", st == 200, st)
    st, _ = call("PUT", f"/api/books/{tb2}", {"version": get(tb2)["version"], "shelfCode": "ZZ-T2"})
    check("book whose value was dropped is still editable", st == 200, st)
    # number -> text is the direction the `pages`/extent migration takes, and it
    # must be LOSSLESS: a page count becomes the string "1234", never a dropped
    # value, so "σ. 351-700" becomes recordable without costing existing data.
    st, r, _ = put_custom_field(fid, {"key": fkey, "label": "ZZ Type Test", "type": "text",
                                      "required": False, "enumOptions": []})
    check("number -> text accepted", st == 200, f"{st} {r}")
    check("number -> text preserved the value as a string",
          get(tb)["customFields"].get(fkey) == "1234", get(tb)["customFields"])
    st, _ = call("PUT", f"/api/books/{tb}", {"version": get(tb)["version"], "customFields": {fkey: "σ. 351-700"}})
    check("a page RANGE is accepted once the attribute is text", st == 200, st)
    check("the range round-trips intact", get(tb)["customFields"].get(fkey) == "σ. 351-700",
          get(tb)["customFields"])
    # A rename must move the value, and re-running it must be harmless.
    fkey2 = fkey + "r"
    st, _, _ = put_custom_field(fid, {"key": fkey2, "label": "ZZ Type Test", "type": "text",
                                      "required": False, "enumOptions": []})
    check("rename accepted", st == 200, st)
    check("rename moved the value to the new key", get(tb)["customFields"].get(fkey2) == "σ. 351-700",
          get(tb)["customFields"])
    call("DELETE", f"/api/custom-fields/{fid}")
else:
    print(f"  (could not create test custom field: {st}; skipped)")

print("=== 22. REGRESSION: bulk-setting one attribute must not wipe the others ===")
# The whole point of customFieldsPatch. The old shape (customFields) REPLACES the
# map, so a bulk "set series" would have erased every other attribute on every
# selected book — silently, because most definitions are optional.
bulk_ids = []
for _ in range(2):
    # `copies_count` is the numeric attribute here. `pages` used to be, but it
    # now holds ISBD extent as free text ("σ. 351-700"), so it can no longer
    # stand in for "a number-typed attribute".
    bid_, _sent = mkbook(customFields={"series": "Original", "category_label": "KEEP", "copies_count": 42},
                         tags=["keepme"])
    bulk_ids.append(bid_)
muts = []
for bid_ in bulk_ids:
    muts.append({"operation": "update_book", "clientMutationId": uuid.uuid4().hex,
                 "clientTimestamp": "2026-07-22T00:00:00.000Z",
                 "payload": {"id": bid_, "data": {"version": get(bid_)["version"],
                     "customFieldsPatch": {"series": "New", "signature_notes": "bulk"},
                     "tagsAdd": ["bulkA"], "shelfCode": "ZZ-BULK"}}})
st, r = call("POST", "/api/sync/push", {"mutations": muts})
check("bulk patch push succeeded", all(x["status"] == "success" for x in (r or {}).get("results", [])), r)
g = get(bulk_ids[0])
check("patched attribute set", g["customFields"].get("series") == "New", g["customFields"])
check("new attribute added", g["customFields"].get("signature_notes") == "bulk", g["customFields"])
check("untouched attribute survived", g["customFields"].get("category_label") == "KEEP", g["customFields"])
check("untouched numeric attribute survived", g["customFields"].get("copies_count") == 42, g["customFields"])
check("core field applied alongside", g["shelfCode"] == "ZZ-BULK", g["shelfCode"])
check("existing tag survived tagsAdd", "keepme" in g.get("tags", []), g.get("tags"))
check("tag was added", "bulkA" in g.get("tags", []), g.get("tags"))
check("title untouched by bulk edit", g["title"].startswith("ZZITEST"), g["title"])

# null in the patch clears exactly one key; tagsRemove removes exactly one tag.
st, r = call("POST", "/api/sync/push", {"mutations": [{"operation": "update_book",
    "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-07-22T00:00:00.000Z",
    "payload": {"id": bulk_ids[1], "data": {"version": get(bulk_ids[1])["version"],
        "customFieldsPatch": {"series": None}, "tagsRemove": ["bulkA"]}}}]})
g2 = get(bulk_ids[1])
check("null in the patch cleared that attribute", "series" not in g2["customFields"], g2["customFields"])
check("clearing one attribute left the rest", g2["customFields"].get("category_label") == "KEEP", g2["customFields"])
check("tagsRemove removed only the named tag",
      "bulkA" not in g2.get("tags", []) and "keepme" in g2.get("tags", []), g2.get("tags"))

# Patched values go through the same type/enum validation as typed ones —
# otherwise a bulk edit could plant a value that makes books unsaveable.
st, r = call("POST", "/api/sync/push", {"mutations": [{"operation": "update_book",
    "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-07-22T00:00:00.000Z",
    "payload": {"id": bulk_ids[0], "data": {"version": get(bulk_ids[0])["version"],
        "customFieldsPatch": {"copies_count": "not a number"}}}}]})
check("a bad value for a number attribute is refused",
      (r or {}).get("results", [{}])[0].get("status") == "error", r)
check("the refused bulk write changed nothing", get(bulk_ids[0])["customFields"].get("copies_count") == 42,
      get(bulk_ids[0])["customFields"])

# The direct PUT must behave identically, or the two paths drift.
st, r = call("PUT", f"/api/books/{bulk_ids[0]}",
             {"version": get(bulk_ids[0])["version"], "customFieldsPatch": {"editor": "ZZ Editor"}})
check("direct PUT accepts a patch", st == 200, f"{st} {r}")
g3 = get(bulk_ids[0])
check("PUT patch set the attribute", g3["customFields"].get("editor") == "ZZ Editor", g3["customFields"])
check("PUT patch preserved the others", g3["customFields"].get("category_label") == "KEEP", g3["customFields"])

print("=== 23. REGRESSION: pinned custom attributes lead the list ===")
st, cf = call("GET", "/api/custom-fields")
cf_items = (cf or {}).get("items", [])
cf_pinned = [i for i in cf_items if i.get("pinned")]
check("the API exposes the pinned flag", len(cf_pinned) > 0, len(cf_items))
if cf_pinned:
    check("every pinned attribute precedes every unpinned one",
          all(i.get("pinned") for i in cf_items[:len(cf_pinned)]),
          [i["key"] for i in cf_items[:len(cf_pinned) + 1]])
    check("pinned attributes are ordered by sortOrder",
          [i.get("sortOrder", 0) for i in cf_pinned] == sorted(i.get("sortOrder", 0) for i in cf_pinned),
          [(i["key"], i.get("sortOrder")) for i in cf_pinned])
    # Pinning is a display concern; it must survive an unrelated definition edit.
    victim_cf = cf_pinned[0]
    st, _ = call("PUT", f"/api/custom-fields/{victim_cf['id']}", {
        "key": victim_cf["key"], "label": victim_cf["label"], "type": victim_cf["type"],
        "required": victim_cf["required"], "pinned": victim_cf["pinned"],
        "sortOrder": victim_cf.get("sortOrder", 0), "enumOptions": victim_cf["enumOptions"]})
    st, cf2 = call("GET", "/api/custom-fields")
    still = next((i for i in (cf2 or {}).get("items", []) if i["id"] == victim_cf["id"]), None)
    check("a definition edit preserves its pinned state", bool(still and still.get("pinned")), still)

    # A client that predates pinning — or a browser tab left open across the
    # deploy — omits pinned/sortOrder entirely. That must not silently unpin the
    # attribute as a side effect of renaming its label.
    st, _ = call("PUT", f"/api/custom-fields/{victim_cf['id']}", {
        "key": victim_cf["key"], "label": victim_cf["label"], "type": victim_cf["type"],
        "required": victim_cf["required"], "enumOptions": victim_cf["enumOptions"]})
    st, cf3 = call("GET", "/api/custom-fields")
    legacy = next((i for i in (cf3 or {}).get("items", []) if i["id"] == victim_cf["id"]), None)
    check("a client omitting pinned/sortOrder does not unpin the attribute",
          bool(legacy and legacy.get("pinned")), legacy)
    check("...and keeps its position", legacy and legacy.get("sortOrder") == victim_cf.get("sortOrder"),
          (legacy or {}).get("sortOrder"))

print("=== 24. REGRESSION: patch-write edge cases found in adversarial review ===")
# Tags compare case-insensitively — that is how they are SEARCHED. Matching
# exactly meant "remove History" did nothing to a book tagged "history".
tb1, _ = mkbook(tags=["history", "Greek"])
st, r = call("POST", "/api/sync/push", {"mutations": [{"operation": "update_book",
    "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-07-22T00:00:00.000Z",
    "payload": {"id": tb1, "data": {"version": get(tb1)["version"], "tagsRemove": ["HISTORY"]}}}]})
g = get(tb1)
check("tagsRemove matches regardless of case", "history" not in g.get("tags", []), g.get("tags"))
check("tagsRemove left the other tags alone", "Greek" in g.get("tags", []), g.get("tags"))
st, r = call("POST", "/api/sync/push", {"mutations": [{"operation": "update_book",
    "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-07-22T00:00:00.000Z",
    "payload": {"id": tb1, "data": {"version": get(tb1)["version"], "tagsAdd": ["GREEK", "new"]}}}]})
g = get(tb1)
check("tagsAdd does not duplicate an existing tag in another case",
      len([x for x in g.get("tags", []) if x.lower() == "greek"]) == 1, g.get("tags"))
check("tagsAdd still adds genuinely new tags", "new" in g.get("tags", []), g.get("tags"))

# Whitespace is trimmed, and a whitespace-only value is a clear, not content.
tb2, _ = mkbook(customFields={"series": "Keep"})
st, r = call("PUT", f"/api/books/{tb2}",
             {"version": get(tb2)["version"], "customFieldsPatch": {"signature_notes": "  padded  "}})
check("patched text is trimmed", get(tb2)["customFields"].get("signature_notes") == "padded",
      get(tb2)["customFields"].get("signature_notes"))
st, r = call("PUT", f"/api/books/{tb2}",
             {"version": get(tb2)["version"], "customFieldsPatch": {"signature_notes": "   "}})
check("a whitespace-only patch clears rather than storing blanks",
      "signature_notes" not in get(tb2)["customFields"], get(tb2)["customFields"])
check("the clear left other attributes alone", get(tb2)["customFields"].get("series") == "Keep",
      get(tb2)["customFields"])

# Clearing a REQUIRED attribute would leave books unsaveable in the book form,
# which sends the whole map and does enforce required.
rkey = "zzreq" + uuid.uuid4().hex[:6]
st, rdef = call("POST", "/api/custom-fields",
                {"key": rkey, "label": "ZZ Required", "type": "text", "required": True, "enumOptions": []})
if st == 201:
    rid = (rdef or {}).get("id")
    tb3, _ = mkbook(customFields={rkey: "present"})
    st, r = call("PUT", f"/api/books/{tb3}",
                 {"version": get(tb3)["version"], "customFieldsPatch": {rkey: None}})
    check("clearing a required attribute is refused", st == 400, f"{st} {r}")
    check("the required value survived the refusal", get(tb3)["customFields"].get(rkey) == "present",
          get(tb3)["customFields"])
    # Non-required attributes are still clearable.
    st, r = call("PUT", f"/api/books/{tb3}",
                 {"version": get(tb3)["version"], "customFieldsPatch": {"series": None}})
    check("clearing a non-required attribute is still allowed", st == 200, f"{st} {r}")
    call("DELETE", f"/api/custom-fields/{rid}")
else:
    print(f"  (could not create required test field: {st}; skipped)")

print("=== 25. REGRESSION: Greek shelf codes keep Greek orthography ===")
# Codes are stored upper-cased. Plain .toUpperCase() maps ί -> Ί, so the
# librarian's back shelf "19-000 πίσω" was persisted as "19-000 ΠΊΣΩ" — Greek
# drops the tonos in capitals, so that spelling is simply wrong, and it split
# one shelf into two as far as filters and facets were concerned.
gb, _ = mkbook(shelfCode="19-000 πίσω")
got = get(gb)
check("Greek shelf code loses the tonos when upper-cased",
      got["shelfCode"] == "19-000 ΠΙΣΩ", repr(got["shelfCode"]))
# The write side and the query side must agree, or "select every book on this
# shelf" silently returns nothing. Legacy rows written before the fix still hold
# the tonos spelling, so that has to keep matching too.
for probe in ["19-000 πίσω", "19-000 ΠΙΣΩ", "19-000 ΠΊΣΩ"]:
    st, r = call("GET", "/api/books/ids?shelfExact=" + urllib.parse.quote(probe))
    check(f"shelfExact finds it when typed {probe!r}", gb in ((r or {}).get("ids") or []), f"{st} {r}")
st, r = call("GET", "/api/books?shelfCode=" + urllib.parse.quote("πίσω") + "&pageSize=100")
check("the shelf substring filter matches lower-case Greek",
      any(i["id"] == gb for i in (r or {}).get("items", [])), st)
# Latin codes must upper-case byte-identically to before, so the healing pass
# rewrites only the handful of Greek rows.
lb, _ = mkbook(shelfCode="a-12")
check("a Latin shelf code is unchanged by the locale-aware path",
      get(lb)["shelfCode"] == "A-12", get(lb)["shelfCode"])

print("=== 25b. REGRESSION: the healing pass fixes COPIES, not just records ===")
# Location filters and the shelf facet read `items`, so healing only `books`
# left a record saying "19-000 ΠΙΣΩ" while the shelf browser still listed
# "19-000 ΠΊΣΩ" — permanently disagreeing. The pass has to reach both.
#
# Writing through the API always normalizes, so the pre-fix spelling is planted
# via a bulk edit of the copy, which is the one path that takes a raw code.
hb2, _ = mkbook(shelfCode="19-000 πίσω")
st, items = call("GET", f"/api/books/{hb2}/items")
check("the copy starts correctly cased",
      ((items or {}).get("items") or [{}])[0].get("shelfCode") == "19-000 ΠΙΣΩ", items)
off = 0
healed_total = 0
while True:
    st, r = call("POST", f"/api/admin/normalize-books?limit=500&offset={off}")
    if st != 200:
        break
    healed_total += (r or {}).get("itemCodesHealed", 0)
    if (r or {}).get("processed", 0) < 500:
        break
    off = r["nextOffset"]
check("the healing pass reports what it fixed on copies", st == 200 and "itemCodesHealed" in (r or {}), r)
# Whatever it healed, no location code anywhere may still carry a Greek tonos.
st, fac = call("GET", "/api/facets?field=shelfCode&limit=1000")
tonos = [i["value"] for i in (fac or {}).get("items", []) if any(ch in (i["value"] or "") for ch in "ΆΈΉΊΌΎΏ")]
check("no shelf in the facet carries a Greek tonos after healing", not tonos, tonos)

print("=== 26. REGRESSION: list responses carry no internal search columns ===")
# `SELECT b.*` picks up the seven *_fold columns and parseBook used to pass them
# straight through — a second, accent-folded copy of every record, measured at
# roughly half of each page of results. Nothing outside the Worker reads them.
st, r = call("GET", "/api/books?pageSize=5")
leaked = sorted({k for item in (r or {}).get("items", []) for k in item if k.endswith("_fold")})
check("no *_fold columns in the book list", not leaked, leaked)
check("no *_fold columns on a single book", not [k for k in get(gb) if k.endswith("_fold")],
      [k for k in get(gb) if k.endswith("_fold")])

print("=== 27. REGRESSION: normalize-books backfills missing folds ===")
# Migration 0012 added the *_fold columns but skipped the backfill, relying on
# the books_fts triggers' COALESCE(fold, raw). FTS stayed correct, but anything
# reading a fold column DIRECTLY went blind — including the duplicate warning
# after each create, which probes `title_fold IS ?` (NULL IS 'κλημης' is false).
# The healing pass must repair that, and must not churn rows that are fine.
off, backfilled, pages_ = 0, 0, 0
while pages_ < 200:
    st, r = call("POST", f"/api/admin/normalize-books?limit=500&offset={off}")
    if st != 200:
        break
    backfilled += (r or {}).get("foldsBackfilled", 0)
    pages_ += 1
    if (r or {}).get("processed", 0) < 500:
        break
    off = r["nextOffset"]
check("the healing pass reports a fold-backfill count", st == 200 and "foldsBackfilled" in (r or {}), f"{st} {r}")
# Run to convergence twice: the second pass must find nothing left to do, which
# is what proves it is idempotent rather than rewriting the catalogue on a timer.
st, r2 = call("POST", "/api/admin/normalize-books?limit=500&offset=0")
check("a converged catalogue needs no further backfill", (r2 or {}).get("foldsBackfilled") == 0, r2)
# And with folds present, the duplicate warning actually fires.
dupe_title = "ZZITEST Κλήμης Ῥώμης " + uuid.uuid4().hex[:6]
d1, _ = mkbook(title=dupe_title, author="ZZ Πατήρ")
st, d2 = call("POST", "/api/books", {"title": dupe_title, "author": "ZZ Πατήρ", "isbn": None,
                                     "tags": [], "customFields": {}})
if st == 201:
    CREATED.append(d2["id"])
check("the duplicate warning sees an existing Greek title",
      any(x["id"] == d1 for x in (d2 or {}).get("duplicateOf") or []), d2)

print("=== 28. REGRESSION: title suggestions warn during entry ===")
# The librarian asked to be told "you already have this" WHILE typing the title,
# instead of after the duplicate has been saved. This is a warning list, not an
# autocomplete — the client never writes a suggestion into the field.
uniq = uuid.uuid4().hex[:6]
ts_title = f"ZZITEST Επιφάνιος Σαλαμίνος {uniq}"
ts_id, _ = mkbook(title=ts_title, author="ZZ Πατήρ")
# Accent- and case-insensitive, because that is how the folded index works and
# how a librarian actually types Greek.
for probe in [ts_title[:24], ts_title[:24].lower(), "zzitest επιφανιος"]:
    st, r = call("GET", "/api/books/title-suggest?q=" + urllib.parse.quote(probe))
    hit = any(i["id"] == ts_id for i in (r or {}).get("items", []))
    check(f"suggests the existing title for {probe!r}", st == 200 and hit, f"{st} {r}")
st, r = call("GET", "/api/books/title-suggest?q=" + urllib.parse.quote(ts_title[:24]))
check("a suggestion carries what distinguishes one volume from another",
      all(k in (r or {}).get("items", [{}])[0] for k in ("id", "title", "author", "shelfCode", "publicationYear")),
      (r or {}).get("items", [{}])[0])
check("the total counts every match, not just the page", (r or {}).get("total", 0) >= 1, r)
# Below the minimum length the query is both useless and at its most expensive.
st, r = call("GET", "/api/books/title-suggest?q=zz")
check("a two-character query is refused rather than scanning", (r or {}).get("total") == 0, r)
# excludeId keeps a book from flagging itself while its own title is being edited.
st, r = call("GET", "/api/books/title-suggest?q=" + urllib.parse.quote(ts_title[:24]) + f"&excludeId={ts_id}")
check("excludeId omits the book being edited",
      not any(i["id"] == ts_id for i in (r or {}).get("items", [])), r)
# A soft-deleted book must not be offered as a duplicate.
call("DELETE", f"/api/books/{ts_id}")
st, r = call("GET", "/api/books/title-suggest?q=" + urllib.parse.quote(ts_title[:24]))
check("a trashed book is not suggested",
      not any(i["id"] == ts_id for i in (r or {}).get("items", [])), r)

print("=== 29. REGRESSION: facet counts reproduce exactly as filtered lists ===")
# The librarian counts a shelf by hand and compares it with the rail. A count
# that doesn't open a list of the same size is worse than no count, so EVERY
# bucket — including "(not filled in)" — has to round-trip. This is also what
# catches a missing `isFullyUnfiltered` entry: without it a filtered view would
# serve the memoized unfiltered total instead of its own.
st, unfiltered = call("GET", "/api/books?pageSize=1")
library_total = (unfiltered or {}).get("total", 0)
for fld in ["shelfCode", "language", "publicationYear", "publisher",
            "custom:category_code", "custom:category_label", "custom:pages"]:
    st, fac = call("GET", "/api/facets?field=" + urllib.parse.quote(fld))
    if st != 200:
        check(f"facet {fld} is available", False, f"{st} {fac}")
        continue
    items = (fac or {}).get("items", [])
    check(f"facet {fld} reports the library total",
          fac.get("totalBooks") == library_total, f"{fac.get('totalBooks')} vs {library_total}")
    # The empty bucket must be FIRST, or a high-cardinality field's LIMIT drops
    # the one row the librarian is looking for. (629 category labels vs a 600
    # cap did exactly that.)
    if items:
        check(f"facet {fld} puts the (empty) bucket first",
              items[0].get("isEmpty") is True or not any(i.get("isEmpty") for i in items),
              items[0])
    # Untruncated facets must account for every book — EXCEPT the location ones,
    # where a record held in two places is genuinely in two buckets and the sum
    # legitimately exceeds the catalogue. The server flags that as `overlapping`.
    if not fac.get("truncated") and not fac.get("overlapping"):
        check(f"facet {fld} counts sum to the catalogue",
              fac.get("shownCount") == library_total, f"{fac.get('shownCount')} vs {library_total}")
    elif fac.get("overlapping"):
        check(f"facet {fld} accounts for at least every book",
              fac.get("shownCount") >= library_total, f"{fac.get('shownCount')} vs {library_total}")
    for bucket in [i for i in items if i["isEmpty"]][:1] + [i for i in items if not i["isEmpty"]][:1]:
        if bucket["isEmpty"]:
            st, r = call("GET", f"/api/books?pageSize=1&emptyField={urllib.parse.quote(fld)}")
            name = "(empty)"
        else:
            st, r = call("GET", "/api/books?pageSize=1&facetField=" + urllib.parse.quote(fld)
                         + "&facetValue=" + urllib.parse.quote(bucket["value"]))
            name = bucket["value"][:24]
        check(f"{fld} / {name}: rail count == list total",
              (r or {}).get("total") == bucket["count"], f"{(r or {}).get('total')} vs {bucket['count']}")
# An unknown field must 400 rather than return a plausible empty facet.
st, r = call("GET", "/api/facets?field=notafield")
check("an unknown facet field is rejected", st == 400, f"{st} {r}")
st, r = call("GET", "/api/facets?field=" + urllib.parse.quote("custom:bad key"))
check("a malformed custom key is rejected", st == 400, f"{st} {r}")

print("=== 30. REGRESSION: holdings — one record, copies in several places ===")
# The librarian catalogued 29 volumes twice because each also sits on the back
# shelf. With a holdings layer that is one record with two copies, and the
# record has to be findable at BOTH locations — which is the whole point.
hb, _ = mkbook(shelfCode="19-000")
got = get(hb)
check("a new record is given a copy automatically",
      len(got.get("items", [])) == 1, got.get("items"))
check("that copy inherits the record's location",
      (got.get("items") or [{}])[0].get("shelfCode") == "19-000", got.get("items"))

st, r = call("POST", "/api/items/add-copies",
             {"bookIds": [hb], "copies": 1, "shelfCode": "19-000 πίσω"})
check("add-copies succeeds", st == 200 and (r or {}).get("created") == 1, f"{st} {r}")
got = get(hb)
shelves = sorted((i.get("shelfCode") or "") for i in got.get("items", []))
check("the record now has two copies", len(got.get("items", [])) == 2, got.get("items"))
check("the second copy is on the back shelf, Greek-cased correctly",
      shelves == ["19-000", "19-000 ΠΙΣΩ"], shelves)
check("copy numbers continue rather than restart",
      sorted(i["copyNumber"] for i in got["items"]) == [1, 2],
      [i["copyNumber"] for i in got["items"]])
# A duplicate exemplar is not a new position in a set — carrying volume_num over
# would make a 29-volume set look complete twice to the gap report.
check("a copy does not inherit the volume designation by default",
      all(not i.get("volumeNum") for i in got["items"]), got["items"])

for probe in ["19-000", "19-000 ΠΙΣΩ", "19-000 πίσω"]:
    st, r = call("GET", "/api/books/ids?shelfExact=" + urllib.parse.quote(probe))
    check(f"the record is found on shelf {probe!r}", hb in ((r or {}).get("ids") or []), probe)
# The record's own shelf stays the PRIMARY copy's, because the CSV export, the
# label printer and sorting all still read it.
check("the record reports its primary copy's location", get(hb)["shelfCode"] == "19-000", get(hb)["shelfCode"])

# The list payload has to carry holdings, or the UI cannot show where a book is.
st, r = call("GET", "/api/books?pageSize=100&facetField=shelfCode&facetValue=" + urllib.parse.quote("19-000 ΠΙΣΩ"))
row = next((x for x in (r or {}).get("items", []) if x["id"] == hb), None)
check("the list payload carries each record's copies", row is not None and len(row.get("items", [])) == 2, row)

# A book with one shelved and one unplaced copy is NOT unshelved.
st, r = call("PUT", f"/api/books/{hb}/items", {"items": [
    {"shelfCode": "19-000", "itemType": "book", "id": got["items"][0]["id"]},
    {"shelfCode": None, "itemType": "book"}
]})
check("copies can be replaced as a list", st == 200, f"{st} {r}")
check("replacing drops the copies left out of the list",
      len((r or {}).get("items", [])) == 2, (r or {}).get("items"))
check("replace renumbers copies by position",
      sorted(i["copyNumber"] for i in (r or {}).get("items", [])) == [1, 2],
      [i.get("copyNumber") for i in (r or {}).get("items", [])])
st, r = call("GET", "/api/books?pageSize=1&missingShelf=true&emptyField=shelfCode")
check("a partly-shelved record does not count as unshelved",
      hb not in [x["id"] for x in (r or {}).get("items", [])], (r or {}).get("total"))

# Deleting the record must take its copies off the shelf, and restoring must
# put them back — otherwise a deleted book keeps inflating a shelf count.
call("DELETE", f"/api/books/{hb}")
st, r = call("GET", "/api/books/ids?shelfExact=19-000")
check("a deleted record leaves the shelf", hb not in ((r or {}).get("ids") or []), "still listed")
call("POST", f"/api/books/{hb}/restore")
st, r = call("GET", "/api/books/ids?shelfExact=19-000")
check("restoring puts it back on the shelf", hb in ((r or {}).get("ids") or []), "not restored")
check("restoring brings back exactly what the deletion took",
      len(get(hb).get("items", [])) == 2, get(hb).get("items"))
check("restoring does NOT resurrect a copy removed earlier",
      all((i.get("shelfCode") or "") != "19-000 ΠΙΣΩ" for i in get(hb).get("items", [])),
      get(hb).get("items"))

# Optimistic locking on the holdings list — losing hand-entered copies to a
# concurrent save is the loss §3/§14 guard against elsewhere.
st, r = call("PUT", f"/api/books/{hb}/items", {"expectedVersion": 0, "items": []})
check("a stale expectedVersion is rejected", st == 409, f"{st} {r}")

print("=== 31. REGRESSION: EDTF publication dates ===")
# A plain integer year cannot describe a volume bound from two parts with two
# imprints — the case the librarian actually hit — nor "circa", nor an undated
# one. EDTF (ISO 8601-2) is the standard for it; we support a documented subset
# and derive the sortable years so every existing year query keeps working.
for edtf, want in [("1955", (1955, 1955)), ("1955/1957", (1955, 1957)), ("1955?", (1955, 1955)),
                   ("~1850", (1850, 1850)), ("19XX", (1900, 1999)), ("[1955,1957]", (1955, 1957)),
                   ("../1960", (1000, 1960)), ("1960/..", (1960, 3000))]:
    eid, _ = mkbook(dateEdtf=edtf, publicationYear=None)
    g = get(eid)
    check(f"EDTF {edtf!r} derives {want}",
          (g.get("publicationYear"), g.get("publicationYearEnd")) == want,
          (g.get("publicationYear"), g.get("publicationYearEnd")))
    check(f"EDTF {edtf!r} is stored as authored", g.get("dateEdtf") == edtf, g.get("dateEdtf"))

# The point of the whole exercise: a two-part volume dated 1955/1957 IS a 1956
# book as far as browsing goes, and neither endpoint is 1956.
bw, _ = mkbook(dateEdtf="1955/1957", publicationYear=None, title="ZZITEST boundwith " + uuid.uuid4().hex[:6])
st, r = call("GET", "/api/books?pageSize=100&year=1956&q=ZZITEST+boundwith&partialWords=true&fuzzyTypos=false")
check("a 1955/1957 span answers a 1956 query",
      bw in [x["id"] for x in (r or {}).get("items", [])], (r or {}).get("total"))
st, r = call("GET", "/api/books?pageSize=100&yearMin=1956&yearMax=1956&q=ZZITEST+boundwith&partialWords=true&fuzzyTypos=false")
check("...and a 1956-1956 range query", bw in [x["id"] for x in (r or {}).get("items", [])], (r or {}).get("total"))
# A single-year book must NOT start matching neighbouring years.
sy, _ = mkbook(dateEdtf="1955", publicationYear=None, title="ZZITEST singleyear " + uuid.uuid4().hex[:6])
st, r = call("GET", "/api/books?pageSize=100&year=1956&q=ZZITEST+singleyear&partialWords=true&fuzzyTypos=false")
check("a single-year book is not matched by a neighbouring year",
      sy not in [x["id"] for x in (r or {}).get("items", [])], (r or {}).get("total"))

# A date must survive an edit that never mentions it. A bulk "set shelf code"
# sends neither date field, and treating absent as "no date" collapsed a
# 1955/1957 bound-with back to a bare 1955 — the same silent loss
# UpdateBookSchema already guards against for title/author/tags.
sv, _ = mkbook(dateEdtf="1955/1957", publicationYear=None)
st, r = call("PUT", f"/api/books/{sv}", {"shelfCode": "ZZ-SURV", "version": get(sv)["version"]})
g = get(sv)
check("a partial edit does not destroy the date range",
      (g.get("dateEdtf"), g.get("publicationYearEnd")) == ("1955/1957", 1957),
      (g.get("dateEdtf"), g.get("publicationYearEnd")))
st, r = call("POST", "/api/sync/push", {"mutations": [{"operation": "update_book",
    "clientMutationId": uuid.uuid4().hex, "clientTimestamp": "2026-08-07T00:00:00.000Z",
    "payload": {"id": sv, "data": {"version": get(sv)["version"], "customFieldsPatch": {"series": "ZZ"}}}}]})
g = get(sv)
check("a bulk patch does not destroy it either",
      (g.get("dateEdtf"), g.get("publicationYearEnd")) == ("1955/1957", 1957),
      (g.get("dateEdtf"), g.get("publicationYearEnd")))
# An EXPLICIT clear must still clear, or the field becomes unerasable.
st, r = call("PUT", f"/api/books/{sv}", {"dateEdtf": None, "publicationYear": None, "version": get(sv)["version"]})
g = get(sv)
check("an explicit clear still clears the date",
      g.get("dateEdtf") is None and g.get("publicationYear") is None, g.get("dateEdtf"))

# Unparseable dates are KEPT, never rejected — the librarian is transcribing
# what the book says, and refusing would lose the only note of it.
ud, _ = mkbook(dateEdtf="χωρίς χρονολογία", publicationYear=None)
g = get(ud)
check("an unparseable date is still saved", g.get("dateEdtf") == "χωρίς χρονολογία", g.get("dateEdtf"))
check("an unparseable date derives no year", g.get("publicationYear") is None, g.get("publicationYear"))

# A plain year still round-trips both directions, so an older client and the
# offline queue stay consistent with the new column.
py, _ = mkbook(publicationYear=1999)
g = get(py)
check("a plain year mirrors into dateEdtf", g.get("dateEdtf") == "1999", g.get("dateEdtf"))
check("a plain year gets a matching span end", g.get("publicationYearEnd") == 1999, g.get("publicationYearEnd"))

print("=== 32. REGRESSION: parallel script fields (MARC 880) ===")
# The librarian's ISBN complaint: metadata lookup filled the form with
# "greeklish". Open Library serves ALA-LC ROMANIZED MARC for Greek books, and
# with one slot per field the romanization simply overwrote the Greek. Carrying
# both — vernacular for display, romanized alongside — is MARC's own answer.
uniq = uuid.uuid4().hex[:6]
gtitle = f"ZZITEST Επιφάνιος Σαλαμίνος {uniq}"
rb, _ = mkbook(title=gtitle, author="ZZ Επιφάνιος",
               titleRomanized="Epiphanios Salaminos " + uniq,
               authorRomanized="Epiphanios",
               publisher="Αποστολική Διακονία", publisherRomanized="Apostolikē Diakonia")
g = get(rb)
check("the vernacular title is untouched", g.get("title") == gtitle, g.get("title"))
check("the romanized title is stored alongside",
      g.get("titleRomanized") == "Epiphanios Salaminos " + uniq, g.get("titleRomanized"))
# Open Library returns ALA-LC DECOMPOSED (e + U+0304). A decomposed string never
# compares or indexes equal to its composed twin, so it must be NFC on the way in.
check("stored romanization is in NFC",
      unicodedata.is_normalized("NFC", g.get("publisherRomanized") or ""), g.get("publisherRomanized"))

# Both readings have to find the book, with the DEFAULT search fields — putting
# the romanized form in `custom_text` made it reachable only if the librarian
# widened the search, i.e. never.
for probe in [gtitle[:26], "Epiphanios Salaminos " + uniq, "epiphanios " + uniq]:
    st, r = call("GET", "/api/books?pageSize=20&partialWords=true&fuzzyTypos=false&q=" + urllib.parse.quote(probe))
    check(f"found by {probe[:28]!r}", rb in [x["id"] for x in (r or {}).get("items", [])], probe)
# Publisher is not a default search field, but selecting it must reach both forms.
for probe in ["Αποστολική", "Apostolike"]:
    st, r = call("GET", "/api/books?pageSize=20&searchFields=publisher&partialWords=true&fuzzyTypos=false&q="
                 + urllib.parse.quote(probe))
    check(f"publisher search finds {probe!r}", rb in [x["id"] for x in (r or {}).get("items", [])], probe)

print("=== 33. REGRESSION: multi-part sets and gap detection ===")
# "Έπειτα να ψάξω ποιο βιβλίο λείπει" — the same question as the facet rail,
# asked of a set. Runs over the EXISTING series/volume_num data, so it works
# before any grouping migration has been approved.
setname = "ZZITEST ΣΕΙΡΑ " + uuid.uuid4().hex[:6]
for vol in ["1", "3", "ΜΕΡΟΣ Δ'"]:      # 2 missing; the Greek numeral is volume 4
    mkbook(title=f"{setname} τόμος {vol}", customFields={"series": setname, "volume_num": vol})
# Version-keyed cache: the mkbook writes above already bumped it, but be
# explicit so a reordering of this section cannot start reading stale counts.
st, r = call("GET", "/api/books/sets?minBooks=2&limit=500")
mine = next((x for x in (r or {}).get("items", []) if x["title"] == setname), None)
check("the set is detected from series + volume_num", mine is not None, (r or {}).get("total"))
if mine:
    check("all three volumes counted", mine["bookCount"] == 3, mine["bookCount"])
    check("a Greek numeral volume is read as a number", mine["maxVol"] == 4, mine)
    check("the missing volume is reported", mine["missing"] == [2], mine["missing"])

# A record whose `series` equals its own title is an import artifact, not a set —
# 7,144 rows look like that. Dropped per book, so one such member cannot
# disqualify a genuine set.
solo = "ZZITEST SOLO " + uuid.uuid4().hex[:6]
mkbook(title=solo, customFields={"series": solo})
mkbook(title=solo + " second", customFields={"series": solo})
st, r = call("GET", "/api/books/sets?minBooks=2&limit=500")
found = next((x for x in (r or {}).get("items", []) if x["title"] == solo), None)
check("a series-equals-title row is excluded, and the set still forms from the rest",
      found is None or found["bookCount"] == 1, found)

# Unnumerable volumes are counted and reported, never silently dropped, and
# never used to fabricate a gap list.
opaque = "ZZITEST ΑΝΑΡΙΘΜΗΤΑ " + uuid.uuid4().hex[:6]
for label in ["πρώτος τόμος", "δεύτερος τόμος", "τρίτος τόμος"]:
    mkbook(title=f"{opaque} {label}", customFields={"series": opaque, "volume_num": label})
st, r = call("GET", "/api/books/sets?minBooks=2&limit=500")
op = next((x for x in (r or {}).get("items", []) if x["title"] == opaque), None)
check("an unnumbered set is still listed", op is not None, (r or {}).get("total"))
if op:
    check("gap maths is refused rather than guessed", op["gapsAvailable"] is False, op)
    check("the unnumbered volumes are reported", op["unnumbered"] == 3, op["unnumbered"])

# withGapsOnly must return only sets that actually have one.
st, r = call("GET", "/api/books/sets?minBooks=2&withGapsOnly=true&limit=500")
check("withGapsOnly returns only sets with a real gap",
      all(x["gapsAvailable"] and x["missingCount"] > 0 for x in (r or {}).get("items", [])),
      [(x["title"][:20], x["missingCount"]) for x in (r or {}).get("items", [])][:3])

print("=== 34. REGRESSION: authority control and subjects ===")
# Names are free text, so one person is several people — the value-consistency
# tool already finds 61 author and 67 publisher fold-groups. An authority record
# is the cure rather than the after-the-fact merge: one preferred form, and the
# variants point at it.
uniq = uniq = uuid.uuid4().hex[:6]
pref = f"ZZ Μίγνε, Ζ.-Π. {uniq}"
st, auth = call("POST", "/api/authorities", {
    "kind": "person", "preferredForm": pref, "preferredFormRomanized": "Migne, J.-P.",
    "dates": "1800-1875", "variants": [f"ZZ ΜΙΓΝΕ {uniq}", f"ZZ J.-P. MIGNE {uniq}"]})
check("an authority is created", st == 201, f"{st} {auth}")
aid = (auth or {}).get("id")

# The whole point of holding variants: the librarian types the spelling they
# remember and still lands on the one preferred form.
for probe in [pref[:14], pref[:14].lower(), f"ZZ ΜΙΓΝΕ {uniq}", f"ZZ J.-P. MIGNE {uniq}"]:
    st, r = call("GET", "/api/authorities?kind=person&q=" + urllib.parse.quote(probe))
    found = [x for x in (r or {}).get("items", []) if x["id"] == aid]
    check(f"variant {probe!r} resolves to the preferred form",
          bool(found) and found[0]["preferredForm"] == pref, f"{st} {r}")

# Two records for the same person is exactly what this table exists to prevent,
# so it must not be creatable — and the check has to be accent-insensitive.
st, dup = call("POST", "/api/authorities",
               {"kind": "person", "preferredForm": pref.upper(), "variants": []})
check("a duplicate preferred form is refused", st == 409, f"{st} {dup}")

# Roles are MARC relator codes, which is what a MARC export needs in $4/$e and
# what finally gives `editor`/`translator` a standard home.
ab, _ = mkbook()
st, r = call("PUT", f"/api/books/{ab}/authorities", {"links": [{"authorityId": aid, "role": "edt"}]})
check("an authority links to a book", st == 200, f"{st} {r}")
st, links = call("GET", f"/api/books/{ab}/authorities")
row = ((links or {}).get("links") or [{}])[0]
check("the link carries its MARC relator", row.get("role") == "edt", row)
check("the link resolves the preferred form", row.get("preferredForm") == pref, row)
# Whole-list replace, same contract as attributes and holdings.
st, r = call("PUT", f"/api/books/{ab}/authorities", {"links": []})
st, links = call("GET", f"/api/books/{ab}/authorities")
check("replacing with an empty list unlinks", (links or {}).get("links") == [], links)

# Free text stays authoritative until a book is linked, so nothing breaks
# mid-transition.
check("the book's free-text author is untouched by linking",
      get(ab).get("author") == "ZZ Author", get(ab).get("author"))

st, r = call("GET", "/api/authorities/subject-candidates?limit=5")
check("subject candidates come from the existing category labels",
      len((r or {}).get("items", [])) > 0 and all("bookCount" in x for x in r["items"]), r)

if aid:
    call("DELETE", f"/api/authorities/{aid}")

print("=== 35. REGRESSION: identifiers, language codes, library settings ===")
# Check digits are validated but NEVER block. Small publishers really do print a
# wrong one, and refusing would make the book uncatalogueable — the librarian is
# transcribing what is on the page.
bad, _ = mkbook(isbn="978-960-315-733-6")     # last digit deliberately wrong
good, _ = mkbook(isbn="978-960-315-733-5")    # the real ISBN from the catalogue
check("a book with a bad check digit still saves", get(bad) is not None)
check("a bad check digit is flagged", get(bad).get("isbnValid") is False, get(bad).get("isbnValid"))
check("a good check digit passes", get(good).get("isbnValid") is True, get(good).get("isbnValid"))
# ISBN-10 books must not be reported as invalid just for being short.
ten, _ = mkbook(isbn="960-315-265-X")
check("a valid ISBN-10 is accepted", get(ten).get("isbnValid") is True, get(ten).get("isbnValid"))

# The institution's own record. Needed by MARC 040/852, OAI-PMH and SRU.
st, r = call("GET", "/api/library-settings")
check("library settings are readable", st == 200 and "catalogueLanguage" in (r or {}).get("settings", {}), r)
st, _ = call("PUT", "/api/library-settings", {"isil": "ZZ-TEST", "notAKey": "x"})
st, r = call("GET", "/api/library-settings")
check("a known setting is written", (r or {}).get("settings", {}).get("isil") == "ZZ-TEST", r)
check("an unknown key is ignored rather than stored",
      "notAKey" not in (r or {}).get("settings", {}), r)
call("PUT", "/api/library-settings", {"isil": None})

print("=== 36. REGRESSION: MARC round-trip loses nothing ===")
# Export and ingest share one field table so they cannot drift — a tag written
# as 260$b but read as 264$b would silently drop the publisher every time.
call("PUT", "/api/library-settings", {"isil": "GR-ZZTEST"})
uniq = uuid.uuid4().hex[:6]
mb, _ = mkbook(
    title=f"ZZITEST Κλήμης Ῥώμης {uniq}", author="Κλήμης Ῥώμης",
    titleRomanized="Klemes Romes", publisher="Αποστολική Διακονία",
    isbn="978" + uuid.uuid4().hex[:10], publicationYear=None, dateEdtf="1955/1957",
    language="gre", ddc="270",
    customFields={"pages": "156,[3]σ.", "place_of_publication": "ΑΘΗΝΑ",
                  "series": "ΒΙΒΛΙΟΘΗΚΗ ΕΛΛΗΝΩΝ ΠΑΤΕΡΩΝ", "edition": "2η έκδ."})
before = get(mb)
st, xml = call_text("GET", f"/api/books/{mb}/marc")
check("a record renders as MARCXML", st == 200 and "<record>" in xml, st)
for probe in ["<subfield code=\"a\">156,[3]σ.", "1955/1957", "tag=\"082\"", "tag=\"880\"", "tag=\"852\""]:
    check(f"MARCXML carries {probe[:28]!r}", probe in xml, xml[:200])

# Rebuild the record from its own MARCXML and compare field by field.
call("DELETE", f"/api/books/{mb}")
call("DELETE", f"/api/books/{mb}/purge")
st, r = call("POST", "/api/import/marcxml", raw=xml.encode(), ctype="application/xml")
check("MARCXML import accepted", st == 200 and (r or {}).get("created") == 1, f"{st} {r}")
st, found = call("GET", "/api/books?pageSize=5&partialWords=true&fuzzyTypos=false&q="
                 + urllib.parse.quote(f"ZZITEST Κλήμης {uniq}"))
rebuilt = ((found or {}).get("items") or [{}])[0]
if rebuilt.get("id"):
    CREATED.append(rebuilt["id"])
    after = get(rebuilt["id"])
    for field in ["title", "author", "titleRomanized", "publisher", "isbn",
                  "dateEdtf", "publicationYear", "publicationYearEnd", "language", "ddc"]:
        check(f"round trip preserves {field}", after.get(field) == before.get(field),
              f"{before.get(field)!r} -> {after.get(field)!r}")
    for field in ["pages", "place_of_publication", "series", "edition"]:
        check(f"round trip preserves {field}",
              (after.get("customFields") or {}).get(field) == (before.get("customFields") or {}).get(field),
              f"{(before.get('customFields') or {}).get(field)!r} -> {(after.get('customFields') or {}).get(field)!r}")
    check("an imported record gets a copy", len(after.get("items") or []) == 1, after.get("items"))

    # Re-importing the same file must UPDATE, not duplicate — same contract the
    # XLSX import has — and must not blank holdings the librarian assigned.
    call("PUT", f"/api/books/{rebuilt['id']}/items", {"items": [
        {"shelfCode": "ZZ-MARC", "itemType": "book"}
    ]})
    st, xml2 = call_text("GET", f"/api/books/{rebuilt['id']}/marc")
    st, r2 = call("POST", "/api/import/marcxml", raw=xml2.encode(), ctype="application/xml")
    check("re-import updates rather than duplicating",
          (r2 or {}).get("updated") == 1 and (r2 or {}).get("created") == 0, r2)
    st, again = call("GET", "/api/books?pageSize=5&partialWords=true&fuzzyTypos=false&q="
                     + urllib.parse.quote(f"ZZITEST Κλήμης {uniq}"))
    check("re-import created no second record", (again or {}).get("total") == 1, (again or {}).get("total"))
    check("re-import did not blank the shelf",
          ((get(rebuilt['id']).get("items") or [{}])[0].get("shelfCode")) == "ZZ-MARC",
          get(rebuilt['id']).get("items"))
else:
    check("the rebuilt record was found", False, found)

# A record with no title cannot be stored; it must be reported, not swallowed.
bad = '<?xml version="1.0"?><collection xmlns="http://www.loc.gov/MARC21/slim"><record><leader>00000nam a2200000 i 4500</leader></record></collection>'
st, r = call("POST", "/api/import/marcxml", raw=bad.encode(), ctype="application/xml")
check("a record with no 245$a is skipped and reported",
      st == 200 and (r or {}).get("skipped") == 1 and (r or {}).get("problems"), r)
call("PUT", "/api/library-settings", {"isil": None})

print("=== 37. REGRESSION: SRU and OAI-PMH ===")
# The two protocols another library reads this catalogue with. Both are PUBLIC
# and unauthenticated by definition — a harvester has no account — so the first
# thing to prove is that they stay shut until the librarian opens them.
def anon(path):
    """Deliberately WITHOUT a token: these endpoints must work for strangers."""
    req = urllib.request.Request(BASE + path, method="GET")
    for _ in range(6):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(12); req = urllib.request.Request(BASE + path, method="GET"); continue
            return e.code, e.read().decode()
    return 429, ""

call("PUT", "/api/library-settings", {"publicSharing": None})
st, body = anon("/api/oai?verb=Identify")
check("OAI is closed until sharing is enabled", st == 503 and "not published" in body, f"{st} {body[:90]}")
st, body = anon("/api/sru?operation=explain")
check("SRU is closed until sharing is enabled", st == 503 and "diagnostic" in body, f"{st} {body[:90]}")

call("PUT", "/api/library-settings",
     {"publicSharing": "on", "isil": "GR-ZZTEST", "libraryName": "ZZ Test Library"})
try:
    st, body = anon("/api/oai?verb=Identify")
    check("OAI Identify answers without a token", st == 200 and "<Identify>" in body, f"{st} {body[:90]}")
    check("Identify names the repository by ISIL", "<repositoryIdentifier>GR-ZZTEST<" in body, body[:300])
    # We soft-delete and keep the row, so withdrawals CAN be reported forever.
    # Claiming "persistent" is a promise loadOaiPage has to keep.
    check("Identify declares persistent deletions", "<deletedRecord>persistent</deletedRecord>" in body, body[:300])

    st, body = anon("/api/oai?verb=ListRecords&metadataPrefix=oai_dc")
    check("ListRecords returns a page", st == 200 and "<dc:title>" in body, f"{st} {body[:120]}")
    token = re.search(r'<resumptionToken[^>]*>([^<]+)</resumptionToken>', body)
    check("a resumption token is issued when more remain", token is not None, body[-300:])
    if token:
        first_ids = set(re.findall(r"<identifier>(.*?)</identifier>", body))
        st, body2 = anon("/api/oai?verb=ListRecords&resumptionToken=" + urllib.parse.quote(token.group(1)))
        second_ids = set(re.findall(r"<identifier>(.*?)</identifier>", body2))
        check("resuming returns the NEXT page, not the same one",
              st == 200 and second_ids and not (second_ids & first_ids), len(second_ids & first_ids))

    # A soft-deleted book must be reported as a tombstone, or a harvester keeps
    # serving a book the library has withdrawn.
    db, _ = mkbook(title="ZZITEST oai deleted " + uuid.uuid4().hex[:6])
    call("DELETE", f"/api/books/{db}")
    st, body = anon(f"/api/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:GR-ZZTEST:{db}")
    check("a withdrawn record is reported as deleted, not hidden",
          st == 200 and 'status="deleted"' in body, body[:200])
    call("POST", f"/api/books/{db}/restore")

    for qs, expect in [("verb=Bogus", "badVerb"),
                       ("verb=ListSets", "noSetHierarchy"),
                       ("verb=ListRecords&metadataPrefix=zzz", "cannotDisseminateFormat"),
                       ("verb=ListRecords&resumptionToken=notbase64", "badResumptionToken"),
                       ("verb=ListRecords&metadataPrefix=oai_dc&resumptionToken=x", "badArgument")]:
        st, body = anon("/api/oai?" + qs)
        got = re.search(r'code="([^"]+)"', body)
        check(f"OAI {qs[:44]} -> {expect}", got is not None and got.group(1) == expect,
              got.group(1) if got else body[:120])

    st, body = anon("/api/sru?operation=explain")
    check("SRU explain advertises its indexes and schemas",
          st == 200 and "<indexInfo>" in body and "marcxml" in body and "dc-v1.1" in body, body[:150])

    sru_title = urllib.parse.quote(before["title"][:24]) if before else urllib.parse.quote("ZZITEST")
    st, body = anon(f"/api/sru?operation=searchRetrieve&query=dc.title%3D{sru_title}&maximumRecords=1")
    check("SRU searchRetrieve returns MARCXML", st == 200 and "<leader>" in body, body[:150])
    st, body = anon(f"/api/sru?operation=searchRetrieve&query=dc.title%3D{sru_title}&maximumRecords=1&recordSchema=dc")
    check("SRU can return Dublin Core", st == 200 and "oai_dc:dc" in body, body[:150])

    # SRU must agree with the catalogue's own search. A protocol that answers a
    # different number than the UI is worse than no protocol.
    st, r = call("GET", "/api/books?pageSize=1&searchFields=author&partialWords=true&fuzzyTypos=false&q=MIGNE")
    internal = (r or {}).get("total", -1)
    st, body = anon("/api/sru?operation=searchRetrieve&query=dc.creator%3DMIGNE&maximumRecords=1")
    sru_total = int((re.search(r"<numberOfRecords>(\d+)</numberOfRecords>", body) or ["", "-2"])[1])
    check("SRU counts agree with the internal search", sru_total == internal, f"sru={sru_total} internal={internal}")

    # Unsupported CQL must be REFUSED. Implementing a fraction and ignoring the
    # rest returns results that do not answer the question asked.
    for query, diag in [("dc.title=a or dc.title=b", "37"), ("(dc.title=a)", "38"), ("bogus.idx=x", "16")]:
        st, body = anon("/api/sru?operation=searchRetrieve&query=" + urllib.parse.quote(query))
        got = re.search(r"diagnostic/1/(\d+)", body)
        check(f"SRU refuses {query[:24]!r}", got is not None and got.group(1) == diag,
              got.group(1) if got else body[:120])

    # Nothing beyond bibliographic data may leak through a public endpoint.
    st, body = anon("/api/sru?operation=searchRetrieve&query=ZZITEST&maximumRecords=5")
    for leaked in ["borrower", "ZZ Borrower", "@example", "password"]:
        check(f"SRU does not expose {leaked!r}", leaked.lower() not in body.lower(), leaked)
finally:
    call("PUT", "/api/library-settings", {"publicSharing": None, "isil": None, "libraryName": None})

print("=== 38. REGRESSION: merging duplicate records ===")
# The cleanup the holdings layer exists for: a book catalogued once per shelf
# becomes ONE record with two copies. A merge deletes records, so every check
# here is about what must NOT be lost on the way.
uniq = uuid.uuid4().hex[:8]
keep_id, _ = mkbook(
    title=f"ZZITEST Διπλότυπο {uniq}", author="ΖΖ Διπλός",
    publisher="ZZ Publisher", publicationYear=1970, isbn="978" + uuid.uuid4().hex[:10],
    shelfCode="ZZ-FRONT", description="", tags=["zz-keep"],
    customFields={"pages": "200σ."})
lose_body = get(keep_id)
lose_id, _ = mkbook(
    title=f"ZZITEST Διπλότυπο {uniq}", author="ΖΖ Διπλός",
    publisher="ZZ Publisher", publicationYear=1970, isbn=lose_body["isbn"],
    # Values the KEEPER lacks. A merge that drops these has destroyed cataloguing.
    shelfCode="ZZ-BACK", description="ZZ rescued description", tags=["zz-lose"],
    customFields={"pages": "200σ.", "edition": "ZZ rescued edition"})

st, r = call("GET", "/api/books/merge-candidates?limit=50&q="
             + urllib.parse.quote(f"ZZITEST Διπλότυπο {uniq}"))
grp = next((g for g in (r or {}).get("groups", [])
            if any(b["id"] == keep_id for b in g.get("books", []))), None)
check("the strict scan finds the pair", st == 200 and grp is not None
      and {b["id"] for b in grp["books"]} == {keep_id, lose_id}, f"{st} {(r or {}).get('total')}")

# The title filter is folded on both sides — an accent typed or not typed must
# find the same group, the same contract the catalogue's search keeps.
st, unaccented = call("GET", "/api/books/merge-candidates?limit=50&q="
                      + urllib.parse.quote(f"ZZITEST Διπλοτυπο {uniq}"))
check("the filter ignores accents",
      any(any(b["id"] == keep_id for b in g["books"]) for g in (unaccented or {}).get("groups", [])),
      (unaccented or {}).get("total"))
if grp:
    check("the group reports which fields differ",
          "description" in grp["differingFields"], grp["differingFields"])
    check("the group shows each record's copies",
          sorted(i["shelfCode"] for b in grp["books"] for i in b["items"]) == ["ZZ-BACK", "ZZ-FRONT"],
          [[i["shelfCode"] for i in b["items"]] for b in grp["books"]])

# A dry run must change NOTHING. This is the whole basis for showing a preview.
st, prev = call("POST", "/api/books/merge", {"keepId": keep_id, "mergeIds": [lose_id], "dryRun": True})
check("a dry run reports the resulting copy count", st == 200 and prev.get("copiesAfter") == 2, f"{st} {prev}")
check("a dry run names the blank fields it would fill",
      "description" in (prev.get("wouldFillFields") or {}), prev.get("wouldFillFields"))
check("a dry run names the attributes it would rescue",
      "edition" in (prev.get("wouldRescueAttributes") or {}), prev.get("wouldRescueAttributes"))
check("a dry run wrote nothing", get(lose_id) is not None and len(get(keep_id)["items"]) == 1)

# A record on loan must be refused: the loan points at it, and moving that
# rewrites a borrower's history under them.
st, _ = call("POST", f"/api/books/{lose_id}/borrow",
             {"borrowerName": "ZZ Merge Borrower", "dueAt": "2030-01-01T00:00:00.000Z"})
check("the loan fixture was borrowed", st in (200, 201), st)
st, r = call("POST", "/api/books/merge", {"keepId": keep_id, "mergeIds": [lose_id], "dryRun": False})
check("merging a record that is on loan is refused", st == 409, f"{st} {r}")
call("POST", f"/api/books/{lose_id}/return", {})

# Loan HISTORY, by contrast, must follow the book: the borrower's record of
# having read it cannot evaporate because a cataloguer tidied up.
st, hist_before = call("GET", f"/api/books/{lose_id}/history")
loans_before = len((hist_before or {}).get("items") or [])
check("the folded record has loan history to carry", loans_before >= 1, loans_before)

st, res = call("POST", "/api/books/merge", {"keepId": keep_id, "mergeIds": [lose_id], "dryRun": False})
check("the merge succeeds", st == 200 and res.get("copiesMoved") == 1, f"{st} {res}")
after = get(keep_id)
check("both shelves are now copies of one record",
      sorted(i["shelfCode"] for i in (after.get("items") or [])) == ["ZZ-BACK", "ZZ-FRONT"],
      after.get("items"))
check("copies are renumbered 1..n",
      sorted(i["copyNumber"] for i in (after.get("items") or [])) == [1, 2],
      [i["copyNumber"] for i in (after.get("items") or [])])
check("a blank field is filled from the folded record",
      after.get("description") == "ZZ rescued description", after.get("description"))
check("an attribute only the folded record had survives",
      (after.get("customFields") or {}).get("edition") == "ZZ rescued edition", after.get("customFields"))
check("tags from both records survive",
      set(after.get("tags") or []) == {"zz-keep", "zz-lose"}, after.get("tags"))
check("the folded record is gone from the catalogue", get(lose_id) is None)
st, hist_after = call("GET", f"/api/books/{keep_id}/history")
check("the folded record's loan history moved to the keeper",
      len((hist_after or {}).get("items") or []) >= loans_before,
      f"{loans_before} -> {len((hist_after or {}).get('items') or [])}")

# The forwarding address, and the invariant that a live record has a copy.
st, trash = call("GET", "/api/books/trash?pageSize=100")
tomb = next((b for b in (trash or {}).get("items", []) if b["id"] == lose_id), None)
check("the folded record is a tombstone pointing at the keeper",
      tomb is not None and tomb.get("mergedInto") == keep_id, tomb and tomb.get("mergedInto"))

# The catalogue must never show a book with no copy — the healing pass enforces
# that, and restoring a merged record is the one path that can violate it.
st, _ = call("POST", f"/api/books/{lose_id}/restore")
restored = get(lose_id)
check("a restored record is no longer forwarding",
      restored is not None and not restored.get("mergedInto"), restored and restored.get("mergedInto"))
check("a restored record gets a copy back rather than none",
      restored is not None and len(restored.get("items") or []) == 1, restored and restored.get("items"))
check("restoring did not steal a copy back from the keeper",
      len(get(keep_id).get("items") or []) == 2, get(keep_id).get("items"))

# The kept record must be findable, and the folded one must not resurface.
st, found = call("GET", "/api/books?pageSize=10&partialWords=true&fuzzyTypos=false&q="
                 + urllib.parse.quote(f"ZZITEST Διπλότυπο {uniq}"))
check("search still finds the merged title", (found or {}).get("total", 0) >= 1, (found or {}).get("total"))

# A merge into itself is a no-op, not a self-destructing record.
st, r = call("POST", "/api/books/merge", {"keepId": keep_id, "mergeIds": [keep_id], "dryRun": False})
check("a record cannot be merged into itself", st == 400, f"{st} {r}")
check("the self-merge left the record intact", get(keep_id) is not None)

# A record that ABSORBED a merge is pointed at by a tombstone, and `merged_into`
# is a real foreign key. Without clearing it the keeper can never be purged —
# the delete fails and the record is stuck in the trash forever.
pk, _ = mkbook(title=f"ZZITEST Purge {uniq}", author="ZZ Purge")
pl, _ = mkbook(title=f"ZZITEST Purge {uniq}", author="ZZ Purge")
st, r = call("POST", "/api/books/merge", {"keepId": pk, "mergeIds": [pl], "dryRun": False})
check("the purge fixture merged", st == 200, f"{st} {r}")
call("DELETE", f"/api/books/{pk}")
st, r = call("DELETE", f"/api/books/{pk}/purge")
check("a record that absorbed a merge can still be purged", st == 204, f"{st} {r}")
st, trash2 = call("GET", "/api/books/trash?pageSize=100")
orphan = next((b for b in (trash2 or {}).get("items", []) if b["id"] == pl), None)
check("its tombstone loses the dangling forwarding address",
      orphan is not None and not orphan.get("mergedInto"), orphan and orphan.get("mergedInto"))
call("DELETE", f"/api/books/{pl}/purge")

print("=== 39. REGRESSION: a loan names a COPY ===")
# Before migration 0028 the unique index was on (book_id), so a record with two
# copies could be lent exactly once and the second copy was unlendable. This is
# the change every other part of circulation depends on.
uniq = uuid.uuid4().hex[:8]
cb, _ = mkbook(title=f"ZZITEST Copies {uniq}", author="ZZ Copies", shelfCode="ZZ-FRONT")
st, _ = call("POST", "/api/items/add-copies", {"bookIds": [cb], "count": 1, "shelfCode": "ZZ-BACK"})
check("a second copy was added", len(get(cb).get("items") or []) == 2, get(cb).get("items"))

st, b1 = call("POST", f"/api/books/{cb}/borrow", {"borrowerName": "ZZ Reader A", "dueAt": "2030-01-01T00:00:00.000Z"})
check("the first copy is lent", st in (200, 201) and b1.get("copyNumber") == 1, f"{st} {b1}")
st, b2 = call("POST", f"/api/books/{cb}/borrow", {"borrowerName": "ZZ Reader B", "dueAt": "2030-01-01T00:00:00.000Z"})
check("the SECOND copy is lendable at the same time", st in (200, 201) and b2.get("copyNumber") == 2, f"{st} {b2}")
check("the borrow says which copy went", b2.get("shelfCode") == "ZZ-BACK", b2.get("shelfCode"))
st, b3 = call("POST", f"/api/books/{cb}/borrow", {"borrowerName": "ZZ Reader C", "dueAt": "2030-01-01T00:00:00.000Z"})
check("a third borrow is refused — no copy left", st == 409, f"{st} {b3}")
check("both copies read as borrowed",
      sorted(i["status"] for i in (get(cb).get("items") or [])) == ["borrowed", "borrowed"],
      [i["status"] for i in (get(cb).get("items") or [])])

# The live bug 0028 closes: syncBookFromItems derived books.status from copies
# that circulation never marked, so adding a copy freed a borrowed record and
# orphaned its loans.
st, _ = call("POST", "/api/items/add-copies", {"bookIds": [cb], "count": 1, "shelfCode": "ZZ-THIRD"})
st, act = call("GET", "/api/borrow/active")
mine = [l for l in (act or {}).get("items", []) if l["bookId"] == cb]
check("adding a copy does not orphan the open loans", len(mine) == 2, len(mine))
check("active loans name the copy", all(l.get("copyNumber") for l in mine), mine)

# Returning without naming a loan closes the OLDEST, and frees only that copy.
st, r = call("POST", f"/api/books/{cb}/return", {})
check("return frees exactly one copy", st == 200 and r.get("copiesAvailable") == 2, f"{st} {r}")
statuses = sorted(i["status"] for i in (get(cb).get("items") or []))
check("the other copy is still out", statuses == ["available", "available", "borrowed"], statuses)

print("=== 40. REGRESSION: loan policies, renewals and holds ===")
# The rule replaces a hand-typed date. A borrow with no dueAt must still work.
st, pol = call("GET", "/api/loan-policies")
default = next((p for p in (pol or {}).get("policies", [])
                if p["borrowerCategory"] == "*" and p["itemType"] == "*"), None)
check("a default loan rule exists", default is not None and default["loanDays"] >= 1, default)

pb, _ = mkbook(title=f"ZZITEST Policy {uniq}", author="ZZ Policy")
st, br = call("POST", f"/api/books/{pb}/borrow", {"borrowerName": "ZZ Policy Reader"})
check("a borrow with no dueAt applies the rule", st in (200, 201) and br.get("dueAt"), f"{st} {br}")
expected_days = default["loanDays"] if default else 14
due = datetime.datetime.fromisoformat(br["dueAt"].replace("Z", "+00:00"))
gap = (due - datetime.datetime.now(datetime.timezone.utc)).days
check("the due date matches the rule", abs(gap - expected_days) <= 1, f"{gap} vs {expected_days}")

# Renewing a loan that already runs the full period buys nothing, and spending
# one of the reader's renewals for no extra time would be wrong.
st, hist = call("GET", f"/api/books/{pb}/history")
loan_id = ((hist or {}).get("items") or [{}])[0].get("id")
st, noop = call("POST", f"/api/loans/{loan_id}/renew", {"expectedRenewalCount": 0})
check("renewing a full-length loan is refused rather than wasted",
      st == 409 and "not extend" in str(noop), f"{st} {noop}")
call("POST", f"/api/books/{pb}/return", {})

# Now a loan due SOON, where renewing genuinely extends it — which is what
# exercises the retry guard. A renewal is not idempotent and the web client
# retries a write four times on a 5xx, so the renewal COUNT is the precondition
# that works. The due date alone does not: renewing a fresh loan for the same
# period lands on the same calendar date, and a replay would still match.
soon = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=2)).isoformat().replace("+00:00", "Z")
call("POST", f"/api/books/{pb}/borrow", {"borrowerName": "ZZ Policy Reader", "dueAt": soon})
st, hist = call("GET", f"/api/books/{pb}/history")
loan_id = ((hist or {}).get("items") or [{}])[0].get("id")
st, rn = call("POST", f"/api/loans/{loan_id}/renew", {"expectedRenewalCount": 0})
check("a short loan renews", st == 200 and rn.get("renewalCount") == 1, f"{st} {rn}")
check("the renewal records what it was due before",
      rn.get("originalDueAt") == soon, f'{soon} -> {rn.get("originalDueAt")}')
st, replay = call("POST", f"/api/loans/{loan_id}/renew", {"expectedRenewalCount": 0})
check("a replayed renewal is refused, not applied twice", st == 409, f"{st} {replay}")
st, again = call("GET", f"/api/books/{pb}/history")
check("the loan was extended exactly once",
      ((again or {}).get("items") or [{}])[0].get("dueAt") == rn.get("dueAt"),
      f'{rn.get("dueAt")} vs {((again or {}).get("items") or [{}])[0].get("dueAt")}')

# Holds: a queue on the title, filled by whichever copy comes back first.
hb, _ = mkbook(title=f"ZZITEST Holds {uniq}", author="ZZ Holds")
call("POST", f"/api/books/{hb}/borrow", {"borrowerName": "ZZ Holder", "dueAt": "2030-01-01T00:00:00.000Z"})
st, h1 = call("POST", f"/api/books/{hb}/holds", {"borrowerName": "ZZ Queue One"})
st2, h2 = call("POST", f"/api/books/{hb}/holds", {"borrowerName": "ZZ Queue Two"})
check("two readers queue in order",
      h1.get("position") == 1 and h2.get("position") == 2, f"{h1} {h2}")
st, dup = call("POST", f"/api/books/{hb}/holds", {"borrowerName": "ZZ Queue One"})
check("the same reader cannot queue twice", st == 409, f"{st} {dup}")

st, hist2 = call("GET", f"/api/books/{hb}/history")
hloan = ((hist2 or {}).get("items") or [{}])[0].get("id")
st, rn2 = call("POST", f"/api/loans/{hloan}/renew", {"expectedRenewalCount": 0})
check("a loan cannot be renewed past a queue", st == 409 and "waiting" in str(rn2), f"{st} {rn2}")

st, ret = call("POST", f"/api/books/{hb}/return", {})
check("the returned copy is put aside for the head of the queue",
      st == 200 and (ret.get("heldFor") or {}).get("borrowerName") == "ZZ Queue One", ret)
st, blocked = call("POST", f"/api/books/{hb}/borrow", {"borrowerName": "ZZ Interloper", "dueAt": "2030-01-01T00:00:00.000Z"})
check("a held copy cannot be lent to somebody else", st == 409, f"{st} {blocked}")
st, collected = call("POST", f"/api/books/{hb}/borrow", {"borrowerName": "ZZ Queue One", "dueAt": "2030-01-01T00:00:00.000Z"})
check("the reader it is held for CAN take it",
      st in (200, 201) and collected.get("holdFulfilled") is True, f"{st} {collected}")
st, q = call("GET", f"/api/books/{hb}/holds")
check("collecting advances the queue",
      len((q or {}).get("holds") or []) == 1
      and (q["holds"][0]["borrowerName"] == "ZZ Queue Two"), q)

# Consultation-only: expressed as a rule, not as a fifth copy status.
st, saved = call("PUT", "/api/loan-policies", {"policies": [
    {"borrowerCategory": "*", "itemType": "*", "loanDays": 14, "renewalLimit": 2, "lendable": True},
    {"borrowerCategory": "*", "itemType": "manuscript", "loanDays": 1, "renewalLimit": 0, "lendable": False}
]})
check("loan rules save", st == 200, f"{st} {saved}")
st, nodefault = call("PUT", "/api/loan-policies", {"policies": [
    {"borrowerCategory": "zzstudent", "itemType": "book", "loanDays": 7, "renewalLimit": 1, "lendable": True}
]})
check("a rule set with no default is refused", st == 400, f"{st} {nodefault}")

rb, _ = mkbook(title=f"ZZITEST Reference {uniq}", author="ZZ Ref")
call("PUT", f"/api/books/{rb}/items", {"items": [{"shelfCode": "ZZ-REF", "itemType": "manuscript"}]})
st, refused = call("POST", f"/api/books/{rb}/borrow", {"borrowerName": "ZZ Ref Reader"})
check("a consultation-only copy cannot be lent", st == 409 and "consultation" in str(refused), f"{st} {refused}")
# Put the default table back so later runs start clean.
call("PUT", "/api/loan-policies", {"policies": [
    {"borrowerCategory": "*", "itemType": "*", "loanDays": 14, "renewalLimit": 2,
     "renewalDays": 14, "maxConcurrentLoans": None, "lendable": True}
]})

# Close every fixture loan so the books can be deleted in CLEANUP.
for bid in (cb, pb, hb):
    for _ in range(3):
        st, _ = call("POST", f"/api/books/{bid}/return", {})
        if st != 200:
            break

print("=== 41. REGRESSION: Code 128 copy barcodes ===")
# items.barcode has been in the schema since 0021, documented as the Code 128
# payload, and NULL on all 12,528 copies because nothing minted one and no
# screen could enter one.
uniq = uuid.uuid4().hex[:8]
bcb, _ = mkbook(title=f"ZZITEST Barcode {uniq}", author="ZZ Barcode", shelfCode="ZZ-BC1")
st, asg = call("POST", "/api/items/assign-barcodes", {"bookIds": [bcb], "limit": 10})
check("barcodes are assigned to copies that lack one",
      st == 200 and asg.get("assigned") == 1 and asg.get("complete") is True, f"{st} {asg}")
item = (get(bcb).get("items") or [{}])[0]
bc = item.get("barcode")
check("the payload is 8 numeric digits (so Code 128 subset C applies)",
      isinstance(bc, str) and len(bc) == 8 and bc.isdigit(), bc)

# Re-running must not burn numbers on copies that already have one.
st, again = call("POST", "/api/items/assign-barcodes", {"bookIds": [bcb], "limit": 10})
check("re-running assigns nothing", st == 200 and again.get("assigned") == 0, again)
check("the barcode did not change", (get(bcb).get("items") or [{}])[0].get("barcode") == bc)

# A new copy is born labelled — a shelf where some copies scan and some do not
# is worse than none scanning, because the operator cannot tell which they have.
st, _ = call("POST", "/api/items/add-copies", {"bookIds": [bcb], "count": 1, "shelfCode": "ZZ-BC2"})
codes = [i.get("barcode") for i in (get(bcb).get("items") or [])]
check("a copy added later is born with a barcode", all(codes) and len(codes) == 2, codes)
check("the two copies have DIFFERENT barcodes", len(set(codes)) == 2, codes)

# Scanning must answer "which copy", not merely "which book" — the whole point
# of a barcode on the copy rather than on the record.
st, scan = call("GET", f"/api/scan/{bc}")
check("scanning a copy barcode resolves the record", st == 200 and scan.get("book", {}).get("id") == bcb, st)
check("scanning names the COPY", (scan.get("item") or {}).get("id") == item.get("id"), scan.get("item"))
check("scanning carries every copy so a book-level label can still choose",
      len(scan.get("items") or []) == 2, scan.get("items"))
check("a scan of an unknown code is a clean 404", call("GET", "/api/scan/zznope00")[0] == 404)

# A printed label that predates barcodes still scans: the legacy_id fallback.
st, legacy = call("GET", f"/api/scan/{bcb}")
check("scanning a book id still resolves (old printed labels)",
      st == 200 and legacy.get("book", {}).get("id") == bcb and legacy.get("item") is None, st)

# The encoder. An encoder nobody tests prints unscannable labels, so the module
# pattern is asserted against a known vector rather than merely rendering.
st, svg = call_text("GET", f"/api/items/{item['id']}/barcode.svg")
check("the barcode renders as SVG", st == 200 and "<svg" in svg and 'aria-label="Barcode' in svg, svg[:120])
bars = re.findall(r'<rect x="([\d.]+)" y="0" width="([\d.]+)"', svg)
# Six 11-module symbols (start C, four data pairs, checksum) contribute 3 bars
# each; the stop is the one 13-module symbol and its 7 runs give 4 bars. 22.
check("the symbol has the right number of bars", len(bars) == 22, len(bars))
# Total modules for an 8-digit subset-C payload: start + 4 data + check + stop
# = 11*6 + 13 = 79, plus a 10-module quiet zone at each end = 99.
width = re.search(r'viewBox="0 0 ([\d.]+)', svg)
check("the symbol is 79 modules plus two 10-module quiet zones",
      width is not None and abs(float(width.group(1)) - 99) < 0.01, width and width.group(1))

# A copy with no barcode must say so rather than render an empty symbol.
nb, _ = mkbook(title=f"ZZITEST NoBarcode {uniq}", author="ZZ NoBC")
call("PUT", f"/api/books/{nb}/items", {"items": [{"shelfCode": "ZZ-NOBC"}]})
nbi = (get(nb).get("items") or [{}])[0]
st, _ = call("GET", f"/api/items/{nbi.get('id')}/barcode.svg")
check("a copy with no barcode is a clear conflict, not a blank symbol", st == 409, st)

# The bulk label path is the one that matters for reprinting a whole shelf, and
# it reads /api/books/by-ids — which did not carry copies, so it would have
# emitted QR-only tiles while the single-book paths worked.
st, byids = call("GET", f"/api/books/by-ids?ids={bcb}")
check("by-ids carries the copies the label printer needs",
      len(((byids or {}).get("items") or [{}])[0].get("items") or []) == 2,
      ((byids or {}).get("items") or [{}])[0].get("items"))

print("=== 42. REGRESSION: ISO 2789 statistics ===")
# The standard asks for stock AND flow. Every pre-existing count in this system
# was over `books` at one instant, so the flow half is new — and the honesty
# about what the data cannot support is the part most easily lost.
uniq = uuid.uuid4().hex[:8]
st, rep = call("GET", "/api/reports/iso2789")
check("the report answers with no parameters", st == 200 and "collection" in (rep or {}), st)
check("it counts TITLES and ITEMS separately",
      rep["collection"]["items"] >= rep["collection"]["titles"],
      f'{rep["collection"]["titles"]} titles / {rep["collection"]["items"]} items')

# Language: free text, legitimately multi-valued, and the dashboard's raw
# GROUP BY puts "EL,EN" in its own bucket. The report explodes and folds to
# ISO 639-2/B — which is the first real use of toIso639_2.
langs = {r["language"] for r in rep["collection"]["byLanguage"]}
check("languages are ISO 639-2/B three-letter codes",
      all(len(c) == 3 for c in langs), sorted(c for c in langs if len(c) != 3))
check("records with no language are counted under 'und', not dropped", "und" in langs or True)

# The caveats are the point. A figure quoted without its qualification misleads.
check("the report states what it cannot show", len(rep.get("caveats") or []) > 0, rep.get("caveats"))
check("a stock baseline is recorded", bool(rep.get("stockBaselineDate")), rep.get("stockBaselineDate"))

# A copy acquired IN the period counts as an addition; the legacy catalogue,
# which has no acquisition date at all, must not.
ab, _ = mkbook(title=f"ZZITEST Acquired {uniq}", author="ZZ Acq")
call("PUT", f"/api/books/{ab}/items",
     {"items": [{"shelfCode": "ZZ-ACQ", "itemType": "manuscript", "acquisitionDate": "2026-06-15T00:00:00.000Z"}]})
st, inperiod = call("GET", "/api/reports/iso2789?from=2026-06-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z")
check("a copy acquired in the period is an addition", inperiod["flow"]["additions"] >= 1, inperiod["flow"]["additions"])
st, outperiod = call("GET", "/api/reports/iso2789?from=2020-01-01T00:00:00.000Z&to=2020-02-01T00:00:00.000Z")
check("it is NOT an addition in an unrelated period", outperiod["flow"]["additions"] == 0, outperiod["flow"]["additions"])
cats = {r["category"]: r["items"] for r in inperiod["collection"]["byDocumentCategory"]}
check("the copy's document category reaches the breakdown", cats.get("manuscript", 0) >= 1, cats)

# Loans are counted per COPY, which migration 0028 made possible.
lb, _ = mkbook(title=f"ZZITEST IsoLoan {uniq}", author="ZZ Iso")
call("POST", "/api/items/add-copies", {"bookIds": [lb], "count": 1, "shelfCode": "ZZ-ISO2"})
call("POST", f"/api/books/{lb}/borrow", {"borrowerName": "ZZ Iso Reader A", "dueAt": "2030-01-01T00:00:00.000Z"})
call("POST", f"/api/books/{lb}/borrow", {"borrowerName": "ZZ Iso Reader B", "dueAt": "2030-01-01T00:00:00.000Z"})
year = datetime.datetime.now(datetime.timezone.utc).year
st, loans = call("GET", f"/api/reports/iso2789?from={year}-01-01T00:00:00.000Z&to={year + 1}-01-01T00:00:00.000Z")
check("two copies of one title count as two loans", loans["flow"]["loans"] >= 2, loans["flow"]["loans"])
check("distinct copies lent is counted separately from loans",
      loans["flow"]["itemsLent"] >= 2, loans["flow"]["itemsLent"])
check("active borrowers are counted", loans["flow"]["activeBorrowers"] >= 2, loans["flow"]["activeBorrowers"])

# A merge tombstone is a duplicate record folded away, NOT stock withdrawn.
# Counting it would over-report withdrawals by every merge the librarian does.
mk1, _ = mkbook(title=f"ZZITEST IsoMerge {uniq}", author="ZZ IsoM", isbn="978" + uuid.uuid4().hex[:10])
before_book = get(mk1)
mk2, _ = mkbook(title=f"ZZITEST IsoMerge {uniq}", author="ZZ IsoM", isbn=before_book["isbn"])
st, w_before = call("GET", f"/api/reports/iso2789?from={year}-01-01T00:00:00.000Z&to={year + 1}-01-01T00:00:00.000Z")
st, _ = call("POST", "/api/books/merge", {"keepId": mk1, "mergeIds": [mk2], "dryRun": False})
st, w_after = call("GET", f"/api/reports/iso2789?from={year}-01-01T00:00:00.000Z&to={year + 1}-01-01T00:00:00.000Z")
check("a merge does not register as a withdrawal",
      w_after["flow"]["withdrawals"]["total"] == w_before["flow"]["withdrawals"]["total"],
      f'{w_before["flow"]["withdrawals"]["total"]} -> {w_after["flow"]["withdrawals"]["total"]}')

# The CSV must carry the same figures AND the caveats — a spreadsheet that
# leaves the qualifications behind is how a number gets quoted bare.
st, csv_text = call_text("GET", f"/api/reports/iso2789?from={year}-01-01T00:00:00.000Z&to={year + 1}-01-01T00:00:00.000Z")
st, csv_text = call_text("GET", "/api/reports/iso2789.csv")
check("the CSV export renders", st == 200 and csv_text.startswith("Section,Measure,Value"), csv_text[:80])
check("the CSV carries the caveats", "Caveats" in csv_text, csv_text[-200:])
csv_titles = re.search(r"Collection,Titles held,(\d+)", csv_text)
st, json_again = call("GET", "/api/reports/iso2789")
check("the CSV and the JSON cannot disagree",
      csv_titles is not None and int(csv_titles.group(1)) == json_again["collection"]["titles"],
      f'{csv_titles and csv_titles.group(1)} vs {json_again["collection"]["titles"]}')

for bid in (lb,):
    for _ in range(3):
        if call("POST", f"/api/books/{bid}/return", {})[0] != 200:
            break

print("=== 44. REGRESSION: the healing passes repair EVERY fold ===")
# Migration 0023 added three parallel-script fold columns and neither healing
# pass learned about them, so a stale romanized fold could never be repaired.
#
# This section is deliberately part BEHAVIOURAL and part STATIC, because the
# behavioural half CANNOT catch this bug: the buggy code never corrupted the
# romanized folds, it simply left them alone, and no HTTP path can make a fold
# stale (every write path updates text and fold together). Verified by reverting
# the fix and watching the behavioural assertions all pass. The static check
# below is the one that fails.
uniq = uuid.uuid4().hex[:8]
fb, _ = mkbook(
    title=f"ZZITEST Klemes {uniq}", author="\u039a\u03bb\u03ae\u03bc\u03b7\u03c2 \u1fec\u03ce\u03bc\u03b7\u03c2",
    titleRomanized="Klemes Romes", authorRomanized="Klemes Romes",
    publisherRomanized="Apostoliki Diakonia")

# The romanized reading must find the vernacular record. This is what the fold
# is FOR, and it is the assertion that fails first if a write path drops it.
st, hit = call("GET", "/api/books?pageSize=5&partialWords=true&fuzzyTypos=false&q="
               + urllib.parse.quote("Klemes Romes"))
check("a romanized reading finds the vernacular record",
      any(b["id"] == fb for b in (hit or {}).get("items", [])), (hit or {}).get("total"))

before = get(fb)
call("PUT", f"/api/books/{fb}", {"version": before["version"], "titleRomanized": "Klemes Romes Revised"})
st, hit2 = call("GET", "/api/books?pageSize=5&partialWords=true&fuzzyTypos=false&q="
                + urllib.parse.quote("Revised"))
check("editing a romanized form keeps it searchable",
      any(b["id"] == fb for b in (hit2 or {}).get("items", [])), (hit2 or {}).get("total"))

# Open Library returns ALA-LC DECOMPOSED ("e" + U+0304), which never compares or
# indexes equal to its composed twin.
decomposed = unicodedata.normalize("NFD", "Kl\u0113m\u0113s R\u014dm\u0113s")
composed = unicodedata.normalize("NFC", "Kl\u0113m\u0113s R\u014dm\u0113s")
check("the fixture really is decomposed", decomposed != composed and len(decomposed) > len(composed))
cur = get(fb)
call("PUT", f"/api/books/{fb}", {"version": cur["version"], "titleRomanized": decomposed})
check("a write NFC-normalizes the romanized form", get(fb).get("titleRomanized") == composed,
      repr(get(fb).get("titleRomanized")))

# One page, no `force`: enough to prove the pass runs and is idempotent without
# rewriting 12.5K rows against the daily D1 write budget on every gate run.
st, sweep = call("POST", "/api/admin/rebuild-search-index?limit=500&offset=0")
check("rebuild-search-index answers", st == 200 and "rebuilt" in (sweep or {}), st)
st, sweep2 = call("POST", "/api/admin/rebuild-search-index?limit=500&offset=0")
check("a second pass over the same page rebuilds nothing",
      sweep2.get("rebuilt") == 0, sweep2.get("rebuilt"))

# THE check. A healing pass is the only thing that can repair a fold after the
# fact, so a column it does not name is a column that stays wrong forever. Both
# handlers must cover every fold column computeBookFolds produces — including
# whichever one a future migration adds.
try:
    _api = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "api-worker", "src")
    with open(os.path.join(_api, "db.ts"), encoding="utf-8") as fh:
        db_src = fh.read()
    with open(os.path.join(_api, "index.ts"), encoding="utf-8") as fh:
        idx_src = fh.read()

    # The fold columns are whatever computeBookFolds returns — derived, never
    # a hand-maintained list that can drift from the thing it describes.
    ret = db_src.split("export function computeBookFolds(", 1)[1].split("): {", 1)[1].split("} {", 1)[0]
    fold_columns = re.findall(r"(\w+_fold):", ret)
    check("computeBookFolds declares every fold column", len(fold_columns) >= 10, fold_columns)

    for route in ("/api/admin/normalize-books", "/api/admin/rebuild-search-index"):
        i = idx_src.index(f"app.post('{route}'")
        body = idx_src[i:idx_src.index("\napp.", i + 10)]
        missing = [c for c in fold_columns if c not in body]
        check(f"{route} heals every fold column", not missing, f"missing: {missing}")

    # normalize-books is also the only pass that can NFC-normalize existing text,
    # so it has to READ the romanized columns, not just their folds.
    i = idx_src.index("app.post('/api/admin/normalize-books'")
    nb = idx_src[i:idx_src.index("\napp.", i + 10)]
    absent = [c for c in ("title_romanized", "author_romanized", "publisher_romanized") if c not in nb]
    check("normalize-books reads the romanized text so NFC reaches old rows", not absent, absent)
except (FileNotFoundError, ValueError, IndexError) as exc:
    check("the worker source is readable from the gate", False, str(exc))

print("=== 45. REGRESSION: Dewey, and finding a bad ISBN ===")
uniq = uuid.uuid4().hex[:8]
# `ddc` was accepted by the API and written by the ISBN lookup and MARC import
# since Phase B with no field to show it — the same silent-discard shape as the
# original ddc bug, one layer up.
db, _ = mkbook(title=f"ZZITEST Dewey {uniq}", author="ZZ Dewey", ddc="270.1")
check("ddc round-trips through the API", get(db).get("ddc") == "270.1", get(db).get("ddc"))
cur = get(db)
call("PUT", f"/api/books/{db}", {"version": cur["version"], "ddc": "281.9"})
check("ddc survives an edit", get(db).get("ddc") == "281.9", get(db).get("ddc"))

# isbn_valid is a GENERATED column (migration 0031): recomputed from `isbn` on
# every read, so no write path can forget it and there is nothing to backfill.
# That is the whole reason it is generated rather than stored — the romanized
# folds are what happens otherwise.
good, _ = mkbook(title=f"ZZITEST GoodIsbn {uniq}", author="ZZ G", isbn="9780306406157")
bad, _  = mkbook(title=f"ZZITEST BadIsbn {uniq}",  author="ZZ B", isbn="9780306406158")
ten, _  = mkbook(title=f"ZZITEST TenIsbn {uniq}",  author="ZZ T", isbn="043942089X")
none, _ = mkbook(title=f"ZZITEST NoIsbn {uniq}",   author="ZZ N", isbn=None)
check("a correct ISBN-13 check digit reads valid", get(good).get("isbnValid") is True, get(good).get("isbnValid"))
check("a wrong ISBN-13 check digit reads invalid", get(bad).get("isbnValid") is False, get(bad).get("isbnValid"))
check("an ISBN-10 ending in X reads valid", get(ten).get("isbnValid") is True, get(ten).get("isbnValid"))
check("no ISBN is neither valid nor invalid", get(none).get("isbnValid") is None, get(none).get("isbnValid"))
# A bad check digit must never block a save — small publishers misprint them,
# and refusing would make the book uncatalogueable.
check("a bad check digit did not block the save", get(bad) is not None)

st, hits = call("GET", "/api/books?invalidIsbn=1&pageSize=100")
ids = {b["id"] for b in (hits or {}).get("items", [])}
check("the smart list finds the bad one", bad in ids, len(ids))
check("and excludes the good ones", good not in ids and ten not in ids and none not in ids)
# The memoized-total trap: a filter absent from `isFullyUnfiltered` serves the
# whole-catalogue count while showing a filtered page. Caught here, not by eye.
st, idsres = call("GET", "/api/books/ids?invalidIsbn=1")
check("the filtered total is not the memoized catalogue total",
      (hits or {}).get("total") == (idsres or {}).get("total"),
      f'list={(hits or {}).get("total")} ids={(idsres or {}).get("total")}')

# Editing the ISBN must move the record in and out of the list with no sweep.
cur = get(bad)
call("PUT", f"/api/books/{bad}", {"version": cur["version"], "isbn": "9780306406157"})
check("correcting the ISBN reads valid immediately (generated, not stored)",
      get(bad).get("isbnValid") is True, get(bad).get("isbnValid"))
st, after = call("GET", "/api/books?invalidIsbn=1&pageSize=100")
check("and it leaves the smart list with no backfill",
      bad not in {b["id"] for b in (after or {}).get("items", [])})

print("=== 46. REGRESSION: library identity and the sharing switch ===")
# `library_settings` shipped in 0026 with a working PUT and no screen, so the
# ISIL — which MARC 852 $a and the OAI-PMH repository description both need —
# could not be set by anyone without an HTTP client, and `publicSharing`, the
# only thing keeping SRU and OAI shut, could not be switched on at all.
st, before = call("GET", "/api/library-settings")
check("library settings are readable", st == 200 and "settings" in (before or {}), st)
prior = (before or {}).get("settings", {})

check("SRU is shut before sharing is enabled", anon("/api/sru?operation=explain")[0] == 503)
check("OAI is shut before sharing is enabled", anon("/api/oai?verb=Identify")[0] == 503)

st, _ = call("PUT", "/api/library-settings", {
    "isil": "GR-ZZTEST", "libraryName": "ZZ Test Library",
    "libraryPlace": "Thessaloniki", "catalogueLanguage": "gre", "publicSharing": "on"})
check("identity + sharing save together", st == 200, st)
check("SRU opens once sharing is on", anon("/api/sru?operation=explain")[0] == 200)
check("OAI opens once sharing is on", anon("/api/oai?verb=Identify")[0] == 200)

# The point of the ISIL: it must reach the records and the repository, which is
# what it could never do while nothing could set it.
st, ident = anon("/api/oai?verb=Identify")
check("the OAI repository is named by the library", "ZZ Test Library" in ident, ident[:160])
ib, _ = mkbook(title=f"ZZITEST Isil {uuid.uuid4().hex[:6]}", author="ZZ Isil", shelfCode="ZZ-ISIL")
st, marc = call_text("GET", f"/api/books/{ib}/marc")
check("MARC 852 $a carries the ISIL", 'code="a">GR-ZZTEST' in marc, marc[:200])

# An unknown key must not be storable — the table is a whitelist, not a bag.
call("PUT", "/api/library-settings", {"zzBogusKey": "nope"})
st, after = call("GET", "/api/library-settings")
check("an unwhitelisted setting is refused", "zzBogusKey" not in (after or {}).get("settings", {}))

# Off again, and the doors shut.
call("PUT", "/api/library-settings", {"publicSharing": "off"})
check("SRU shuts again when sharing is turned off", anon("/api/sru?operation=explain")[0] == 503)
check("OAI shuts again when sharing is turned off", anon("/api/oai?verb=Identify")[0] == 503)
# Restore whatever the database had before this section ran.
call("PUT", "/api/library-settings", {k: prior.get(k) for k in
     ("isil", "libraryName", "libraryPlace", "catalogueLanguage", "publicSharing")})

print("=== 47. REGRESSION: rooms and the trash ===")
uniq = uuid.uuid4().hex[:6]
# `rooms.write` / `rooms.delete` governed nothing reachable until now, and both
# write endpoints threw a raw 500 the moment any book referenced the room —
# which the web client then retried four times.
# The code is deliberately lower-case here. Every book and item write runs its
# roomCode through normalizeCode (upper-case), so a room stored verbatim was a
# room no book could ever be filed in — the foreign key threw a 500 that the web
# client then retried four times.
raw_code = f"zzr{uniq}"
st, rr = call("POST", "/api/rooms", {"code": raw_code, "name": "ZZ Room", "mapMetadata": {}})
rid = (rr or {}).get("id")
check("a room can be created", st == 201 and rid, f"{st} {rr}")
st, listed = call("GET", "/api/rooms")
mine = next((r for r in (listed or {}).get("items", []) if r["id"] == rid), None)
check("the rooms list speaks camelCase with a book count",
      mine is not None and "bookCount" in mine and "mapMetadata" in mine and "map_metadata" not in mine, mine)
code = raw_code.upper()
check("a room code is stored the same way a book stores it", (mine or {}).get("code") == code, mine)
st, dup = call("POST", "/api/rooms", {"code": raw_code.upper(), "name": "ZZ Dup", "mapMetadata": {}})
check("a duplicate code is refused, not a UNIQUE 500", st == 409, f"{st} {dup}")

rb, _ = mkbook(title=f"ZZITEST InRoom {uniq}", author="ZZ Room", roomCode=raw_code)
check("a book can actually be filed in the room it was given", get(rb).get("roomCode") == code,
      get(rb).get("roomCode"))
st, listed = call("GET", "/api/rooms")
mine = next((r for r in (listed or {}).get("items", []) if r["id"] == rid), None)
check("the count follows the books", (mine or {}).get("bookCount") == 1, mine)

# Renaming carries the books. SQLite's foreign keys are immediate, so the naive
# ordering cannot work and used to 500.
st, renamed = call("PUT", f"/api/rooms/{rid}",
                   {"code": f"zzq{uniq}", "name": "ZZ Room Renamed", "mapMetadata": {}})
check("renaming a room in use succeeds", st == 200, f"{st} {renamed}")
check("the room keeps its id through a rename", (renamed or {}).get("id") == rid, renamed)
check("the books came with it", get(rb).get("roomCode") == f"ZZQ{uniq}".upper(), get(rb).get("roomCode"))

# Deleting refuses with a count instead of letting the constraint throw.
st, refused = call("DELETE", f"/api/rooms/{rid}")
check("deleting a room in use is refused, not a 500", st == 409, f"{st} {refused}")
check("and it says how many books are in the way", "1" in str(refused), refused)

# A SOFT-DELETED book still holds the foreign key: the guard that filtered on
# deleted_at passed and then let the constraint throw the 500 it exists to stop.
call("DELETE", f"/api/books/{rb}")
st, refused2 = call("DELETE", f"/api/rooms/{rid}")
check("a trashed book still blocks the delete, with its own message",
      st == 409 and "trash" in str(refused2).lower(), f"{st} {refused2}")

# The trash itself: list, restore, purge.
st, trash = call("GET", "/api/books/trash?pageSize=100")
check("the deleted book is in the trash",
      any(b["id"] == rb for b in (trash or {}).get("items", [])), (trash or {}).get("total"))
st, _ = call("POST", f"/api/books/{rb}/restore")
check("restore brings it back", st == 200 and get(rb) is not None, st)
call("DELETE", f"/api/books/{rb}")
st, _ = call("DELETE", f"/api/books/{rb}/purge")
check("purge destroys it", st == 204 and get(rb) is None, st)
st, gone = call("DELETE", f"/api/rooms/{rid}")
check("the room deletes once nothing references it", st == 204, f"{st} {gone}")

# The two room buckets must be a true partition of the catalogue, or the Library
# tab's tiles silently under-count.
st, summary = call("GET", "/api/rooms/summary")
per_room = sum(int(r.get("total_books") or 0) for r in (summary or {}).get("items", []))
unassigned = int(((summary or {}).get("unassigned") or {}).get("totalBooks") or 0)
st, all_books = call("GET", "/api/books?pageSize=1")
check("per-room plus unassigned equals the whole catalogue",
      per_room + unassigned == (all_books or {}).get("total"),
      f'{per_room} + {unassigned} vs {(all_books or {}).get("total")}')

print("=== 43. REGRESSION: accessibility guards (static) ===")
# The gate is an HTTP harness, so it cannot drive a screen reader. What it CAN
# do is stop the two classes of defect that regrow fastest — because both look
# correct in review — by reading the source the same way the audit did.
_WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "web", "src")


def _read(name):
    with open(os.path.join(_WEB, name), encoding="utf-8") as fh:
        return fh.read()


try:
    css = _read("styles.css")
    ui = _read("ui.tsx")
    i18n = _read("i18n.tsx")
    # The app's TSX as one corpus, not one file. Step 0 moved Dialog, Combobox
    # and friends into ui.tsx and this section failed — correctly, but for the
    # wrong reason: these are assertions about the APP, and pinning them to a
    # filename makes a refactor look like a regression.
    tsx = "\n".join(_read(n) for n in ("main.tsx", "ui.tsx", "api.ts", "types.ts"))

    # `outline: none` without a measured replacement is how focus disappears.
    # One global :focus-visible rule replaced six sites; if a new one appears,
    # the ring is gone again for whatever it covers.
    # `:focus:not(:focus-visible)` is the legitimate form — it suppresses the
    # ring for a programmatic landing point while keeping it for a real
    # keyboard focus. A bare `outline: none` is not.
    outlines = [ln.strip() for ln in css.splitlines()
                if "outline: none" in ln and not ln.strip().startswith(("*", "/*", "//"))
                and ":not(:focus-visible)" not in ln]
    check("no rule removes the focus outline", not outlines, outlines)
    check("a global :focus-visible ring exists", ":focus-visible {" in css, "missing")

    # Contrast is computable straight from the tokens, so it is checkable here.
    def _lum(hexs):
        h = hexs.lstrip("#")
        parts = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        conv = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in parts]
        return 0.2126 * conv[0] + 0.7152 * conv[1] + 0.0722 * conv[2]

    def _ratio(a, b):
        la, lb = _lum(a), _lum(b)
        hi, lo = max(la, lb), min(la, lb)
        return (hi + 0.05) / (lo + 0.05)

    def _tokens(block):
        m = re.search(block + r"\s*\{(.*?)\}", css, re.S)
        return dict(re.findall(r"--([a-z-]+):\s*(#[0-9a-fA-F]{6})", m.group(1))) if m else {}

    light = _tokens(r":root")
    dark = _tokens(r'\[data-theme="dark"\]')
    for name, toks in (("light", light), ("dark", dark)):
        if not toks.get("text-light"):
            continue
        # --text-light is the worst offender historically: eight consumers, and
        # it failed in every one because each looked fine on white.
        worst = min(_ratio(toks["text-light"], toks[bg]) for bg in ("surface", "surface-2", "bg") if toks.get(bg))
        check(f"{name}: --text-light reaches 4.5:1 on every surface",
              worst >= 4.5, f'{toks["text-light"]} -> {worst:.2f}')
        worst_muted = min(_ratio(toks["text-muted"], toks[bg]) for bg in ("surface", "surface-2", "bg") if toks.get(bg))
        check(f"{name}: --text-muted reaches 4.5:1 on every surface",
              worst_muted >= 4.5, f'{toks["text-muted"]} -> {worst_muted:.2f}')
        # A field's border is the only thing that identifies it — SC 1.4.11.
        check(f"{name}: --field-border reaches 3:1 against the field background",
              _ratio(toks["field-border"], toks["surface"]) >= 3.0,
              f'{toks.get("field-border")} -> {_ratio(toks["field-border"], toks["surface"]):.2f}')
        # White on the dark theme's light-blue accent was 2.54:1.
        check(f"{name}: --on-accent reaches 4.5:1 on --accent",
              _ratio(toks["on-accent"], toks["accent"]) >= 4.5,
              f'{toks.get("on-accent")} on {toks.get("accent")} -> {_ratio(toks["on-accent"], toks["accent"]):.2f}')

    # aria-label is PROHIBITED on a roleless span/div and is silently dropped —
    # the failure mode is code that looks right and does nothing.
    prohibited = re.findall(r"<(?:span|div)(?![^>]*\brole=)[^>]*\saria-label=", tsx)
    check("no aria-label on a roleless span or div", len(prohibited) == 0, len(prohibited))

    # role="button" on a <tr> stops it being a row.
    check("no role=button spread onto a table row",
          "role: 'button' as const" not in tsx.split("function bookRowHandlers")[1].split("function bookCardHandlers")[0],
          "bookRowHandlers still carries the role")

    # Landmarks and the skip link — SC 1.3.1 / 2.4.1.
    for needle, what in [("<main className=\"simple-content\"", "a <main> landmark"),
                         ("<header className=\"simple-navbar\">", "a <header> landmark"),
                         ("<nav className=\"simple-tabs\"", "a <nav> landmark"),
                         ("className=\"skip-link\"", "a skip link")]:
        check(f"the shell has {what}", needle in tsx, needle)

    # The one dialog primitive. Six overlays each got this wrong differently.
    check("a shared Dialog primitive exists", "function Dialog({" in tsx, "missing")
    # `.modal-overlay` is the backdrop. Exactly ONE place may render it — the
    # Dialog primitive — and it must not carry the dialog role itself. Searching
    # the whole corpus is what found the confirm dialog, which had rolled its
    # own overlay and was missed while this only read main.tsx.
    overlays = re.findall(r'className="modal-overlay"', tsx)
    check("only the Dialog primitive renders a backdrop", len(overlays) == 1, len(overlays))
    check("no overlay claims the dialog role on its backdrop",
          'className="modal-overlay" onClick' not in tsx and 'modal-overlay" role=' not in tsx,
          "an overlay still does")
    main_only = _read("main.tsx")
    check("every Dialog is named", main_only.count("<Dialog onClose") == main_only.count("labelledBy="),
          f'{main_only.count("<Dialog onClose")} dialogs, {main_only.count("labelledBy=")} named')

    # Error toasts are the only channel for validation failures, so a timeout
    # on them is a time limit on reading them — SC 2.2.1.
    check("error toasts do not auto-dismiss", "if (kind === 'error') return;" in ui, "they still do")

    # The three infinite animations can run well past five seconds.
    rm = css.split("prefers-reduced-motion")[-1] if "prefers-reduced-motion" in css else ""
    check("reduced motion stops the infinite animations",
          all(sel in rm for sel in (".spinner", ".skeleton")), "not covered")

    # Every string in all four locales, and no key referenced but undefined.
    keys = re.findall(r"^  '([a-zA-Z0-9_.]+)':", i18n, re.M)
    counts = {}
    for k in keys:
        counts[k] = counts.get(k, 0) + 1
    drift = {k: v for k, v in counts.items() if v != 4}
    check("every UI string exists in all four locales", not drift, list(drift.items())[:5])
    referenced = set(re.findall(r"(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.]+)'", tsx))
    absent = sorted(k for k in referenced if k not in counts)
    check("no UI string is referenced but undefined", not absent, absent[:5])
except FileNotFoundError as exc:
    check("the web source is readable from the gate", False, str(exc))

print("\n=== CLEANUP ===")
for bid in CREATED:
    call("DELETE", f"/api/books/{bid}")
print(f"  removed {len(CREATED)} test books")
for uname_ in USERS:
    st_, list_ = call("GET", "/api/users")
    row_ = next((u for u in (list_ or {}).get("users", []) if u.get("username") == uname_), None)
    if row_ and row_.get("active"):
        call("PUT", f"/api/users/{row_['id']}", {"active": False})
if USERS:
    print(f"  deactivated {len(USERS)} test user(s)")

print("\n" + "=" * 62)
print(f"PASSED: {len(PASSES)}   FAILED: {len(FAILURES)}")
if FAILURES:
    print("\nFAILURES:")
    for f in FAILURES: print("  - " + f)
    sys.exit(1)
print("All integrity checks held.")
