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
import csv, io, json, os, sys, urllib.request, urllib.parse, uuid, zlib, struct

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
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.strip() else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, (json.loads(t) if t.strip() else None)
        except Exception: return e.code, {"raw": t[:300]}


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
for path, ok in [("/api/books/trash", (200,)), ("/api/books/duplicates", (200,))]:
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
    st, r = call("PUT", f"/api/custom-fields/{fid}",
                 {"key": fkey, "label": "ZZ Type Test", "type": "number", "required": False, "enumOptions": []})
    check("type change accepted", st == 200, f"{st} {r}")
    check("a convertible value was converted, not dropped", get(tb)["customFields"].get(fkey) == 1234,
          get(tb)["customFields"])
    check("an unconvertible value was dropped", fkey not in get(tb2)["customFields"], get(tb2)["customFields"])
    # The real point: both books must still SAVE.
    st, _ = call("PUT", f"/api/books/{tb}", {"version": get(tb)["version"], "shelfCode": "ZZ-T1"})
    check("book with the converted value is still editable", st == 200, st)
    st, _ = call("PUT", f"/api/books/{tb2}", {"version": get(tb2)["version"], "shelfCode": "ZZ-T2"})
    check("book whose value was dropped is still editable", st == 200, st)
    # A rename must move the value, and re-running it must be harmless.
    fkey2 = fkey + "r"
    st, _ = call("PUT", f"/api/custom-fields/{fid}",
                 {"key": fkey2, "label": "ZZ Type Test", "type": "number", "required": False, "enumOptions": []})
    check("rename accepted", st == 200, st)
    check("rename moved the value to the new key", get(tb)["customFields"].get(fkey2) == 1234, get(tb)["customFields"])
    call("DELETE", f"/api/custom-fields/{fid}")
else:
    print(f"  (could not create test custom field: {st}; skipped)")

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
