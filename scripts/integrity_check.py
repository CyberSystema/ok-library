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
import atexit, csv, datetime, io, json, os, re, sys, time, unicodedata, urllib.request, urllib.parse, uuid, zlib, struct

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


def call_raw_json(method, path, raw_body, token=None):
    """POST a body VERBATIM, bypassing json.dumps — the only way to send a body that
    is not valid JSON, which is the case an app.onError branch has to handle."""
    req = urllib.request.Request(
        BASE + path, data=raw_body.encode(), method=method,
        headers={"Authorization": f"Bearer {token or TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.strip() else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, {"raw": t[:200]}


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


# Whether we are talking to a local dev D1. A handful of assertions need to set
# up a state the API deliberately refuses to produce (a record with no copies);
# those run only here, and say so out loud when they do not.
LOCAL = BASE.startswith("http://127.0.0.1") or BASE.startswith("http://localhost")


# The repo root, so nothing here depends on the caller's working directory: the
# --config path below is relative, and running the gate from anywhere but the root
# turned EVERY direct D1 probe into a None that read like an empty result.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# Probes that could not run at all, asserted on at the end of the run.
LOCAL_SQL_FAILURES = []


def local_sql(query):
    """Run one statement against the LOCAL D1 and return its rows, or None.

    A None means the statement DID NOT RUN — not that it matched nothing. That
    distinction is the whole point of recording the failure: this used to swallow
    every exception and return None, and three purge/erase cascade assertions read
    that None through `int((rows or [{}])[0].get("n") or 0) == 0` and reported that
    purging a record had cleaned up its authority links, its serial run and its
    audit trail when the query had never executed. A renamed table, a dropped
    column or the wrong working directory all produced that PASS. Read counts
    through sql_count() below, which refuses to turn a dead probe into a zero.
    """
    import subprocess
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ok_library", "--local",
         "--config", "apps/api-worker/wrangler.toml", "--command", query, "--json"],
        capture_output=True, text=True, cwd=REPO_ROOT
    )
    try:
        return json.loads(out.stdout)[0]["results"]
    except Exception as exc:
        LOCAL_SQL_FAILURES.append((" ".join(query.split())[:110],
                                   (out.stderr or out.stdout or str(exc)).strip()[:200]))
        return None


def sql_count(rows, column="n"):
    """The number a COUNT(*) probe returned, or None if the probe did not run.

    None is deliberately not 0, so a caller comparing `== 0` fails on a dead probe
    instead of being told what it hoped to hear.
    """
    if not rows:
        return None
    return int(rows[0].get(column) or 0)


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
# The status and a non-empty results array, exactly as the sibling assertion in §4
# does it. Without them the condition was `all(... for ... in [])` whenever the
# response had no `results` key — so a 400 that rejected the WHOLE batch, or a
# None body, satisfied the assertion named after the request, and the failure
# resurfaced later under the names of its effects ("patched attribute set").
check("bulk patch push succeeded",
      st == 200 and bool((r or {}).get("results"))
      and all(x["status"] == "success" for x in r["results"]), f"{st} {r}")
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
# that doesn't open a list of the same size is worse than no count, so every kind
# of bucket — including "(not filled in)" — has to round-trip. Three buckets per
# field are sampled, named below; the comment used to say EVERY bucket while the
# loop took one. This is also what catches a missing `isFullyUnfiltered` entry:
# without it a filtered view would serve the memoized unfiltered total.
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
    # The (empty) bucket, the first value bucket and the SMALLEST one. Three per
    # field rather than all of them — 600 buckets x 7 fields is not a per-run cost
    # worth paying — but the smallest has to be among them: a bucket of one is
    # where a single miscounted book is the whole answer, and the rail is sorted by
    # count, so sampling from the top only ever looked at the buckets where a
    # discrepancy is proportionally invisible.
    _values = [i for i in items if not i["isEmpty"]]
    _sample = [i for i in items if i["isEmpty"]][:1] + _values[:1]
    if _values:
        _smallest = min(_values, key=lambda i: i["count"])
        if _smallest not in _sample:
            _sample.append(_smallest)
    for bucket in _sample:
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
# A real one-item array, not an empty one: the schema now refuses an empty list
# outright (§50), which would 400 before the version was ever looked at and make
# this assertion pass for the wrong reason.
st, r = call("PUT", f"/api/books/{hb}/items",
             {"expectedVersion": 0,
              "items": [{"id": get(hb)["items"][0]["id"], "itemType": "book"}]})
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

# 7,144 records have `series` equal to their own title, because the import
# auto-filled the field. That used to be handled by dropping such rows PER BOOK,
# and this assertion checked for exactly that — it required the group above to
# report 1 of its 2 members.
#
# Which is what §54 now forbids. A count in the rail has to open a list of the
# same size, and the click-through filters on `custom:series = <label>` with no
# such drop, so a member-level exclusion could only ever advertise a number that
# was wrong. The evidence test is now per CLUSTER, and a group with one differing
# title is a group: both members count, and both members open.
solo = "ZZITEST SOLO " + uuid.uuid4().hex[:6]
mkbook(title=solo, customFields={"series": solo})
mkbook(title=solo + " second", customFields={"series": solo})
st, r = call("GET", "/api/books/sets?minBooks=2&limit=500")
found = next((x for x in (r or {}).get("items", []) if x["title"] == solo), None)
check("a group with one differing title counts every member", (found or {}).get("bookCount") == 2, found)
q = urllib.parse.urlencode({"facetField": "custom:series", "facetValue": solo, "pageSize": 1})
st, listed = call("GET", "/api/books?" + q)
check("and the number it advertises is the number it opens",
      (listed or {}).get("total") == (found or {}).get("bookCount"),
      f'{(listed or {}).get("total")} vs {(found or {}).get("bookCount")}')

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

# ─── The library's own identity record, saved once ───────────────────────────
#
# Everything from here to CLEANUP is allowed to overwrite library_settings,
# because MARC 852 $a, the OAI-PMH repository description and the two protocol
# gates cannot be exercised any other way. What it is NOT allowed to do is leave
# its fixtures behind — and it did. §35 and §36 set the ISIL and then NULLED it
# rather than putting the real one back; §37's finally nulled isil, libraryName
# and publicSharing; §46 took its own "prior" snapshot AFTER that finally had run,
# so it faithfully restored nulls; and §51 planted isil="GR-ZZTEST" and
# libraryName="ZZ Test Library" and restored only publicSharing. Run the way the
# docstring documents — against the deployed Worker — that left the library named
# ZZ Test Library, every exported MARC 852 $a and 003 carrying GR-ZZTEST, the
# OAI-PMH repositoryIdentifier wrong and sharing switched off under any harvester
# subscribed to it. Nothing reported it, because the gate asserted on the values
# it had planted.
#
# So: ONE snapshot, taken before the first write, put back in ONE place. The
# atexit registration matters as much as the snapshot — an AssertionError in any
# mkbook() skips CLEANUP, and it was precisely the crash path that made the
# damage permanent.
st, _ls = call("GET", "/api/library-settings")
LIBRARY_SETTINGS_BEFORE = dict((_ls or {}).get("settings") or {})
check("the library's identity record was read before the gate starts writing it",
      st == 200 and bool(LIBRARY_SETTINGS_BEFORE), f"{st} {_ls}")


def restore_library_settings():
    """Write the ORIGINAL values back — never None, never a test value."""
    if not LIBRARY_SETTINGS_BEFORE or restore_library_settings.done:
        return None
    restore_library_settings.done = True
    call("PUT", "/api/library-settings", LIBRARY_SETTINGS_BEFORE)
    return dict((call("GET", "/api/library-settings")[1] or {}).get("settings") or {})


restore_library_settings.done = False
atexit.register(restore_library_settings)

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
# No `{"isil": None}` here any more. It read as cleanup and was a second edit to
# the library's own record; the section below sets the ISIL it needs, and the real
# one goes back in CLEANUP.

print("=== 36. REGRESSION: MARC round-trip loses nothing ===")
# Export and ingest share one field table so they cannot drift — a tag written
# as 260$b but read as 264$b would silently drop the publisher every time.
call("PUT", "/api/library-settings", {"isil": "GR-ZZTEST"})
uniq = uuid.uuid4().hex[:6]
mb, _ = mkbook(
    title=f"ZZITEST Κλήμης Ῥώμης {uniq}", author="Κλήμης Ῥώμης",
    titleRomanized="Klemes Romes", publisher="Αποστολική Διακονία",
    isbn="978" + uuid.uuid4().hex[:10], publicationYear=None, dateEdtf="1955/1957",
    # "EL" is what the catalogue actually stores — 8,765 records of it. This
    # fixture used to say "gre", written when the export was believed to hold
    # ISO 639-2/B already; it does not, which is the defect §48 fixes. A record
    # that DID arrive with "gre" now comes back as "EL", which is the
    # catalogue's own form, and that normalisation is asserted in §48.
    language="EL", ddc="270",
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
# The ISIL this section planted stays until CLEANUP puts the real one back;
# nulling it here was never a restore.

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
    # Shut the door this section opened, whatever happened above — the catalogue
    # must not be left publicly harvestable by a failed assertion. It shuts rather
    # than restores on purpose: §46 below proves the doors are closed before it
    # opens them, and failing closed is the safe direction for a switch. The
    # ORIGINAL sharing value — which may legitimately be "on" — goes back with the
    # rest of the identity record in CLEANUP. This used to null isil and
    # libraryName here too, which is what §46's snapshot then read as "prior".
    call("PUT", "/api/library-settings", {"publicSharing": "off"})

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
# MILLISECONDS, not microseconds. Python's isoformat() emits six fractional
# digits; ISODateTimeSchema now normalises whatever it is handed to
# `new Date(v).toISOString()`, which is millisecond precision — so a microsecond
# input is stored in the app's canonical shape rather than verbatim, and the
# echo-back comparison below has to send what a real client sends. (Before that
# normalisation the value was stored exactly as received, which is the defect:
# "March 3 2027" was stored as "March 3 2027" in a column compared as TEXT.)
soon = ((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=2))
        .isoformat(timespec="milliseconds").replace("+00:00", "Z"))
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
# This assertion used to end in `or True`, which made it unfalsifiable — it read as
# a guarantee and tested nothing. The substance does hold, so the fix is to assert
# it properly AND to check the count, not merely the bucket's presence: a report
# that dropped half the blank-language records would still have shown an 'und'
# bucket and satisfied the old form even without the `or True`.
_und = next((r["titles"] for r in rep["collection"]["byLanguage"] if r["language"] == "und"), None)
if LOCAL:
    _rows = local_sql("SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL "
                      "AND (language IS NULL OR TRIM(language) = '')")
    _blank_lang = int(_rows[0]["n"]) if _rows else None
    check("records with no language are counted under 'und', not dropped",
          _und is not None and _blank_lang is not None and _und >= _blank_lang,
          f"und={_und}, records with no language={_blank_lang}")
else:
    check("records with no language are counted under 'und', not dropped",
          _und is not None, f"no 'und' bucket in {sorted(langs)}")

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
    # `isbn_valid` is not a fold and rides in the same return for the same reason
    # (migration 0034), so the pattern has to admit it — a derived column this
    # guard cannot see is a derived column a healing pass may quietly forget.
    fold_columns = re.findall(r"(\w+_fold|isbn_valid):", ret)
    check("computeBookFolds declares every derived column", len(fold_columns) >= 11, fold_columns)

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
# This section used to take its own `prior` snapshot HERE and restore it at the
# end. Here is after §37 has run, and §37's finally had just nulled isil,
# libraryName and publicSharing — so the "restore" wrote nulls over the library's
# real identity and reported nothing. The one snapshot that matters was taken
# before §35, and LIBRARY_SETTINGS_BEFORE goes back in CLEANUP.

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

# The two room buckets must be a true partition of the catalogue, or the Library
# tab's tiles silently under- or double-count.
#
# This ran at the END of the section — five lines after the fixture room had been
# deleted, and this catalogue has no other room holding a book — so `per_room` was
# a sum over an empty list and the assertion degenerated to `unassigned == total`:
# the residual bucket compared against itself, with the LEFT JOIN half it exists
# to check never exercised. It runs here instead, while the room holds its one
# book, and asserts both halves: the per-room count, and the partition.
st, summary = call("GET", "/api/rooms/summary")
per_room = sum(int(r.get("total_books") or 0) for r in (summary or {}).get("items", []))
unassigned = int(((summary or {}).get("unassigned") or {}).get("totalBooks") or 0)
st, all_books = call("GET", "/api/books?pageSize=1")
_fixture = next((r for r in (summary or {}).get("items", []) if r.get("id") == rid), None)
# `>= 1`, not `== 1`: the summary sums every room, and a real catalogue running
# this gate has rooms of its own with books in them.
check("the room's own book reaches the per-room half of the summary",
      _fixture is not None and int(_fixture.get("total_books") or 0) == 1 and per_room >= 1,
      f"fixture={_fixture}, per_room={per_room}")
check("per-room plus unassigned equals the whole catalogue",
      per_room + unassigned == (all_books or {}).get("total"),
      f'{per_room} + {unassigned} vs {(all_books or {}).get("total")}')

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

print("=== 48. REGRESSION: MARC 21 exchange speaks the standard's language ===")
uniq = uuid.uuid4().hex[:8]
mb, _ = mkbook(title=f"ZZITEST Marc {uniq}", author="ZZ Marc", language="EL,EN",
               isbn="978" + uniq[:6] + "999", publicationYear=1987)
st, mj = call("GET", f"/api/books/{mb}/marc?format=json")
fields = {list(f.keys())[0]: list(f.values())[0] for f in (mj or {}).get("fields", [])}
f041 = fields.get("041") or {}
codes = [list(x.values())[0] for x in (f041.get("subfields") or [])]
# 041 is documented as ISO 639-2/B and emitted the raw stored value ("EL"),
# so every record this catalogue exported carried a language code no MARC
# system recognises.
check("041 carries ISO 639-2/B, not the stored two-letter code", codes == ["gre", "eng"], codes)
check("041 ind1 marks a record with more than one language", f041.get("ind1") == "1", f041.get("ind1"))

# 008/35-37 is where a MARC reader ACTUALLY looks for the language. The export
# had no 008 at all, so an importing system got no language in the slot it reads.
f008 = fields.get("008")
check("008 is present", isinstance(f008, str), f008)
check("008 is exactly 40 characters", len(f008 or "") == 40, len(f008 or ""))
check("008/35-37 is the language", (f008 or "")[35:38] == "gre", (f008 or "")[35:38])
check("008/06-14 carries the single publication date", (f008 or "")[6:15] == "s1987    ", repr((f008 or "")[6:15]))

st, dc = call_text("GET", f"/api/books/{mb}/marc?format=dc")
check("Dublin Core language is ISO 639, one element each",
      "<dc:language>gre</dc:language>" in dc and "<dc:language>eng</dc:language>" in dc,
      [l for l in dc.splitlines() if "language" in l])

# The round trip is the real test: what this catalogue exports, it must be able
# to read back as what it started as.
st, xml = call_text("GET", f"/api/books/{mb}/marc?format=marcxml")
st, rep = call("POST", "/api/import/marcxml", raw=xml.encode(), ctype="application/xml")
check("re-importing an exported record updates rather than duplicates",
      st == 200 and (rep or {}).get("updated") == 1 and (rep or {}).get("created") == 0, f"{st} {rep}")
check("and the language survives the round trip unchanged", get(mb).get("language") == "EL,EN",
      get(mb).get("language"))

# The dry run exists to predict what the real run will do. It returned before
# the match lookup, so it counted EVERY record as new — testing a re-send from a
# partner library said "1,200 new" where the real import would update 1,200.
untouched = get(mb).get("version")
st, dry = call("POST", "/api/import/marcxml?dryRun=1", raw=xml.encode(), ctype="application/xml")
check("a dry run of a file that would update reports it as an update",
      st == 200 and (dry or {}).get("updated") == 1 and (dry or {}).get("created") == 0, f"{st} {dry}")
check("and a dry run still writes nothing", get(mb).get("version") == untouched,
      f'{get(mb).get("version")} vs {untouched}')

# A record from another library is usually monolingual and carries no 041 at
# all — the language is only in 008.
solo = f"ZZITEST Marc Solo {uniq}"
minimal = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<collection xmlns="http://www.loc.gov/MARC21/slim"><record>'
    '<leader>00000nam a2200000 i 4500</leader>'
    '<controlfield tag="008">260101s1990    xx |||||||||||||||||fre d</controlfield>'
    f'<datafield tag="245" ind1="1" ind2="0"><subfield code="a">{solo}</subfield></datafield>'
    '<datafield tag="100" ind1="1" ind2=" "><subfield code="a">ZZ Marc</subfield></datafield>'
    '</record></collection>'
)
st, rep = call("POST", "/api/import/marcxml", raw=minimal.encode(), ctype="application/xml")
check("a record with no 041 imports", st == 200 and (rep or {}).get("created") == 1, f"{st} {rep}")
st, found = call("GET", f"/api/books?search={urllib.parse.quote(solo)}&pageSize=5")
hit = next((b for b in (found or {}).get("items", []) if b["title"] == solo), None)
if hit: CREATED.append(hit["id"])
check("the language is read from 008 when 041 is absent", (hit or {}).get("language") == "FR", hit)

# und / mul / zxx mean "not determined". Storing one would put a fake language
# on the record and a fake bucket in the facet rail.
undet = f"ZZITEST Marc Und {uniq}"
st, rep = call("POST", "/api/import/marcxml",
               raw=minimal.replace("fre d", "und d").replace(solo, undet).encode(),
               ctype="application/xml")
st, found = call("GET", f"/api/books?search={urllib.parse.quote(undet)}&pageSize=5")
hit2 = next((b for b in (found or {}).get("items", []) if b["title"] == undet), None)
if hit2: CREATED.append(hit2["id"])
check("an undetermined language is left empty, not stored as 'und'",
      not (hit2 or {}).get("language"), hit2)

# The bulk export asked for pages of 200 from a query builder that clamps at
# 100, so "a short page means we are done" fired on the FIRST page: the file was
# a properly-closed <collection> holding 100 records out of 12,608. A truncated
# export that looks complete is the worst failure an exchange format can have.
def count_records(path):
    """Stream the export, counting records and DISTINCT record ids.

    Streamed rather than buffered because the export is ~20 MB. The distinct
    count matters on its own: OFFSET paging over a sort key thousands of rows
    share does not just risk truncation, it can emit one record twice and drop
    another, and both files are the right length.
    """
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {TOKEN}"})
    n, tail, total, ids = 0, b"", 0, set()
    with urllib.request.urlopen(req, timeout=300) as r:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            # The carried tail is rescanned on this pass, so anything already
            # counted in it has to come back off — otherwise a <record> sitting
            # in the overlap is counted twice and the export looks like it
            # duplicated records it did not. (It did not. This helper did.)
            buf = tail + chunk
            n += buf.count(b"<record>") - tail.count(b"<record>")
            # Ids go into a set, so rescanning the overlap is harmless, and the
            # tail has to be long enough to hold a whole 001 field split across
            # a chunk boundary.
            for m in re.finditer(rb'<controlfield tag="001">([^<]+)</controlfield>', buf):
                ids.add(m.group(1))
            tail = buf[-200:]
    return n, len(ids), tail, total

# The list endpoint's total is served from a version-keyed cache, so comparing it
# to a live stream is a race: this suite creates records as it runs, and the
# export legitimately saw one more than a cached total did. Read the total either
# side of the export and require the export to land inside that window — and,
# separately, require every record in it to be distinct, which is the property
# OFFSET paging over a non-unique sort key would actually break.
before_total = (call("GET", "/api/books?pageSize=1")[1] or {}).get("total")
exported, distinct, tail, size = count_records("/api/export/books.marcxml")
after_total = (call("GET", "/api/books?pageSize=1")[1] or {}).get("total")
lo, hi = min(before_total, after_total), max(before_total, after_total)
check("the bulk MARCXML export contains every record, not the first page",
      lo <= exported <= hi, f"{exported} not in [{lo}, {hi}]")
check("and emits each record exactly once", exported == distinct, f"{exported} emitted, {distinct} distinct")
check("and the collection is closed", tail.strip().endswith(b"</collection>"), tail)

# A serial is an open-ended run: 008/06 = c, and date 2 is 9999 rather than blank.
sb, _ = mkbook(title=f"ZZITEST Marc Serial {uniq}", author="ZZ Marc", language="EL",
               publicationYear=1975)
call("PUT", f"/api/books/{sb}", {**get(sb), "bibLevel": "serial"})
st, sj = call("GET", f"/api/books/{sb}/marc?format=json")
sfields = {list(f.keys())[0]: list(f.values())[0] for f in (sj or {}).get("fields", [])}
s008 = sfields.get("008") or ""
if get(sb).get("bibLevel") == "serial":
    check("a serial's 008 is an open run", s008[6:15] == "c19759999", repr(s008[6:15]))
else:
    # bibLevel has no write path yet (Phase 2, step 7) — the monograph shape is
    # what the exporter can be held to today.
    check("a monograph's 008 leaves date 2 blank", s008[6:15] == "s1975    ", repr(s008[6:15]))

print("=== 49. REGRESSION: a record can say it is a serial ===")
uniq = uuid.uuid4().hex[:8]
# migration 0024 added books.bib_level and NOTHING could ever write it: every
# one of the books-writing statements omitted it and no schema accepted it, so
# all 12,675 records sat at the default while thirteen carried an ISSN — and the
# ISO 2789 return the librarian signs reported zero serial titles held.
sb, _ = mkbook(title=f"ZZITEST Serial {uniq}", author="ZZ Serial", language="EL", publicationYear=1975)
check("a new record defaults to monograph", get(sb).get("bibLevel") == "monograph", get(sb))
check("and says so in camelCase, like every other field",
      "bib_level" not in get(sb) and "set_id" not in get(sb) and "isbn_valid" not in get(sb),
      [k for k in get(sb) if "_" in k])
check("the copies do too", all("_" not in k for k in get(sb)["items"][0]), get(sb)["items"][0])

before = get(sb)
st, _ = call("PUT", f"/api/books/{sb}", {"bibLevel": "serial", "version": before["version"]})
after = get(sb)
check("it can be marked a serial", st == 200 and after.get("bibLevel") == "serial", f"{st} {after.get('bibLevel')}")
# The `.partial()` default-substitution trap: a one-field update must not wipe
# the rest of the record.
check("a one-field update leaves the rest alone",
      after["title"] == before["title"] and after["author"] == before["author"]
      and after["customFields"] == before["customFields"] and after.get("isbn") == before.get("isbn"),
      after)

# And the reverse of the trap: an update that says nothing about the level must
# not quietly return the record to monograph.
st, _ = call("PUT", f"/api/books/{sb}", {"shelfCode": "ZZ-9", "version": get(sb)["version"]})
check("an unrelated partial update does not demote a serial",
      get(sb).get("bibLevel") == "serial" and get(sb).get("shelfCode") == "ZZ-9", get(sb).get("bibLevel"))

st, mj = call("GET", f"/api/books/{sb}/marc?format=json")
fields = {list(f.keys())[0]: list(f.values())[0] for f in (mj or {}).get("fields", [])}
leader = (mj or {}).get("leader", "")
# Every serial-aware branch of the exporter was dead code: parseBook never
# camelCased bib_level, so marc.ts read `row.bibLevel` and got undefined.
check("MARC leader/07 says serial", leader[7:8] == "s", repr(leader))
s008 = fields.get("008") or ""
check("008/06 codes a continuing resource", s008[6:7] == "c", repr(s008[6:15]))
# `publicationYearEnd` falls back to the start year on read, which is right for
# a book and a false claim for a periodical — it coded the title as having
# ceased in the year it began.
check("and an open run is 9999, not an invented cessation", s008[11:15] == "9999", repr(s008[6:15]))

# The round trip: leader/07 must survive out and back.
st, xml = call_text("GET", f"/api/books/{sb}/marc?format=marcxml")
st, rep = call("POST", "/api/import/marcxml", raw=xml.encode(), ctype="application/xml")
check("re-importing a serial keeps it a serial", get(sb).get("bibLevel") == "serial", get(sb).get("bibLevel"))
# An ordinary record must never DEMOTE a title the librarian marked as a serial.
plain = xml.replace("00000nas", "00000nam")
st, rep = call("POST", "/api/import/marcxml", raw=plain.encode(), ctype="application/xml")
check("and a monograph-level record does not demote it",
      get(sb).get("bibLevel") == "serial", get(sb).get("bibLevel"))

# The report must name its own blind spot rather than publishing a structural
# zero as a measurement.
st, rep = call("GET", "/api/reports/iso2789")
check("the serial count sees it", (rep or {}).get("collection", {}).get("serialTitles", 0) >= 1,
      (rep or {}).get("collection", {}).get("serialTitles"))
issn_book, _ = mkbook(title=f"ZZITEST Issn {uniq}", author="ZZ Serial", customFields={"issn": "2093-6494"})
st, rep = call("GET", "/api/reports/iso2789")
check("and an ISSN catalogued as a monograph earns a caveat",
      any("ISSN" in c for c in (rep or {}).get("caveats", [])), (rep or {}).get("caveats"))

print("=== 50. REGRESSION: a record always keeps a copy ===")
uniq = uuid.uuid4().hex[:8]
cb, _ = mkbook(title=f"ZZITEST Copies {uniq}", author="ZZ Copies", shelfCode="ZZ-COP")
base = get(cb)
EDITABLE = ("id", "volumeNum", "volumeLabel", "roomCode", "shelfCode", "callNumber",
            "itemType", "condition", "acquisitionDate", "notes", "barcode")
def draft(it):
    return {k: v for k, v in it.items() if k in EDITABLE}

# An empty array was accepted, soft-deleted every copy, and syncBookFromItems then
# nulled the record's own shelf: the record fell out of every location facet and
# out of the ISO 2789 stock count, with nothing to bring it back.
st, r = call("PUT", f"/api/books/{cb}/items", {"items": []})
check("a record cannot be stripped of every copy", st == 400, f"{st} {r}")
check("and its copy is still there", len(get(cb)["items"]) == 1, get(cb)["items"])
check("and it still knows its own shelf", get(cb).get("shelfCode") == "ZZ-COP", get(cb).get("shelfCode"))

# The nine columns the endpoint has always written and no control ever set.
st, r = call("PUT", f"/api/books/{cb}/items", {"items": [
    {**draft(base["items"][0]), "callNumber": "270 ZZ", "volumeNum": "Α'", "volumeLabel": "τ. 1",
     "condition": "good", "notes": "front shelf", "barcode": "9000" + uniq[:4]},
    {"itemType": "serial", "shelfCode": "ZZ-BACK", "callNumber": "270 ZZ b", "notes": "back shelf"}
]})
two = get(cb)["items"]
check("every writable column round-trips", st == 200 and len(two) == 2
      and two[0]["callNumber"] == "270 ZZ" and two[0]["volumeNum"] == "Α'"
      and two[0]["volumeLabel"] == "τ. 1" and two[0]["condition"] == "good"
      and two[0]["notes"] == "front shelf" and two[1]["itemType"] == "serial", two)
check("copy numbers follow list order", [i["copyNumber"] for i in two] == [1, 2],
      [i["copyNumber"] for i in two])
# MARC 852$h is the reason call_number matters outside this screen.
st, marc = call_text("GET", f"/api/books/{cb}/marc")
check("the call number reaches MARC 852$h", '<subfield code="h">270 ZZ</subfield>' in marc,
      [l for l in marc.splitlines() if "852" in l or 'code="h"' in l])

# items.barcode is UNIQUE catalogue-wide and neither branch pre-checked it, so a
# clash came out of the D1 batch as a raw 500 — which the client retries 4x.
ob, _ = mkbook(title=f"ZZITEST Copies Other {uniq}", author="ZZ Copies")
st, _ = call("PUT", f"/api/books/{ob}/items",
             {"items": [{**draft(get(ob)["items"][0]), "barcode": "9111" + uniq[:4]}]})
st, r = call("PUT", f"/api/books/{cb}/items",
             {"items": [{**draft(two[0]), "barcode": "9111" + uniq[:4]}, draft(two[1])]})
check("a barcode already on another record is refused, not a 500", st == 409, f"{st} {r}")
st, r = call("PUT", f"/api/books/{cb}/items", {"items": [
    {**draft(two[0]), "barcode": "9222" + uniq[:4]},
    {**draft(two[1]), "barcode": "9222" + uniq[:4]}]})
check("the same barcode twice in one list is refused too", st == 409, f"{st} {r}")

# Removing a copy is a WITHDRAWAL. ISO 2789 B.2.4 counts them and the column has
# existed since 0030 with no writer, so it could only ever report 'unrecorded'.
st, r = call("PUT", f"/api/books/{cb}/items",
             {"items": [draft(two[0])], "withdrawalReason": "damaged beyond repair"})
check("a copy can be withdrawn", st == 200 and len(get(cb)["items"]) == 1, f"{st} {get(cb)['items']}")
# The reason is visible where it matters: ISO 2789 B.2.4 groups withdrawals by
# reason, and with nothing able to write one it could only ever report
# "unrecorded" — 4,550 of them on this catalogue.
st, rep = call("GET", "/api/reports/iso2789")
reasons = {r["reason"]: r["items"] for r in (rep or {}).get("flow", {}).get("withdrawals", {}).get("byReason", [])}
check("the reason reaches the ISO 2789 withdrawal breakdown",
      reasons.get("damaged beyond repair", 0) >= 1, list(reasons.items())[:6])

# A copy on the hold shelf is pinned exactly as a borrowed one is: ITEM_IS_FREE,
# which every other path uses, says so. This guard looked only at 'borrowed'.
st, r = call("PUT", f"/api/books/{cb}/items", {"items": [draft(get(cb)["items"][0]), {"itemType": "book"}]})
copies = get(cb)["items"]
st, bor = call("POST", f"/api/books/{cb}/borrow",
               {"borrowerName": f"ZZ Holder {uniq}", "itemId": copies[1]["id"]})
if st in (200, 201):
    st, r = call("PUT", f"/api/books/{cb}/items", {"items": [draft(copies[0])]})
    check("a copy on loan cannot be removed", st == 409, f"{st} {r}")
    call("POST", f"/api/books/{cb}/return", {"itemId": copies[1]["id"]})
else:
    check("a copy on loan cannot be removed", False, f"could not lend: {st} {bor}")

# The follow-on failure: once a record HAD zero copies, ensurePrimaryItem tried to
# insert the deterministic id `itm_<bookId>` that was already sitting soft-deleted,
# so every later edit of that record was a primary-key collision behind a 500 the
# client retried four times. The damaged state can no longer be produced through
# the API — that is the point — so it is set up in the database directly, which
# only works against a local dev D1.
if LOCAL:
    zb, _ = mkbook(title=f"ZZITEST Zero {uniq}", author="ZZ Copies")
    det = get(zb)["items"][0]["id"]
    local_sql(f"UPDATE items SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = '{det}'")
    check("the damaged state is reachable in data", len(get(zb)["items"]) == 0, get(zb)["items"])
    st, r = call("PUT", f"/api/books/{zb}", {"title": f"ZZITEST Zero {uniq} ed", "version": get(zb)["version"]})
    check("a record with no copies can still be edited", st == 200, f"{st} {r}")
    fresh = get(zb)["items"]
    check("and gets a copy back", len(fresh) == 1, fresh)
    check("without resurrecting the withdrawn one", fresh and fresh[0]["id"] != det, fresh)
    still = local_sql(f"SELECT deleted_at AS d FROM items WHERE id = '{det}'")
    check("the withdrawn copy stays withdrawn", still and still[0].get("d") is not None, still)
else:
    print("  SKIP  4 zero-copy repair checks need direct D1 access (local runs only)")

print("=== 51. REGRESSION: a periodical can say what it holds ===")
uniq = uuid.uuid4().hex[:8]
# Migration 0026 built serial_holdings so that ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ — 47 separate
# book rows in this catalogue — could be ONE title with a run. Nothing in the
# system could read or write the table: the single statement naming it was a
# merge re-parent that could never match a row.
pb, _ = mkbook(title=f"ZZITEST Περιοδικό {uniq}", author="", language="EL", publicationYear=1880)
call("PUT", f"/api/books/{pb}", {"bibLevel": "serial", "version": get(pb)["version"]})

st, r = call("GET", f"/api/books/{pb}/serial-holdings")
check("a serial with no run reads as an empty list, not a 404",
      st == 200 and r.get("holdings") == [] and r.get("bibLevel") == "serial", f"{st} {r}")

st, r = call("PUT", f"/api/books/{pb}/serial-holdings", {
    "expectedVersion": get(pb)["version"],
    "holdings": [
        {"caption": "τόμος", "fromVolume": "1", "toVolume": "10",
         "fromYear": 1880, "toYear": 1889, "gaps": "τ. 7", "note": "δεμένα ανά δύο"},
        {"caption": "τόμος", "fromVolume": "12", "fromYear": 1891}
    ]})
held = (r or {}).get("holdings", [])
check("a run can be recorded", st == 200 and len(held) == 2, f"{st} {r}")
check("in the order it was arranged", [h["seq"] for h in held] == [0, 1], [h.get("seq") for h in held])
check("with the gap statement kept as the librarian wrote it",
      held[0]["gaps"] == "τ. 7" and held[0]["note"] == "δεμένα ανά δύο", held[0])
check("and no snake_case leaks", all("_" not in k for h in held for k in h),
      [k for h in held for k in h if "_" in k])

# A stale version must lose, exactly as it does for the copies list.
st, r = call("PUT", f"/api/books/{pb}/serial-holdings", {"expectedVersion": 0, "holdings": []})
check("a stale expectedVersion is rejected", st == 409, f"{st} {r}")

# MARC 866 is the whole point: a run that cannot leave the building is a note to
# self. 853/863 would need a caption PATTERN this catalogue does not hold, so the
# textual field is the honest one.
st, xml = call_text("GET", f"/api/books/{pb}/marc")
fields866 = re.findall(r'<datafield tag="866".*?</datafield>', xml, re.S)
check("the run is exported as MARC 866", len(fields866) == 2, len(fields866))
check("866$a is the statement, compressed and at holdings level",
      '<subfield code="a">τόμος 1-10 (1880-1889)</subfield>' in xml
      and 'tag="866" ind1="3" ind2="0"' in xml, fields866[:1])
# Gaps in $z, not folded into $a: a system reading the statement should not have
# to guess which part of it is a caveat.
check("gaps and notes are a $z public note, not part of $a",
      '<subfield code="z">τ. 7; δεμένα ανά δύο</subfield>' in xml
      and 'τ. 7' not in xml.split('code="z"')[0].split('code="a"')[-1], fields866[:1])
check("a single volume needs no range", '<subfield code="a">τόμος 12 (1891)</subfield>' in xml, fields866[1:])

# All three MARC render paths had to learn about holdings, not just the one.
# SRU and OAI-PMH render through `marcInputsForRows`, a DIFFERENT assembly path
# from the single-record route and from the bulk export — three places that each
# had to be taught about holdings. SRU is closed unless sharing is on, so it is
# opened for this check and closed again.
call("PUT", "/api/library-settings",
     {"publicSharing": "on", "isil": "GR-ZZTEST", "libraryName": "ZZ Test Library"})
try:
    st, sru = call_text("GET", "/api/sru?version=1.2&operation=searchRetrieve&recordSchema=marcxml"
                        "&query=dc.title%3D" + urllib.parse.quote(f"ZZITEST Περιοδικό {uniq}"))
    check("SRU carries the run too", 'tag="866"' in sru, sru[:220])
finally:
    call("PUT", "/api/library-settings", {"publicSharing": "off"})
# ONE fetch of the bulk export, not two. There used to be a
# `count_records("/api/export/books.marcxml")` on the line above whose four return
# values were never read again — §48 has already counted its own copy — so every
# run rendered all ~12,500 records to MARCXML three times and used one of them.
# Against the deployed Worker that is ~25,000 wasted D1 row reads and ~42 MB of
# egress on a free tier where the budgets are the documented constraint.
st, bulk = call_text("GET", "/api/export/books.marcxml")
check("and so does the bulk export", bulk.count('tag="866"') >= 2, bulk.count('tag="866"'))

# Removing a statement is a CORRECTION, not a withdrawal — there is no physical
# object leaving — so it is a hard delete, and an empty run is legitimate.
st, r = call("PUT", f"/api/books/{pb}/serial-holdings",
             {"expectedVersion": get(pb)["version"], "holdings": [
                 {k: v for k, v in held[0].items() if k in
                  ("id", "caption", "fromVolume", "toVolume", "fromYear", "toYear", "gaps", "note")}]})
check("a statement can be removed", st == 200 and len(r["holdings"]) == 1, f"{st} {r}")
st, r = call("PUT", f"/api/books/{pb}/serial-holdings",
             {"expectedVersion": get(pb)["version"], "holdings": []})
check("and an empty run is allowed, unlike an empty copies list",
      st == 200 and r["holdings"] == [], f"{st} {r}")

# The run belongs to the record, so purging the record must take it with it.
if LOCAL:
    call("PUT", f"/api/books/{pb}/serial-holdings",
         {"expectedVersion": get(pb)["version"], "holdings": [{"caption": "τόμος", "fromVolume": "1"}]})
    rows = local_sql(f"SELECT COUNT(*) AS n FROM serial_holdings WHERE book_id = '{pb}'")
    check("the run is stored against the record", sql_count(rows) == 1, rows)
    call("DELETE", f"/api/books/{pb}")
    call("DELETE", f"/api/books/{pb}/purge")
    rows = local_sql(f"SELECT COUNT(*) AS n FROM serial_holdings WHERE book_id = '{pb}'")
    # sql_count, not `int((rows or [{}])[0].get("n") or 0)`: that form read a probe
    # that never ran as "no rows left" and passed. Renaming serial_holdings in a
    # migration would have reported this cascade as working.
    check("and purging the record takes the run with it", sql_count(rows) == 0, rows)
else:
    print("  SKIP  2 cascade checks need direct D1 access (local runs only)")

print("=== 52. REGRESSION: a heading can be corrected without losing its links ===")
uniq = uuid.uuid4().hex[:8]
# Migration 0025 built three tables and six endpoints, and there was no UPDATE of
# any kind: the only UPDATE on `authorities` was the soft-delete, and DELETE
# hard-deletes every link. So fixing one typo in a preferred form meant destroying
# the heading and every book pointing at it. For a controlled vocabulary — whose
# whole value is that the record is long-lived and pointed at — that made the
# feature unusable past the first mistake.
st, a = call("POST", "/api/authorities", {
    "kind": "person", "preferredForm": f"ΖΖ Επιφάνιοσ {uniq}", "dates": "315-403",
    "source": "local", "variants": [f"Epiphanius ZZ {uniq}"]})
aid = (a or {}).get("id")
check("a heading can be created", st == 201 and aid, f"{st} {a}")

# There was no GET for one heading either — the list endpoint is a PREFIX match
# and returns no variants, so a known heading could not be fetched at all.
st, one = call("GET", f"/api/authorities/{aid}")
check("one heading can be read back", st == 200 and one.get("preferredForm") == f"ΖΖ Επιφάνιοσ {uniq}", f"{st} {one}")
check("with its variants", one.get("variants") == [f"Epiphanius ZZ {uniq}"], one.get("variants"))
check("and what points at it", one.get("usedBy") == [], one.get("usedBy"))

ab, _ = mkbook(title=f"ZZITEST Authority {uniq}", author="ΖΖ Επιφάνιοσ")
st, _ = call("PUT", f"/api/books/{ab}/authorities", {"links": [{"authorityId": aid, "role": "aut"}]})
st, links = call("GET", f"/api/books/{ab}/authorities")
check("a book can be linked to it", st == 200 and len(links["links"]) == 1, links)

# The typo. Correcting it must keep the link.
st, r = call("PUT", f"/api/authorities/{aid}", {
    "kind": "person", "preferredForm": f"ΖΖ Επιφάνιος {uniq}", "dates": "315-403",
    "source": "local", "variants": [f"Epiphanius ZZ {uniq}", f"Ἐπιφάνιος ΖΖ {uniq}"]})
check("a heading can be corrected in place", st == 200, f"{st} {r}")
st, links = call("GET", f"/api/books/{ab}/authorities")
check("and the book still points at it",
      len(links["links"]) == 1 and links["links"][0]["preferredForm"] == f"ΖΖ Επιφάνιος {uniq}", links)
st, one = call("GET", f"/api/authorities/{aid}")
check("variants are replaced wholesale, not appended", len(one["variants"]) == 2, one["variants"])
check("and the use count sees the link", one.get("useCount") == 1, one.get("useCount"))

# Searching by a VARIANT is the whole reason variants are stored.
st, found = call("GET", f"/api/authorities?kind=person&q={urllib.parse.quote(f'Epiphanius ZZ {uniq}')}")
check("a heading is findable by any of its variants",
      any(x["id"] == aid for x in (found or {}).get("items", [])), found)

# One preferred form per kind, on update as well as create.
st, b2 = call("POST", "/api/authorities",
              {"kind": "person", "preferredForm": f"ΖΖ Άλλος {uniq}", "source": "local", "variants": []})
st, r = call("PUT", f"/api/authorities/{b2['id']}",
             {"kind": "person", "preferredForm": f"ΖΖ Επιφάνιος {uniq}", "source": "local", "variants": []})
check("an update cannot collide with another heading", st == 409, f"{st} {r}")
call("DELETE", f"/api/authorities/{b2['id']}")

# The literal route must not be swallowed by /:id. Two earlier instances of this
# exact fault shipped (/api/books/merge-candidates, /api/borrowers/export.csv).
st, cands = call("GET", "/api/authorities/subject-candidates?limit=5")
check("subject-candidates is not shadowed by /:id",
      st == 200 and isinstance((cands or {}).get("items"), list), f"{st} {str(cands)[:90]}")

# The preview was read-only with no POST to act on it, so the only way to use the
# librarian's own 628 category labels was 628 individual creates.
labels = [c["label"] for c in (cands or {}).get("items", []) if not c["alreadyExists"]][:2]
if labels:
    st, seeded = call("POST", "/api/authorities/seed-subjects", {"labels": labels, "link": True})
    check("approved candidates can be seeded in one action",
          st == 200 and seeded.get("created") == len(labels), f"{st} {seeded}")
    st, again = call("POST", "/api/authorities/seed-subjects", {"labels": labels, "link": True})
    check("and seeding the same labels twice creates nothing new",
          (again or {}).get("created") == 0 and (again or {}).get("skipped") == len(labels), again)
    st, subs = call("GET", f"/api/authorities?kind=subject&q={urllib.parse.quote(labels[0][:12])}")
    seeded_id = next((x["id"] for x in (subs or {}).get("items", []) if x["preferredForm"] == labels[0]), None)
    check("a seeded heading is linked to the books carrying the label",
          seeded_id is not None and next(x["useCount"] for x in subs["items"] if x["id"] == seeded_id) > 0,
          [(x["preferredForm"], x["useCount"]) for x in (subs or {}).get("items", [])[:3]])
    if seeded_id: call("DELETE", f"/api/authorities/{seeded_id}")
    for lb in labels[1:]:
        st, subs = call("GET", f"/api/authorities?kind=subject&q={urllib.parse.quote(lb[:12])}")
        for x in (subs or {}).get("items", []):
            if x["preferredForm"] == lb: call("DELETE", f"/api/authorities/{x['id']}")
else:
    check("approved candidates can be seeded in one action", False, "no unseeded candidates to test with")

# MARCXML ingest parsed every 650$a correctly and then threw the result away, so
# the richest available source of subject headings — records from another library
# that already carry LCSH — arrived with no subjects at all.
subj_title = f"ZZITEST Subjects {uniq}"
xml = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<collection xmlns="http://www.loc.gov/MARC21/slim"><record>'
    '<leader>00000nam a2200000 i 4500</leader>'
    f'<datafield tag="245" ind1="1" ind2="0"><subfield code="a">{subj_title}</subfield></datafield>'
    '<datafield tag="650" ind1=" " ind2="0"><subfield code="a">Orthodox Eastern Church</subfield></datafield>'
    '<datafield tag="650" ind1=" " ind2="7"><subfield code="a">ΖΖ Πατερική θεολογία</subfield></datafield>'
    '</record></collection>'
)
st, rep = call("POST", "/api/import/marcxml", raw=xml.encode(), ctype="application/xml")
st, found = call("GET", f"/api/books?pageSize=5&q={urllib.parse.quote(subj_title)}&partialWords=true&fuzzyTypos=false")
hit = next((b for b in (found or {}).get("items", []) if b["title"] == subj_title), None)
if hit:
    CREATED.append(hit["id"])
    st, links = call("GET", f"/api/books/{hit['id']}/authorities")
    forms = sorted(x["preferredForm"] for x in links["links"])
    check("MARCXML subject headings are no longer discarded",
          forms == ["Orthodox Eastern Church", "ΖΖ Πατερική θεολογία"], forms)
    check("and they link as subjects, which is what exports as 650",
          all(x["role"] == "sub" for x in links["links"]), links["links"])
    # ind2 = 0 is LCSH; anything else names its own thesaurus.
    st, subs = call("GET", "/api/authorities?kind=subject&q=Orthodox")
    lcsh = next((x for x in (subs or {}).get("items", []) if x["preferredForm"] == "Orthodox Eastern Church"), None)
    check("the thesaurus from ind2 is kept", (lcsh or {}).get("source") == "lcsh", lcsh)
    st, marc = call_text("GET", f"/api/books/{hit['id']}/marc")
    check("and they come back out as 650", marc.count('tag="650"') == 2, marc.count('tag="650"'))
    # A second import must not double them up.
    call("POST", "/api/import/marcxml", raw=xml.encode(), ctype="application/xml")
    st, links = call("GET", f"/api/books/{hit['id']}/authorities")
    check("re-importing does not duplicate the headings", len(links["links"]) == 2, links["links"])
    if lcsh: call("DELETE", f"/api/authorities/{lcsh['id']}")
    st, subs = call("GET", "/api/authorities?kind=subject&q=%CE%96%CE%96")
    for x in (subs or {}).get("items", []):
        if x["preferredForm"].startswith("ΖΖ"): call("DELETE", f"/api/authorities/{x['id']}")
else:
    check("MARCXML subject headings are no longer discarded", False, f"import failed: {rep}")

# Purge names every child table explicitly rather than trusting a cascade, and
# this one was missed — leaving rows pointing at a book id that no longer exists,
# which then inflated every heading's use count.
if LOCAL:
    pb2, _ = mkbook(title=f"ZZITEST Purge Auth {uniq}", author="ΖΖ")
    call("PUT", f"/api/books/{pb2}/authorities", {"links": [{"authorityId": aid, "role": "aut"}]})
    call("DELETE", f"/api/books/{pb2}")
    call("DELETE", f"/api/books/{pb2}/purge")
    rows = local_sql(f"SELECT COUNT(*) AS n FROM book_authorities WHERE book_id = '{pb2}'")
    # A probe that did not run is not an empty result: sql_count returns None for
    # it, and None == 0 is False. This is the assertion a migration renaming
    # book_authorities would otherwise have reported as green while orphan rows
    # accumulated and inflated every heading's use count.
    check("purging a record takes its authority links with it", sql_count(rows) == 0, rows)
else:
    print("  SKIP  1 purge-cascade check needs direct D1 access (local runs only)")

# Retiring unlinks, deliberately — a book must not point at a retired heading.
st, _ = call("DELETE", f"/api/authorities/{aid}")
st, links = call("GET", f"/api/books/{ab}/authorities")
check("retiring a heading unlinks the books that used it", len(links["links"]) == 0, links)
st, gone = call("GET", f"/api/authorities/{aid}")
check("and the heading is gone", st == 404, st)

print("=== 53. REGRESSION: readers, their category, and erasure that erases ===")
uniq = uuid.uuid4().hex[:8]

# Hono matches in registration order, so a `:id` route declared first swallows
# every literal path under the prefix. This one sat 167 lines below /:id, so every
# request for it answered 404 "Borrower not found" — and it had no caller, so
# nothing noticed. Third instance of this fault in the codebase.
st, csv_body = call_text("GET", "/api/borrowers/export.csv")
check("the borrower CSV export is not shadowed by /:id",
      st == 200 and "Name" in csv_body.split("\n")[0], f"{st} {csv_body[:80]}")

# Number('abc') is NaN, Math.min/max propagate it, and NaN bound as a SQL LIMIT
# is a 500 rather than a 400.
st, r = call("GET", "/api/borrowers?limit=abc")
check("a non-numeric limit does not 500", st == 200, st)
st, r = call("GET", "/api/borrowers?limit=5&page=1")
check("the list reports a total so a screen can page",
      st == 200 and isinstance((r or {}).get("total"), int) and (r or {}).get("page") == 1, r and list(r)[:4])
if (r or {}).get("total", 0) > 5:
    st, p2 = call("GET", "/api/borrowers?limit=5&page=2")
    first = {x["id"] for x in (r or {}).get("items", [])}
    second = {x["id"] for x in (p2 or {}).get("items", [])}
    check("and page 2 is a different page", first and second and not (first & second),
          f"{len(first)} vs {len(second)}, overlap {len(first & second)}")

# `category` is the axis a loan policy resolves on, and `resolveBorrower` — the
# only path that ever created a borrower in practice — omits it from its INSERT.
# So every reader took the 'standard' default, the (category x item type) matrix
# could only ever match the '*' fallback, and half the policy engine was dead.
st, br = call("POST", "/api/borrowers", {
    "name": f"ΖΖ Φοιτητής {uniq}", "contact": "+30 210 1234567",
    "category": f"zzstudent{uniq[:4]}", "notes": "ZZ note"})
brid = (br or {}).get("id")
check("a reader can be created with a category", st == 201 and brid, f"{st} {br}")
USERS.append(("borrower", brid))
st, one = call("GET", f"/api/borrowers/{brid}")
# SELECT * read the column and the response object dropped it, so the natural
# backing for a profile screen could not show the one field that decides how long
# this reader may keep a book.
check("the single-reader endpoint returns the category",
      one.get("category") == f"zzstudent{uniq[:4]}", one)
st, _ = call("PUT", f"/api/borrowers/{brid}", {"name": f"ΖΖ Φοιτητής {uniq}", "category": "zzstaff"})
check("and it can be changed", call("GET", f"/api/borrowers/{brid}")[1].get("category") == "zzstaff",
      call("GET", f"/api/borrowers/{brid}")[1].get("category"))

# The end of the chain: a category-specific rule must actually win over the
# fallback. Nothing asserted this because nothing could set a category.
st, pol = call("GET", "/api/loan-policies")
existing = [{k: v for k, v in p.items() if k != "id"} for p in (pol or {}).get("policies", [])]
st, r = call("PUT", "/api/loan-policies", {"policies": existing + [
    {"borrowerCategory": "zzstaff", "itemType": "*", "loanDays": 90,
     "renewalLimit": 5, "renewalDays": None, "maxConcurrentLoans": None,
     "lendable": True, "notes": "ZZ staff rule"}]})
if st == 200:
    lb, _ = mkbook(title=f"ZZITEST Policy {uniq}", author="ZZ")
    st, loan = call("POST", f"/api/books/{lb}/borrow", {"borrowerId": brid})
    if st in (200, 201):
        due = (loan or {}).get("dueAt") or (loan or {}).get("expectedDueAt") or ""
        days = None
        if due:
            d = datetime.datetime.fromisoformat(due.replace("Z", "+00:00"))
            days = (d - datetime.datetime.now(datetime.timezone.utc)).days
        check("a category-specific loan rule beats the fallback",
              days is not None and days >= 85, f"{days} days from {due}")
        call("POST", f"/api/books/{lb}/return", {})
    else:
        check("a category-specific loan rule beats the fallback", False, f"could not lend: {st} {loan}")
    # put the policy table back
    call("PUT", "/api/loan-policies", {"policies": existing})
else:
    check("a category-specific loan rule beats the fallback", False, f"policy write refused: {st} {r}")

# GDPR. The export withheld the category (personal data held about the subject)
# and omitted holds entirely (a queue position is a record of what they asked for).
hb, _ = mkbook(title=f"ZZITEST Hold GDPR {uniq}", author="ZZ")
st, h = call("POST", f"/api/books/{hb}/holds", {"borrowerId": brid})
check("a hold can be placed for them", st in (200, 201), f"{st} {h}")
st, exported = call("GET", f"/api/borrowers/{brid}/export")
check("the subject-access export includes the category",
      (exported or {}).get("borrower", {}).get("category") == "zzstaff", (exported or {}).get("borrower"))
check("and the holds they placed", len((exported or {}).get("holds", [])) >= 1, (exported or {}).get("holds"))

# Erasure. `holds` carries the same denormalized name and contact that
# borrow_transactions does — migration 0029 says so explicitly, because the queue
# has to read correctly after an erase — and the erase never touched the table. A
# reader erased while a hold was waiting kept their name AND phone number on
# display in the Circulation tab.
st, erased = call("POST", f"/api/borrowers/{brid}/erase")
sentinel = (erased or {}).get("anonymizedName")
check("erasure reports the placeholder it used", st == 200 and sentinel, f"{st} {erased}")
st, holds = call("GET", "/api/holds")
mine = [x for x in (holds or {}).get("items", []) if x.get("bookId") == hb]
check("the hold queue no longer names them",
      mine and mine[0].get("borrowerName") == sentinel and not mine[0].get("borrowerContact"), mine)
st, one = call("GET", f"/api/borrowers/{brid}")
check("the reader row is anonymized", one.get("name") == sentinel and not one.get("contact"), one)
check("and the category is reset — it is personal data too", one.get("category") == "standard", one.get("category"))
if LOCAL:
    left = local_sql(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE metadata LIKE '%ΖΖ Φοιτητής " + uniq + "%'")
    # Through sql_count, so dropping the `metadata` column — or running the gate
    # from another directory — fails here instead of certifying that a GDPR-erased
    # reader is no longer named in the audit trail.
    check("and the activity log stops naming them", sql_count(left) == 0, left)
else:
    print("  SKIP  1 audit-log sweep check needs direct D1 access (local runs only)")
call("DELETE", f"/api/holds/{(h or {}).get('id')}") if (h or {}).get("id") else None

print("=== 54. REGRESSION: a set count opens a list of the same size ===")
# The rail dropped a book from its cluster whenever `series` equalled the book's
# own title — 7,144 rows do, because the import auto-filled the field. The
# click-through filters on `custom:series = <label>` and applies no such drop, so
# 54 clusters advertised a count 96 books short of what they opened: "ΤΑ ΠΟΙΗΜΑΤΑ"
# showed 2 and opened 13. The facet-count contract this catalogue is built on says
# a count in the rail must reproduce as a filtered list.
st, sets = call("GET", "/api/books/sets?minBooks=2&limit=500")
items = (sets or {}).get("items", [])
check("the sets rail returns clusters", st == 200 and len(items) > 0, f"{st} {len(items)}")
check("and reports how many it matched before the limit",
      isinstance((sets or {}).get("matched"), int) and sets["matched"] >= len(items),
      {k: v for k, v in (sets or {}).items() if k != "items"})
check("and how many groups it suppressed", isinstance((sets or {}).get("suppressed"), int),
      (sets or {}).get("suppressed"))

# EVERY cluster the rail hands out, not a sample of it.
#
# This loop used to be `sorted(items, key=lambda x: -x["bookCount"])[:60]` — 60 of
# the 500 rows, under a comment claiming it checked them all — and sorted
# DESCENDING, so it looked only where a one-book discrepancy is proportionally
# smallest. Measured on this catalogue: 449 of the 500 clusters hold five books or
# fewer and exactly 9 of them were ever checked, while the defect this section
# exists for ("ΤΑ ΠΟΙΗΜΑΤΑ showed 2 and opened 13") lives in clusters of two. All
# 500 click-throughs take about 25 seconds and no KV writes — cheap GETs skip the
# rate limiter — which is what the old comment claimed and the old loop did not do.
mismatched = []
for it in items:
    q = urllib.parse.urlencode({"facetField": "custom:series", "facetValue": it["title"], "pageSize": 1})
    st, listed = call("GET", "/api/books?" + q)
    if (listed or {}).get("total") != it["bookCount"]:
        mismatched.append((it["title"], it["bookCount"], (listed or {}).get("total")))
# A disagreement is re-read against a FRESH rail before it is believed. The rail's
# counts come from a version-keyed cache read once above, and a record created
# while the loop runs — by a later section of this suite, or by a librarian on a
# live catalogue — moves the list total without moving that cached count. §48
# handles the same race the same way, with a window rather than a retry. (Observed:
# two clusters mismatched by exactly one book mid-loop and reconciled on re-read.)
if mismatched:
    st, fresh = call("GET", "/api/books/sets?minBooks=2&limit=500")
    railed_now = {i["title"]: i["bookCount"] for i in (fresh or {}).get("items", [])}
    confirmed = []
    for title, _railed_then, _opened_then in mismatched:
        q = urllib.parse.urlencode({"facetField": "custom:series", "facetValue": title, "pageSize": 1})
        st, listed = call("GET", "/api/books?" + q)
        if (listed or {}).get("total") != railed_now.get(title):
            confirmed.append((title[:30], railed_now.get(title), (listed or {}).get("total")))
    mismatched = confirmed
_matched = int((sets or {}).get("matched") or 0)
check(f"every set count reproduces as a filtered list ({len(items)} of {_matched} clusters)",
      not mismatched, mismatched[:6])
# Said out loud rather than left to be inferred from the number above: the rail has
# no offset, so the clusters past its limit cannot be fetched at all and this
# section cannot speak for them.
if _matched > len(items):
    print(f"  SKIP  {_matched - len(items)} clusters are past /api/books/sets's own "
          f"limit of 500 and unreachable (the endpoint takes no offset)")

# A book whose series equals its title AND carries a volume number is volume N of
# a work where every volume shares one title — the commonest shape of a multi-part
# work here, and the member drop hid the two largest examples in the library
# outright. Neither appeared in the rail at all.
titles = {it["title"]: it["bookCount"] for it in items}
big = [t for t in titles if "ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ" in t]
if big:
    check("a set whose volumes all share one title is no longer hidden",
          titles[big[0]] >= 40, (big[0][:40], titles[big[0]]))
else:
    check("a set whose volumes all share one title is no longer hidden", False,
          "ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ absent from the rail")

# And the suppression is per CLUSTER, so it can never change a count: a group is
# hidden only when every member is titled the same as the group and not one is
# numbered.
uniq = uuid.uuid4().hex[:8]
same = f"ZZITEST Ομάδα {uniq}"
for _ in range(2):
    mkbook(title=same, author="ZZ Sets", customFields={"series": same})
st, sets2 = call("GET", "/api/books/sets?minBooks=2&limit=500")
check("a group with no differing title and no volume numbers is suppressed",
      not any(i["title"] == same for i in (sets2 or {}).get("items", [])),
      [i["title"] for i in (sets2 or {}).get("items", []) if same in i["title"]])
# One volume number is enough evidence, and the count then includes every member.
mkbook(title=same, author="ZZ Sets", customFields={"series": same, "volume_num": "3"})
st, sets3 = call("GET", "/api/books/sets?minBooks=2&limit=500")
shown = next((i for i in (sets3 or {}).get("items", []) if i["title"] == same), None)
check("one volume number makes the group appear", shown is not None, shown)
check("with every member counted, including the ones titled like the group",
      (shown or {}).get("bookCount") == 3, shown)
q = urllib.parse.urlencode({"facetField": "custom:series", "facetValue": same, "pageSize": 1})
st, listed = call("GET", "/api/books?" + q)
check("and that count opens a list of the same size",
      (listed or {}).get("total") == (shown or {}).get("bookCount"),
      f'{(listed or {}).get("total")} vs {(shown or {}).get("bookCount")}')

print("=== 55. REGRESSION: the Handbook's mechanism (static) ===")
import glob as _glob
import subprocess as _sp
_REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
_HB = os.path.join(_REPO, "apps", "web", "src", "handbook")


def _slurp(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


hb_ctx = _slurp(_HB, "context.tsx")
hb_idx = _slurp(_HB, "index.tsx")
hb_reg = _slurp(_HB, "registry.ts")
main_tsx = _slurp(_REPO, "apps", "web", "src", "main.tsx")
css_all = _slurp(_REPO, "apps", "web", "src", "styles.css")

# The provider has to be above App, or a "?" inside the edit dialog cannot reach
# the Handbook without a prop threaded through every form between them.
#
# The NESTING is the property, so the nesting is what is matched. Testing that both
# tags appear somewhere in main.tsx said nothing: `<HandbookProvider></HandbookProvider>`
# followed by a sibling `<App />` satisfied it, and every HelpLink in the app would
# throw the moment a librarian pressed "?".
check("the Handbook provider wraps App",
      re.search(r"<HandbookProvider>\s*<App />\s*</HandbookProvider>", main_tsx) is not None,
      main_tsx[main_tsx.find("<HandbookProvider"):][:120] if "<HandbookProvider" in main_tsx else "absent")

# The "?" opens a DRAWER and never switches tab. Switching would unmount the edit
# form and lose every keystroke the librarian typed — which is what they opened
# the Handbook to finish.
#
# Stated as a POSITIVE property of these two modules, because the negative one was
# unfalsifiable: `"setCurrentSection" not in hb_ctx` named a useState binding local
# to App() in main.tsx, which is not in scope here and never could be, so the
# condition held no matter what the drawer did. Any real tab-switch would be spelled
# some other way — a callback on the context, or a call inside open(). So: the
# context hands out exactly these members, and open() touches exactly these three
# things. Adding a navigation callback, or a navigate call, now fails here.
_ctx_type = re.search(r"type HandbookValue = \{(.*?)\n\};", hb_ctx, re.S)
_ctx_members = sorted(set(re.findall(r"^  (\w+)\??:", _ctx_type.group(1) if _ctx_type else "", re.M)))
check("the Handbook context hands out nothing that can move the app",
      _ctx_members == ["close", "drawerOpen", "ensure", "fallback", "loading",
                       "open", "openAt", "pack", "target"],
      _ctx_members or "no HandbookValue type found")
_open_body = (hb_ctx.split("const open = useCallback(", 1)[1].split("}, [", 1)[0]
              if "const open = useCallback(" in hb_ctx else "")
check("opening the drawer moves the reader and nothing else",
      sorted(set(re.findall(r"\b([a-zA-Z_]\w*)\s*\(", _open_body)))
      == ["ensurePack", "setDrawerOpen", "setTarget"],
      sorted(set(re.findall(r"\b([a-zA-Z_]\w*)\s*\(", _open_body))) or "no open() body found")
_help_body = (hb_ctx.split("export function HelpLink(", 1)[1]
              if "export function HelpLink(" in hb_ctx else "")
_help_calls = sorted(set(re.findall(r"\b([a-zA-Z_]\w*)\s*\(", _help_body)) - {"return"})
check("and the '?' button does nothing but open it",
      _help_calls == ["open", "useHandbook"], _help_calls or "no HelpLink body found")
check("and it opens the drawer", "setDrawerOpen(true)" in hb_ctx, None)

# A bare "?" is not an accessible name.
check("the help link is named after the field it explains",
      "aria-label={label}" in hb_ctx and "'handbook.helpAbout'" in main_tsx, None)

# Anchors, not chapters: a form must not have to know how the Handbook is
# organised, or reorganising it breaks forms.
help_uses = re.findall(r"<HelpLink\s+anchor=\"([a-z0-9-]+)\"", main_tsx)
check("forms point at anchors, and at least one really does", len(help_uses) >= 3, help_uses)
declared = set(re.findall(r"^\s{2}'([a-z0-9-]+)':\s*'[a-z0-9-]+',?$", hb_reg, re.M))
check("every anchor a form points at is declared",
      all(a in declared for a in help_uses), [a for a in help_uses if a not in declared])

# The prose is the biggest thing in the app and is loaded on demand. A static
# import would undo that silently, so the check that catches it must exist and run.
check("the handbook check is wired into CI",
      "check:handbook" in _slurp(_REPO, "package.json")
      and "check:handbook" in _slurp(_REPO, ".github", "workflows", "ci.yml"), None)
res = _sp.run(["node", "scripts/check_handbook.mjs"], cwd=_REPO, capture_output=True, text=True)
check("and it passes", res.returncode == 0, (res.stdout + res.stderr)[-300:])

# The collision gate is the only defence against the failure that shipped in two
# languages: one word doing two jobs, in a sentence that reads perfectly and
# instructs the opposite. check_handbook.mjs enforces it and the check above runs
# it — but a passing run proves nothing if the rules were quietly emptied, which is
# exactly what a future edit tidying up "unused" config would do.
_hbchk = _slurp(_REPO, "scripts", "check_handbook.mjs")
_rules = re.search(r"COLLISION_RULES = \{(.*?)\n\};", _hbchk, re.S)
check("the handbook collision gate still declares rules",
      _rules and _rules.group(1).count("required") >= 5, None)
check("and still bans the terms that can take another's job",
      all(t in _hbchk for t in ("사본", "서명", "폐기")), None)
# The two collisions that actually reversed an instruction in Greek and Russian.
check("series and a periodical's run are held apart in Korean",
      "'periodical-runs'" in _hbchk and "'series-and-sets'" in _hbchk
      and "소장권호" in _hbchk and "총서" in _hbchk, None)
check("and erasing personal data is held apart from deleting a record",
      "개인정보" in _hbchk and "파기" in _hbchk, None)

# Four languages, and the Korean pack is the whole thing rather than a stub.
_ko = _slurp(_HB, "content", "ko.ts")
_ko_chapters = len(re.findall(r"^  '?[a-z][a-z0-9-]*'?: \{$", _ko, re.M))
_chapter_ids = re.findall(r"^  '([a-z0-9-]+)',?$", hb_reg, re.M)
# The lower bound is not decoration: both sides of this equality are regex counts
# over source layout, and reformatting the registry's chapter list would make it
# `0 == 0` — a pack with no chapters certified as carrying every chapter. 31 today.
check("the Korean pack carries every chapter",
      len(_chapter_ids) >= 20 and _ko_chapters == len(_chapter_ids),
      f"{_ko_chapters} of {len(_chapter_ids)}")
check("Korean is claimed as complete and loads its own pack",
      "'ko'" in hb_reg.split("TRANSLATED_LANGS")[1][:120]
      and "ko: () => import('./content/ko')" in hb_reg, None)

# Printing is the point of a reference book: the printed copy sits by the desk the
# laptop is not on. Nothing in this app had a print stylesheet before.
check("a print stylesheet exists", "@media print" in css_all, None)
check("paper gets every chapter, not the one on screen",
      ".hb-print-only" in css_all and "<HandbookPrintable />" in main_tsx, None)
check("and a rule is never split across two pages",
      "break-inside: avoid" in css_all, None)

# The renderer must handle every block kind. The exhaustive `never` in the switch
# makes a new kind a compile error rather than a silently blank paragraph.
kinds = set(re.findall(r"\|\s*\{\s*kind:\s*'([a-z]+)'", _slurp(_HB, "types.ts")))
rendered = set(re.findall(r"case '([a-z]+)':", hb_idx))
check("the renderer handles every block kind", kinds and kinds <= rendered, sorted(kinds - rendered))
check("and a new kind would be a compile error", "const never: never = b" in hb_idx, None)

# MARC tags live in facts.ts once. Four translations each carrying "245 $a" is
# four copies of one fact, and being wrong in exactly one is the likeliest outcome.
for pack in sorted(_glob.glob(os.path.join(_HB, "content", "*.ts"))):
    body = _slurp(pack)
    stray = re.findall(r"\b\d{3}\s*\$[a-z]", body)
    check(f"no MARC tag is written into {os.path.basename(pack)}", not stray, stray[:5])

print("=== 78. REGRESSION: every rail bucket can be opened ===")

# A rail bucket advertises a count and promises the list it opens reproduces it.
# `facetValue` was capped at 200 characters while the values it selects were not:
# 40 live records carry a title over 200 characters, so faceting on title produced
# 40 buckets whose click-through answered 400 and the screen did not move.
_shared78 = _slurp(_REPO, "packages", "shared", "src", "index.ts")
check("the facet value cap is one named constant",
      "export const FACET_VALUE_MAX" in _shared78
      and "facetValue: z.string().max(FACET_VALUE_MAX)" in _shared78, None)
_capped78 = _shared78.count("z.string().max(FACET_VALUE_MAX), z.number()")
check("and custom attribute values are capped by the same constant", _capped78 >= 3, _capped78)

# The round trip on a title longer than the old cap.
_long78 = ("ZZ Facet Long Title " + ("\u03b1\u03b2\u03b3\u03b4\u03b5 " * 40))[:260].strip()
check("the probe title is longer than the cap that used to reject it", len(_long78) > 200, len(_long78))
st, _bk78 = call("POST", "/api/books", {"title": _long78, "author": "Gate",
                                        "tags": [], "customFields": {}, "status": "available"})
check("a book with a 200+ character title is accepted", st == 201, st)
_b78 = (_bk78 or {}).get("id")
if _b78:
    CREATED.append(_b78)
    st, r = call("GET", "/api/books?" + urllib.parse.urlencode(
        {"facetField": "title", "facetValue": _long78, "pageSize": 5}))
    check("its facet bucket opens instead of answering 400", st == 200, (st, r))
    check("and the list it opens contains the record",
          any(b.get("id") == _b78 for b in (r or {}).get("items", [])), (r or {}).get("total"))

# The other half: an attribute value longer than the cap is refused on the way IN,
# rather than stored and then advertised as a bucket that cannot be opened.
_key78 = f"zzfacet_{uuid.uuid4().hex[:8]}"
st, _cf78 = call("POST", "/api/custom-fields",
                 {"key": _key78, "label": "Facet probe", "type": "text",
                  "required": False, "enumOptions": []})
if st == 201:
    st, _ = call("POST", "/api/books", {"title": "ZZ Facet Overlong Value", "author": "Gate",
                                        "tags": [], "customFields": {_key78: "x" * 501},
                                        "status": "available"})
    check("an attribute value past the cap is refused, not silently unclickable", st == 400, st)
    st, _bk = call("POST", "/api/books", {"title": "ZZ Facet Value At Cap", "author": "Gate",
                                          "tags": [], "customFields": {_key78: "y" * 500},
                                          "status": "available"})
    check("a value exactly at the cap is still accepted", st == 201, st)
    if (_bk or {}).get("id"):
        CREATED.append(_bk["id"])
        st, r = call("GET", "/api/books?" + urllib.parse.urlencode(
            {"facetField": "custom:" + _key78, "facetValue": "y" * 500, "pageSize": 5}))
        check("and its bucket opens at full length", st == 200, st)
    local_sql("DELETE FROM custom_field_definitions WHERE field_key = '" + _key78 + "'")

print("=== 77. REGRESSION: a re-import cannot split a book\'s date in two ===")

# `reconcileBookDates` states the invariant outright — "the two representations can
# never drift apart" — and the XLSX re-import UPDATE broke it by writing
# publication_year unconditionally while COALESCEing publication_year_end and
# date_edtf. A sheet with no year column therefore blanked the year and left the
# other two standing: (1955, 1957, '1955/1957') became (NULL, 1957, '1955/1957').
_lid77 = f"ZZ-DATE-{uuid.uuid4().hex[:10].upper()}"


def _dates77():
    if not LOCAL:
        return None
    r = local_sql("SELECT publication_year AS y, publication_year_end AS e, date_edtf AS d "
                  f"FROM books WHERE legacy_id = '{_lid77}'")
    return r[0] if r else None


def _row77(**extra):
    return {"title": "ZZ Date Invariant Probe", "author": "Gate", "legacyId": _lid77,
            "tags": [], "customFields": {}, **extra}


st, r = call("POST", "/api/import/books", {"dryRun": False, "rows": [_row77(dateEdtf="1955/1957")]})
check("a sheet carrying an EDTF span imports", st == 201 and (r or {}).get("importedRows") == 1, (st, r))
_d = _dates77()
if _d is not None:
    check("and the span derives both years",
          (_d["y"], _d["e"], _d["d"]) == (1955, 1957, "1955/1957"), _d)

# The case that broke it: a corrective sheet that mentions no date at all.
st, r = call("POST", "/api/import/books", {"dryRun": False, "rows": [_row77(shelfCode="A1")]})
check("a corrective sheet with no year column updates the record",
      st == 201 and (r or {}).get("updatedRows") == 1, (st, r))
_d = _dates77()
if _d is not None:
    check("and leaves all three date columns exactly as they were",
          (_d["y"], _d["e"], _d["d"]) == (1955, 1957, "1955/1957"), _d)

# A sheet that DOES speak moves all three together.
st, _ = call("POST", "/api/import/books", {"dryRun": False, "rows": [_row77(publicationYear=1960)]})
_d = _dates77()
if _d is not None:
    check("a sheet giving a bare year mirrors it into all three",
          (_d["y"], _d["e"], _d["d"]) == (1960, 1960, "1960"), _d)

# And an explicit null is a clear, not an omission — the distinction the reconciler
# documents for partial updates, which the CASE binding has to preserve.
st, _ = call("POST", "/api/import/books", {"dryRun": False, "rows": [_row77(publicationYear=None)]})
_d = _dates77()
if _d is not None:
    check("an explicit null clears all three, not one",
          (_d["y"], _d["e"], _d["d"]) == (None, None, None), _d)

if LOCAL:
    local_sql(f"DELETE FROM items WHERE book_id IN (SELECT id FROM books WHERE legacy_id = '{_lid77}')")
    local_sql(f"DELETE FROM books WHERE legacy_id = '{_lid77}'")

print("=== 76. REGRESSION: one check digit, one answer ===")

# The badge on a record and the smart list built to find broken ISBNs disagreed on
# 33 records, because `isbn_valid` was a GENERATED column — a second implementation
# of `checkIsbn` written in SQLite CASE arithmetic. Migration 0034 replaced it with
# a stored column written by `computeBookFolds`, so the two now share one function.
#
# The direct proof, over the WHOLE table rather than a sample: every record the list
# returns must carry the badge, and every record with a badge must be in the list.
if LOCAL:
    _iv = local_sql(
        "SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL "
        "AND isbn IS NOT NULL AND TRIM(isbn) <> '' AND isbn_valid IS NULL")
    check("no live record with an ISBN is left unjudged",
          _iv and int(_iv[0]["n"]) == 0, _iv[0] if _iv else "query failed")
    _gen = local_sql("SELECT COUNT(*) AS n FROM pragma_table_xinfo('books') "
                     "WHERE name = 'isbn_valid' AND hidden = 2")
    check("and it is a stored column, not a generated one",
          _gen and int(_gen[0]["n"]) == 0, _gen[0] if _gen else "query failed")

# Walk the list and the badge against each other through the API.
st, _inv = call("GET", "/api/books?invalidIsbn=1&limit=100")
_items = (_inv or {}).get("items", [])
check("the broken-ISBN list is not empty on this catalogue", len(_items) > 0, len(_items))
check("every record it returns carries the broken badge",
      all(b.get("isbnValid") is False for b in _items),
      [b.get("isbn") for b in _items if b.get("isbnValid") is not False][:5])

# A hyphenated ISBN is how every book on the shelf prints it, and the generated
# column tested LENGTH() on the raw value — so 978-0-19-826170-3 matched neither
# branch and a hyphenated ISBN with a bad check digit was invisible to this list.
# 9+21+8+0+1+27+8+6+6+3+7+0 = 96, so (10 - 96 % 10) % 10 = 4 is the RIGHT digit.
# Written the other way round first, and the gate said the badge disagreed — which
# was the assertion being wrong about the arithmetic, not the code.
_hyph_bad = "978-0-19-826170-1"
st, _bk76 = call("POST", "/api/books", {"title": "ZZ Hyphen ISBN Probe", "author": "Gate",
                                        "isbn": _hyph_bad, "tags": [], "customFields": {},
                                        "status": "available"})
check("a book with a hyphenated ISBN is accepted", st == 201, st)
_b76 = (_bk76 or {}).get("id")
if _b76:
    CREATED.append(_b76)
    st, _rec = call("GET", f"/api/books/{_b76}")
    check("its badge says the check digit is wrong", (_rec or {}).get("isbnValid") is False,
          (_rec or {}).get("isbnValid"))
    st, _list = call("GET", "/api/books?invalidIsbn=1&search=ZZ%20Hyphen%20ISBN%20Probe")
    check("and the smart list finds it, separators and all",
          any(b.get("id") == _b76 for b in (_list or {}).get("items", [])),
          (_list or {}).get("total"))
    # The same number with the RIGHT check digit must leave the list, which proves
    # the column is rewritten on update and not merely on insert.
    st, _cur = call("GET", f"/api/books/{_b76}")
    st, _ = call("PUT", f"/api/books/{_b76}",
                 {"isbn": "978-0-19-826170-4", "version": (_cur or {}).get("version", 0)})
    check("correcting the digit is accepted", st == 200, st)
    st, _rec2 = call("GET", f"/api/books/{_b76}")
    check("the badge clears", (_rec2 or {}).get("isbnValid") is True, (_rec2 or {}).get("isbnValid"))
    st, _list2 = call("GET", "/api/books?invalidIsbn=1&search=ZZ%20Hyphen%20ISBN%20Probe")
    check("and it leaves the list, so the column follows an UPDATE too",
          not any(b.get("id") == _b76 for b in (_list2 or {}).get("items", [])),
          (_list2 or {}).get("total"))

print("=== 75. REGRESSION: every permission in the matrix governs something ===")

# `labels.print` and `settings` were toggles in the admin matrix that no route
# consulted, so turning them off changed only which buttons the SPA drew. One of
# them had a server operation squarely inside the scope its own description
# advertises, gated on a different permission.
_idx = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
check("the QR/barcode generator is gated on labels.print",
      "app.post('/api/books/:id/codes', requirePermission('labels.print'" in _idx, None)

# The break itself, against a live role. A librarian WITHOUT labels.print may still
# write books, and must no longer be able to mint a code — the button disappearing
# was the whole of the old enforcement.
#
# PUT /api/role-permissions replaces the WHOLE matrix (it writes every key in
# PERMISSION_KEYS from `desired[perm] === true`), so the matrix is read, one key
# flipped, and the original put back in a finally — sending a fragment would strip
# every other permission from both roles.
_uname = f"zzperm{uuid.uuid4().hex[:8]}"
st, _ = call("POST", "/api/users", {"username": _uname, "password": "ZzIntegrity!2026", "role": "librarian"})
check("a probe librarian is created", st == 201, st)
USERS.append(_uname)
st, _perm = call("GET", "/api/role-permissions")
_matrix = (_perm or {}).get("matrix") or {}
_orig = json.loads(json.dumps(_matrix)) if _matrix else None
if _orig:
    try:
        _off = json.loads(json.dumps(_orig))
        _off["librarian"]["labels.print"] = False
        st, _ = call("PUT", "/api/role-permissions", {"matrix": _off})
        check("labels.print can be turned off for librarians", st == 200, st)
        _tok = login(_uname, "ZzIntegrity!2026")
        st, _page = call("GET", "/api/books?limit=1")
        _bk = next(iter((_page or {}).get("items", [])), None)
        if _bk and _tok:
            st, r = call("POST", f"/api/books/{_bk['id']}/codes",
                         {"type": "qr", "label": "zz-gate"}, token=_tok)
            check("and the endpoint then refuses, not just the button", st == 403, (st, r))
            st, _ = call("PUT", f"/api/books/{_bk['id']}",
                         {"title": _bk["title"], "version": _bk.get("version", 0)}, token=_tok)
            check("while the same librarian can still write books", st == 200, st)
            # And with it back on, the same call goes through — a toggle that only
            # ever refuses is not enforcement either.
            st, _ = call("PUT", "/api/role-permissions", {"matrix": _orig})
            st, r = call("POST", f"/api/books/{_bk['id']}/codes",
                         {"type": "qr", "label": "zz-gate"}, token=_tok)
            check("and permitted again once the toggle is back on", st in (200, 201), (st, r))
    finally:
        call("PUT", "/api/role-permissions", {"matrix": _orig})
        st, _after = call("GET", "/api/role-permissions")
        check("the matrix is left exactly as it was found",
              (_after or {}).get("matrix") == _orig, None)

# `settings` genuinely cannot be enforced — it shows a tab whose every action is
# governed by its own permission — so the honest fix was to stop advertising it as
# access control. The description must not read as a capability.
_i18n = _slurp(_REPO, "apps", "web", "src", "i18n.tsx")
_desc = re.findall(r"'perm\.settings\.desc':\s*'([^']*)'", _i18n)
check("all four locales describe settings as navigation", len(_desc) == 4, len(_desc))
check("and none of them still calls it access to the settings",
      all("Open the settings area" not in d for d in _desc), _desc)

print("=== 74. REGRESSION: a collision is refused by name, not by a retried 500 ===")

# Two UNIQUE indexes were written with no pre-check, so a collision surfaced as
# `{"error":"Internal server error"}` — a 5xx, which apps/web/src/api.ts retries four
# times before giving up. Both are the likeliest mistakes in their own workflow.

# books.legacy_id: UNIQUE on the bare column since migration 0005, so it covers the
# trash as well as the shelf.
_lid = f"ZZGATE-{uuid.uuid4().hex[:10].upper()}"
st, _bk1 = call("POST", "/api/books", {"title": "ZZ Gate Accession One", "author": "Gate",
                                       "legacyId": _lid, "tags": [], "customFields": {},
                                       "status": "available"})
check("a first accession number is accepted", st == 201, st)
_b1 = (_bk1 or {}).get("id")
if _b1: CREATED.append(_b1)
st, r = call("POST", "/api/books", {"title": "ZZ Gate Accession Two", "author": "Gate",
                                    "legacyId": _lid, "tags": [], "customFields": {},
                                    "status": "available"})
check("a second record cannot take it", st == 409, st)
check("and the refusal names the record holding it",
      "ZZ Gate Accession One" in json.dumps(r or {}), r)

st, _bk2 = call("POST", "/api/books", {"title": "ZZ Gate Accession Three", "author": "Gate",
                                       "tags": [], "customFields": {}, "status": "available"})
_b2 = (_bk2 or {}).get("id")
if _b2: CREATED.append(_b2)
if _b2:
    st, _cur = call("GET", f"/api/books/{_b2}")
    st, r = call("PUT", f"/api/books/{_b2}", {"legacyId": _lid, "version": (_cur or {}).get("version", 0)})
    check("nor can an edit move it onto another record", st == 409, st)
if _b1:
    st, _cur = call("GET", f"/api/books/{_b1}")
    st, _ = call("PUT", f"/api/books/{_b1}", {"legacyId": _lid, "version": (_cur or {}).get("version", 0)})
    check("but a record re-saving its OWN number is not a collision", st == 200, st)
    # The index does not honour deleted_at, so a number held by a binned record still
    # blocks — and a refusal that does not say where it is cannot be acted on.
    call("DELETE", f"/api/books/{_b1}")
    st, r = call("POST", "/api/books", {"title": "ZZ Gate Accession Four", "author": "Gate",
                                        "legacyId": _lid, "tags": [], "customFields": {},
                                        "status": "available"})
    check("a number held by a record in the trash still refuses", st == 409, st)
    check("and the refusal says it is in the trash",
          "trash" in json.dumps(r or {}).lower(), r)

# custom_field_definitions.field_key: UNIQUE on the column, so the SOFT-DELETED rows
# collide too — and those are invisible in GET /api/custom-fields, which is the only
# list the librarian has. That case gets the definition back rather than a refusal.
_key = f"zzgate_{uuid.uuid4().hex[:8]}"
st, _cf = call("POST", "/api/custom-fields", {"key": _key, "label": "Gate", "type": "text",
                                              "required": False, "enumOptions": []})
check("a first attribute key is accepted", st == 201, st)
_cfid = (_cf or {}).get("id")
st, r = call("POST", "/api/custom-fields", {"key": _key, "label": "Gate again", "type": "text",
                                            "required": False, "enumOptions": []})
check("a live duplicate key is refused, not 500", st == 409, st)
if _cfid:
    call("DELETE", f"/api/custom-fields/{_cfid}")
    st, _list = call("GET", "/api/custom-fields")
    check("a deleted attribute is absent from the list the librarian sees",
          all(f.get("key") != _key for f in (_list or {}).get("items", [])), _key)
    st, r = call("POST", "/api/custom-fields", {"key": _key, "label": "Gate reborn", "type": "text",
                                                "required": False, "enumOptions": []})
    check("so retyping the same key restores it rather than failing", st == 200, (st, r))
    check("and it is the same definition, so the values on books come back",
          (r or {}).get("id") == _cfid and (r or {}).get("restored") is True, r)
    # Reviving under a different type would leave every stored value the wrong type.
    st, _now = call("GET", "/api/custom-fields")
    _live = next((f for f in (_now or {}).get("items", []) if f.get("key") == _key), None)
    call("DELETE", f"/api/custom-fields/{(_live or {}).get('id')}")
    st, r = call("POST", "/api/custom-fields", {"key": _key, "label": "Gate", "type": "number",
                                                "required": False, "enumOptions": []})
    check("but not under a different type", st == 409, st)
    # Read the message itself: json.dumps would escape the quotes around the type
    # name, so the substring could never match and the check could only ever fail.
    check("and the refusal names the buried type",
          'type "text"' in ((r or {}).get("error") or ""), r)
    local_sql(f"DELETE FROM custom_field_definitions WHERE field_key = '{_key}'")

print("=== 73. REGRESSION: an anonymous caller cannot spend the write budget ===")

# `enforceRateLimit` did an unconditional KV PUT on every permitted request, and the
# two public protocol endpoints are configured at 60/minute. That is 86,400 permitted
# requests a day against a free-tier allowance of 1,000 KV writes — so the limiter ran
# out of its own storage after ~1.6% of the traffic it allows.
#
# And the same 1,000 writes back the read-through caches that the middleware's comment
# says make normal browsing "effectively free", so an anonymous flood degrades the
# LIBRARIAN's app: a better denial of service than the one being prevented.
_w73 = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
check("the public protocol bucket does not spend a KV write",
      "enforceRateLimit(c, 'harvest', 60, { kvBacked: false })" in _w73,
      "the harvest bucket is still KV-backed")
check("and the limiter still has a KV path for authenticated buckets",
      "enforceRateLimit(c, 'login', 20)" in _w73 and "CACHE.put(key" in _w73, None)

# It must still actually limit. The counter is per isolate, which is a floor rather
# than a guarantee across colos — but a tight loop, which is what this exists to stop,
# keeps arriving at the same isolate.
st, _cfg73 = call("GET", "/api/library-settings")
_prior73 = (_cfg73 or {}).get("publicSharing")
call("PUT", "/api/library-settings", {"publicSharing": "on"})
try:
    _ok = _limited = 0
    for _ in range(70):
        # call_text: OAI answers XML, and call() would try to parse it as JSON.
        st, _ = call_text("GET", "/api/oai?verb=Identify")
        if st == 429:
            _limited += 1
        else:
            _ok += 1
    check("an anonymous flood is still rate-limited", _limited > 0,
          f"{_ok} permitted, {_limited} limited")
    check("and the permitted share is about the configured minute limit",
          _ok <= 65, f"{_ok} permitted against a 60/min limit")
    # Give the window back. This section deliberately exhausts a 60/minute bucket
    # that later sections (§64, §67) also use, and the counter is keyed on
    # floor(now/60000) — so waiting for the next minute boundary clears it. Sleeping
    # to the boundary rather than a flat minute keeps the cost to what is needed.
    _wait = 61 - (int(time.time()) % 60)
    time.sleep(_wait)
finally:
    call("PUT", "/api/library-settings", {"publicSharing": _prior73 or "off"})

print("=== 72. REGRESSION: one definition of duplicate, one of in-use, one honest period ===")
uniq = uuid.uuid4().hex[:5]

# SQLite's LOWER() is ASCII-only — LOWER('ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ') returns the string
# unchanged — which is why the fold columns exist. The post-create duplicate WARNING
# was moved onto them; the duplicates REPORT that drives the merge tool was not, so
# the two detectors answered different questions about the same catalogue and every
# accent or case difference in a Greek title was invisible to the tool built to find
# exactly that.
_worker72 = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
_dupsrc = _worker72[_worker72.index("app.get('/api/books/duplicates'"):]
_dupsrc = _dupsrc[:_dupsrc.index("const [groupsRes")]
check("the duplicates report keys on the fold columns, not LOWER()",
      "title_fold" in _dupsrc and "LOWER(TRIM(title))" not in _dupsrc, _dupsrc[-260:])
if LOCAL:
    _cmp = local_sql("""SELECT
      (SELECT COUNT(*) FROM (SELECT LOWER(TRIM(title)) t, LOWER(TRIM(author)) a
         FROM books WHERE deleted_at IS NULL GROUP BY t,a HAVING COUNT(*)>1)) AS by_lower,
      (SELECT COUNT(*) FROM (SELECT TRIM(COALESCE(title_fold,'')) t, TRIM(COALESCE(author_fold,'')) a
         FROM books WHERE deleted_at IS NULL GROUP BY t,a HAVING COUNT(*)>1)) AS by_fold""")
    if _cmp:
        st, rep = call("GET", "/api/books/duplicates?limit=1")
        check("and the endpoint reports the fold count, not the ASCII one",
              (rep or {}).get("total") == int(_cmp[0]["by_fold"]),
              f"endpoint={(rep or {}).get('total')} fold={_cmp[0]['by_fold']} lower={_cmp[0]['by_lower']}")

# `books.room_code` has a foreign key to rooms; `items.room_code` (migration 0021)
# has none. The delete guard counted only books — and syncBookFromItems derives
# books.room_code from the PRIMARY copy alone, so a second copy shelved in the room
# was invisible to it. The room went, the copy kept pointing at a code that no longer
# existed, and no constraint objected.
st, mkroom = call("POST", "/api/rooms", {"code": f"ZZG{uniq}", "name": f"ZZ Guard {uniq}"})
_rid = (mkroom or {}).get("id") or (mkroom or {}).get("room", {}).get("id")
if _rid and LOCAL:
    _stored = (local_sql(f"SELECT code FROM rooms WHERE id = '{_rid}'") or [{}])[0].get("code")
    st, mkb = call("POST", "/api/books", {"title": f"ZZGUARD {uniq}", "author": "ZZ"})
    _bid = (mkb or {}).get("id")
    st, got = call("GET", f"/api/books/{_bid}/items")
    _iid = ((got or {}).get("items") or [{}])[0].get("id")
    if _bid and _iid and _stored:
        CREATED.append(_bid)
        # Copy 1 elsewhere, copy 2 in the room: books.room_code never sees it.
        st, _ = call("PUT", f"/api/books/{_bid}/items", {"items": [
            {"id": _iid, "shelfCode": "01-001"},
            {"shelfCode": "02-002", "roomCode": _stored}
        ]})
        check("a second copy can be filed in a room", st == 200, st)
        _refs = local_sql(f"""SELECT (SELECT COUNT(*) FROM books WHERE room_code = '{_stored}') AS by_book,
                                     (SELECT COUNT(*) FROM items WHERE room_code = '{_stored}') AS by_item""")
        check("and the books table does not see it (the primary copy is elsewhere)",
              _refs and int(_refs[0]["by_book"]) == 0 and int(_refs[0]["by_item"]) == 1, _refs)
        st, body = call("DELETE", f"/api/rooms/{_rid}")
        check("so deleting the room is refused on the COPY's account",
              st == 409, f"{st} {str(body)[:120]}")
        call("DELETE", f"/api/books/{_bid}")
        call("DELETE", f"/api/books/{_bid}/purge")
        st, _ = call("DELETE", f"/api/rooms/{_rid}")
        check("and allowed once nothing references it", st in (200, 204), st)
    else:
        call("DELETE", f"/api/rooms/{_rid}")

# The ISO 2789 return echoes a period and applies it to the FLOW measures only; the
# stock and registered-reader counts have no date predicate at all. Stated rather
# than silently bounded — `created_at` for the legacy catalogue is one import
# timestamp, so filtering by it would report zero holdings for every earlier period.
st, rep72 = call("GET", "/api/reports/iso2789?from=2020-01-01&to=2021-01-01")
_cav = " ".join((rep72 or {}).get("caveats") or [])
check("the statutory return says its holdings are as of today, not the period end",
      "as they stand today" in _cav, (rep72 or {}).get("caveats"))

print("=== 71. REGRESSION: MARC that another library can file ===")
uniq = uuid.uuid4().hex[:6]

def _marc71(title, author, romanized=None):
    body = {"title": title, "author": author}
    if romanized:
        body["titleRomanized"] = romanized
    st, made = call("POST", "/api/books", body)
    _id = (made or {}).get("id")
    if _id:
        CREATED.append(_id)
    st, xml = call_text("GET", f"/api/books/{_id}/marc?format=marcxml")
    return xml or ""

# ind2 counts the characters a filing system must SKIP, and it was hard-coded to 0
# on the strength of a comment claiming the catalogue stores titles without leading
# articles. It does not — 3,042 of 12,670 titles begin with one. Declaring 0 files
# THE DIVINE LITURGY under T at every library that respects the indicator.
_x = _marc71(f"The Divine Liturgy {uniq}", "ZZ Author")
_m = re.search(r'tag="245"[^>]*ind2="(\d)"', _x)
check("an English leading article is counted as non-filing", _m and _m.group(1) == "4",
      _m.group(0) if _m else _x[:140])
_x = _marc71(f"Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ {uniq}", "")
_m = re.search(r'tag="245"[^>]*ind2="(\d)"', _x)
check("and a Greek one is too", _m and _m.group(1) == "2", _m.group(0) if _m else _x[:140])
# The other direction matters more: a count that eats a real word misfiles the record
# just as badly, so anything not an unambiguous article must stay 0.
_x = _marc71(f"ΘΕΟΛΟΓΙΑ ΚΑΙ ΖΩΗ {uniq}", "ZZ Author")
_m = re.search(r'tag="245"[^>]*ind2="(\d)"', _x)
check("while a title that merely starts with a letter is left at 0",
      _m and _m.group(1) == "0", _m.group(0) if _m else _x[:140])

# ISBD punctuation INTRODUCES the element after it. It was appended unconditionally,
# so 3,722 records exported a title ending " /" with no statement of responsibility
# behind it — a mark pointing at nothing.
_x = _marc71(f"ZZNOAUTHOR {uniq}", "")
_a = re.search(r'tag="245".*?code="a">([^<]*)<', _x, re.S)
check("a title with no author does not end in the mark that introduces one",
      _a and not _a.group(1).rstrip().endswith("/"), _a.group(1) if _a else _x[:140])
check("and emits no statement of responsibility either",
      'code="c"' not in (re.search(r'tag="245".*?</datafield>', _x, re.S) or [""])[0], None)
_x = _marc71(f"ZZWITHAUTHOR {uniq}", "ZZ Author")
_a = re.search(r'tag="245".*?code="a">([^<]*)<', _x, re.S)
check("while a title that HAS one still introduces it",
      _a and _a.group(1).rstrip().endswith("/"), _a.group(1) if _a else _x[:140])

# MARC 21: "Subfield $6 in the associated field ALSO links that field to field 880."
# Only the 880 half was emitted, so a receiving system had a romanized title it could
# not attach to anything. Our own importer reads only the 880 side, which is why a
# round trip through this system never showed it.
_x = _marc71(f"ΚΛΗΜΗΣ ΡΩΜΗΣ {uniq}", "ZZ Author", romanized=f"Klemes Romes {uniq}")
_f880 = re.search(r'tag="880".*?code="6">([^<]*)<', _x, re.S)
_f245 = re.search(r'tag="245".*?</datafield>', _x, re.S)
check("an 880 is emitted for the romanized title", bool(_f880), _x[:160])
check("and its partner field carries the reciprocal $6",
      _f245 and 'code="6">880-' in _f245.group(0), _f245.group(0)[:200] if _f245 else None)

# The inverse language map was built from a table containing BOTH `ka` and `ge` for
# Georgian, and fromEntries lets the last key win — so `geo` inverted to `ge`, which
# is not an ISO 639-1 code, and a Georgian record changed language on a round trip.
_shared71 = _slurp(_REPO, "packages", "shared", "src", "index.ts")
_fwd71 = _shared71[_shared71.index("const ISO639_1_TO_2B"):]
_fwd71 = _fwd71[:_fwd71.index("};")]
_pairs71 = re.findall(r"([A-Za-z]{2,3}):\s*'([a-z]{3})'", _fwd71)
_dupes71 = [t for t in set(v for _, v in _pairs71)
            if len([1 for _, v in _pairs71 if v == t]) > 1]
check("the language table the inverse is derived from is injective",
      not _dupes71, f"three-letter codes reached by more than one key: {_dupes71}")

print("=== 70. REGRESSION: changing a password ends the sessions it opened ===")
uniq = uuid.uuid4().hex[:6]

# authMiddleware re-reads the account on every request and its comment states the
# aim: "one indexed primary-key read is a cheap price for making revocation
# immediate". That covered deactivation and demotion. It did NOT cover a credential
# change, because nothing the middleware read changed when the password did — so a
# token taken from a shared machine kept full write access for the rest of its
# 12-hour life AFTER the password was changed precisely to stop it.
_un = f"zzrevoke{uniq}"
st, made = call("POST", "/api/users",
                {"username": _un, "password": "ZZoldpass!2026", "role": "librarian"})
_uid = (made or {}).get("user", made or {}).get("id")
if st in (200, 201) and _uid:
    USERS.append(_un)
    _stolen = login(_un, "ZZoldpass!2026")
    st, _ = call("GET", "/api/auth/session", token=_stolen)
    check("a signed-in token works before the change", st == 200, st)

    st, _ = call("PUT", f"/api/users/{_uid}", {"password": "ZZnewpass!2026"})
    check("an admin can reset the password", st == 200, st)

    st, body = call("GET", "/api/auth/session", token=_stolen)
    check("and the token issued under the OLD password stops working",
          st == 401, f"{st} {str(body)[:110]}")
    st, _ = call("POST", "/api/books", {"title": f"ZZREVOKE {uniq}", "author": "ZZ"}, token=_stolen)
    check("including for writes", st == 401, st)

    _fresh = login(_un, "ZZnewpass!2026")
    st, _ = call("GET", "/api/auth/session", token=_fresh)
    check("while the new password signs in normally", st == 200, st)

    # The self-service path must revoke too, and must NOT lock the user out of the
    # change they just made — a username change reissues a token, and stamping it
    # with the pre-change epoch would fail on its very next use.
    st, _ = call("PATCH", "/api/me",
                 {"currentPassword": "ZZnewpass!2026", "newPassword": "ZZthirdpass!2026"},
                 token=_fresh)
    check("a librarian can change their own password", st == 200, st)
    st, _ = call("GET", "/api/auth/session", token=_fresh)
    check("and that also ends the session it was made from", st == 401, st)
    _third = login(_un, "ZZthirdpass!2026")
    st, _ = call("GET", "/api/auth/session", token=_third)
    check("and the newest password works", st == 200, st)

# Existing sessions must survive the DEPLOY: a token issued before migration 0033
# carries no epoch, and absent must read as 0 — the column's default — or upgrading
# would sign every librarian out.
_auth70 = _slurp(_REPO, "apps", "api-worker", "src", "auth.ts")
check("a token with no epoch claim is treated as epoch 0",
      "claims.epoch ?? 0" in _auth70, None)
check("and the epoch is read in the SELECT the middleware already makes",
      "SELECT role, active, token_epoch FROM staff_users" in _auth70, None)

print("=== 69. REGRESSION: what the free tier is spent on ===")

# The hold shelf read the whole catalogue to show a list of about a hundred. The only
# index mentioning `status` leads with book_id, so SQLite drove the join from books
# and probed holds once per live record: ~12,800 rows for ~130 candidates, on a
# screen the desk keeps open, against a daily row-read budget.
if LOCAL:
    _plan = local_sql("""EXPLAIN QUERY PLAN
        SELECT h.id, b.title, i.copy_number
          FROM holds h
          JOIN books b ON b.id = h.book_id AND b.deleted_at IS NULL
          LEFT JOIN items i ON i.id = h.item_id
         WHERE h.status IN ('waiting', 'ready')
         ORDER BY (h.status = 'ready') DESC, h.placed_at ASC, h.rowid ASC
         LIMIT 500""") or []
    _steps = [str(r.get("detail", "")) for r in _plan]
    check("the hold shelf drives from holds, not from every book",
          bool(_steps) and "holds" in _steps[0].lower() and "idx_holds_open" in _steps[0],
          _steps[:3])
    _idx = local_sql("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_holds_open'")
    check("and the index it needs exists", bool(_idx), _idx)

# The limiter's comment lists "full-table CSV export" among the expensive GETs it
# meters. The predicate tested `endsWith('/export.csv')`, which neither
# /api/export/books.csv nor /api/export/books.marcxml satisfies — so the two heaviest
# reads in the system were in no bucket at all while the comment said otherwise.
_worker69 = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
_pred = _worker69[_worker69.index("const isExpensiveGet"):]
_pred = _pred[:_pred.index(");")]
check("the expensive-GET bucket matches the export routes that exist",
      "startsWith('/api/export/')" in _pred, _pred[:200])
for _route in ("/api/export/books.csv", "/api/export/books.marcxml"):
    check(f"so {_route} is metered", f"app.get('{_route}'" in _worker69, None)

# OAI-PMH recomputed completeListSize on EVERY page of a ~199-page harvest — about
# four million rows read for a number that cannot change during the walk, against a
# five-million-row daily allowance, from an unauthenticated endpoint.
st, _cfg69 = call("GET", "/api/library-settings")
_prior69 = (_cfg69 or {}).get("publicSharing")
call("PUT", "/api/library-settings", {"publicSharing": "on"})
try:
    st, p1 = call_text("GET", "/api/oai?verb=ListIdentifiers&metadataPrefix=oai_dc")
    _tok = (re.search(r"<resumptionToken[^>]*>([^<]+)</resumptionToken>", p1 or "") or [None, ""])[1]
    _size1 = (re.search(r'completeListSize="(\d+)"', p1 or "") or [None, "0"])[1]
    check("a harvest reports a complete list size", int(_size1) > 0, _size1)
    if _tok:
        import base64 as _b64
        _payload = json.loads(_b64.b64decode(_tok + "=" * (-len(_tok) % 4)))
        check("and the resumption token carries it, so the count is not repeated",
              int(_payload.get("total", 0)) == int(_size1), _payload)
        st, p2 = call_text("GET", f"/api/oai?verb=ListIdentifiers&resumptionToken={_tok}")
        _size2 = (re.search(r'completeListSize="(\d+)"', p2 or "") or [None, "0"])[1]
        check("and the next page agrees without recomputing it", _size1 == _size2,
              f"{_size1} vs {_size2}")
finally:
    call("PUT", "/api/library-settings", {"publicSharing": _prior69 or "off"})

print("=== 68. REGRESSION: an imported record is a real record ===")
uniq = uuid.uuid4().hex[:6]

# A record with NO COPY is not a record with no copy — it is a record that has
# fallen out of the catalogue: invisible to every location facet, to the room
# summary, and to the copies layer that is the source of truth for where a volume
# is. Every other creation path calls ensurePrimaryItem and says so in a comment;
# both spreadsheet imports did not, so they wrote books.shelf_code from the sheet
# and created zero copies. The shelf was recorded and unreachable.
_legacy68 = f"ZZIMPITEM-{uniq}"
st, res = call("POST", "/api/import/books", {"dryRun": False, "rows": [{
    "legacyId": _legacy68, "title": f"ZZIMPITEM {uniq}", "author": "ZZ", "shelfCode": "07-199"}]})
check("the import accepts a row with a shelf mark",
      st in (200, 201) and (res or {}).get("importedRows") == 1, f"{st} {res}")
if LOCAL:
    _r68 = local_sql(f"""SELECT b.id, b.shelf_code AS book_shelf,
                                (SELECT COUNT(*) FROM items i
                                  WHERE i.book_id = b.id AND i.deleted_at IS NULL) AS copies,
                                (SELECT i.shelf_code FROM items i
                                  WHERE i.book_id = b.id AND i.deleted_at IS NULL LIMIT 1) AS copy_shelf
                           FROM books b WHERE b.legacy_id = '{_legacy68}'""")
    row68 = _r68[0] if _r68 else None
    if row68:
        CREATED.append(row68["id"])
    check("and the imported record has a copy, not just a shelf column",
          row68 and int(row68["copies"]) == 1, row68)
    check("and the copy carries the shelf mark the sheet gave",
          row68 and row68["copy_shelf"] == "07-199", row68)

    # The invariant behind it, over the whole table: a live record with no copy is
    # missing from every location answer in the app.
    _orphans68 = local_sql("""SELECT COUNT(*) AS n FROM books b
                               WHERE b.deleted_at IS NULL
                                 AND NOT EXISTS (SELECT 1 FROM items i
                                                  WHERE i.book_id = b.id AND i.deleted_at IS NULL)""")
    check("no live record anywhere is without a copy",
          _orphans68 and int(_orphans68[0]["n"]) == 0,
          _orphans68[0]["n"] if _orphans68 else "query failed")

# The MARCXML re-import wrote title/author/publisher/description and NOT their folds
# — the only books UPDATE in the worker with that gap. The FTS triggers index
# COALESCE(new.title_fold, new.title, ''), and COALESCE only falls through when the
# fold is NULL, so a stale fold WINS: a record re-imported with a corrected title
# kept answering searches under the old one.
_worker68 = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
import re as _re68
_updates68 = [(m.start(), m.group(1)) for m in
              _re68.finditer(r"`UPDATE books SET(.{0,900}?)`", _worker68, _re68.S)]
_textcols68 = ("title = ?", "title=?")
_missing68 = [
    _worker68[:pos].count("\n") + 1
    for pos, seg in _updates68
    if any(t in seg for t in _textcols68) and "_fold" not in seg
]
check("every books UPDATE that writes text writes its folds too",
      not _missing68, f"lines missing folds: {_missing68}")

# Same sweep, same reasoning, for the column migration 0034 moved out of SQL: the
# whole point of storing it is that the write paths carry it, and there are twelve.
_missing_iv = [
    _worker68[:pos].count("\n") + 1
    for pos, seg in _updates68
    if ("isbn = ?" in seg or "isbn=?" in seg) and "isbn_valid" not in seg
]
check("every books UPDATE that writes an isbn writes isbn_valid",
      not _missing_iv, f"lines missing isbn_valid: {_missing_iv}")
_inserts_iv = [
    _worker68[:m.start()].count("\n") + 1
    for m in _re68.finditer(r"INSERT (?:OR IGNORE )?INTO books\s*\(([^)]*)\)", _worker68, _re68.S)
    if "isbn_valid" not in m.group(1)
]
check("and every books INSERT does too", not _inserts_iv, f"lines: {_inserts_iv}")

print("=== 67. REGRESSION: SRU answers the query it was asked ===")

st, _cfg67 = call("GET", "/api/library-settings")
_prior67 = (_cfg67 or {}).get("publicSharing")
call("PUT", "/api/library-settings", {"publicSharing": "on"})
try:
    def _sru(qs):
        return call_text("GET", "/api/sru?version=1.2&operation=searchRetrieve&" + qs)

    # startRecord is an ABSOLUTE position, not a page number. It was divided into a
    # page and the remainder discarded, so any value not 1 + k*maximumRecords snapped
    # back to the start of its page while <recordPosition> still counted from the
    # value asked for: the window and its own labels disagreed.
    st, base = _sru("query=%CE%9F&maximumRecords=9&startRecord=1&recordSchema=dc")
    _ids = re.findall(r"<dc:identifier>([0-9a-f-]{36})</dc:identifier>", base or "")
    check("a baseline SRU window returns records", len(_ids) >= 7, len(_ids))
    if len(_ids) >= 7:
        for _sr in (4, 7):
            st, page = _sru(f"query=%CE%9F&maximumRecords=3&startRecord={_sr}&recordSchema=dc")
            got = re.findall(r"<dc:identifier>([0-9a-f-]{36})</dc:identifier>", page or "")
            want = _ids[_sr - 1:_sr - 1 + 3]
            check(f"startRecord={_sr} returns the window it names", got == want,
                  f"got {[g[:8] for g in got]} want {[w[:8] for w in want]}")
            pos = re.findall(r"<recordPosition>(\d+)</recordPosition>", page or "")
            check(f"and labels it {_sr}..{_sr + 2}", pos == [str(_sr), str(_sr + 1), str(_sr + 2)], pos)

    # The explain record advertises dc.language, and the DC output publishes ISO
    # 639-2/B ("gre"). The filter matched the raw stored column ("EL"), so a caller
    # searching for the value this server had just published found nothing.
    st, a = _sru("query=dc.language%3Dgre&maximumRecords=1&recordSchema=dc")
    st, b = _sru("query=dc.language%3DEL&maximumRecords=1&recordSchema=dc")
    _n = lambda x: (re.search(r"<numberOfRecords>(\d+)", x or "") or [0, "0"])[1]
    check("dc.language accepts the code the server itself publishes",
          int(_n(a)) > 0, f"gre={_n(a)}")
    check("and still accepts the stored form", _n(a) == _n(b), f"gre={_n(a)} EL={_n(b)}")

    # A relation the server does not implement was accepted and silently downgraded
    # to a partial-word AND search, so `exact` returned partial matches and called
    # them exact. protocols.ts states the rule: implementing a fraction and ignoring
    # the rest is worse than not accepting it.
    st, ex = _sru("query=dc.title+exact+%22X%22&maximumRecords=1")
    check("an unimplemented CQL relation is refused with diagnostic 19",
          "diagnostic/1/19" in (ex or ""), (ex or "")[:180])
    st, rp = _sru("query=%CE%9F&recordPacking=string&maximumRecords=1")
    check("and an unsupported recordPacking with diagnostic 71",
          "diagnostic/1/71" in (rp or ""), (rp or "")[:180])
    st, ok = _sru("query=%CE%9F&maximumRecords=1&recordSchema=dc")
    check("while a supported relation still searches", "<record>" in (ok or ""), (ok or "")[:140])
finally:
    call("PUT", "/api/library-settings", {"publicSharing": _prior67 or "off"})

print("=== 66. REGRESSION: numbers a librarian acts on ===")
uniq = uuid.uuid4().hex[:6]

# (a) A malformed body threw SyntaxError out of c.req.json() and escaped the ZodError
# branch into the generic 500 — which is exactly what that branch exists to prevent:
# the web client treats a 5xx write as transient and retries it four times, so one
# malformed body became four failures and an opaque requestId.
st, body = call_raw_json("POST", "/api/books", '{"title": "unclosed')
check("a malformed JSON body is a 400, not a retried 500",
      st == 400 and "JSON" in str(body), f"{st} {str(body)[:110]}")

# (b) An authority's use count is stated to the librarian immediately before an
# IRREVERSIBLE unlink, so it is the one number that has to be right. Two ways it was
# not: the list counted links from TRASHED records, and the detail reported the LENGTH
# of a sample capped at LIMIT 100 — so any heading on more than a hundred records said
# exactly 100 beside a button that would unlink all of them.
st, made = call("POST", "/api/authorities",
                {"kind": "person", "preferredForm": f"ZZCOUNT {uniq}", "source": "local"})
_aid = (made or {}).get("id")
if _aid and LOCAL:
    _bookids = []
    for i in range(104):
        st, b = call("POST", "/api/books", {"title": f"ZZCOUNTBK {uniq} {i:03d}", "author": "ZZ"})
        _bid = (b or {}).get("id")
        if _bid:
            _bookids.append(_bid)
            CREATED.append(_bid)
    if len(_bookids) >= 104:
        _vals = ",".join(f"('{b}','{_aid}','aut',0,datetime('now'))" for b in _bookids)
        local_sql("INSERT OR IGNORE INTO book_authorities (book_id,authority_id,role,seq,created_at) "
                  f"VALUES {_vals}")
        st, det = call("GET", f"/api/authorities/{_aid}")
        check("an authority's use count is not capped at the sample size",
              (det or {}).get("useCount") == 104, f"useCount={(det or {}).get('useCount')} of 104")
        check("while the sample it shows stays a sample",
              len((det or {}).get("usedBy") or []) == 100, len((det or {}).get("usedBy") or []))
        # Now trash a quarter of them: the count must fall, on BOTH endpoints.
        for _bid in _bookids[:24]:
            call("DELETE", f"/api/books/{_bid}")
        st, det2 = call("GET", f"/api/authorities/{_aid}")
        check("and trashing a record lowers it", (det2 or {}).get("useCount") == 80,
              f"useCount={(det2 or {}).get('useCount')} of 80")
        _seen = None
        for _off in (0, 200, 400, 600, 800):
            st, lst = call("GET", f"/api/authorities?limit=200&offset={_off}")
            for x in (lst or {}).get("items", (lst or {}).get("authorities", [])):
                if x.get("id") == _aid:
                    _seen = x.get("useCount")
            if _seen is not None:
                break
        check("the LIST agrees with the detail, counting no trashed links",
              _seen == 80, f"list={_seen}, detail=80")
        local_sql(f"DELETE FROM book_authorities WHERE authority_id = '{_aid}'")
    call("DELETE", f"/api/authorities/{_aid}")

# (c) The ISO 2789 withdrawals figure excluded every withdrawal on a record that had
# ever been merged away — a predicate meant to skip merge tombstones, which merges do
# not create: they re-parent live copies and soft-delete the BOOK. Measured: zero
# deleted items across every merged record, so the predicate only ever removed real
# withdrawals from a return filed with a national library.
if LOCAL:
    _mergedeleted = local_sql("""SELECT COUNT(*) AS n FROM items i JOIN books b ON b.id = i.book_id
                                  WHERE i.deleted_at IS NOT NULL AND b.merged_into IS NOT NULL
                                    AND i.deleted_at = b.deleted_at""")
    check("a merge still creates no item tombstone to over-report",
          _mergedeleted is not None, "query failed")
    _worker66 = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
    check("the withdrawals figure no longer drops a withdrawal for an unrelated merge",
          "AND NOT (b.merged_into IS NOT NULL AND i.deleted_at = b.deleted_at)" in _worker66
          and "AND b.merged_into IS NULL\n" not in _worker66.split("B.2.4 withdrawals")[1][:900],
          None)

print("=== 65. REGRESSION: the public endpoints publish no barcodes ===")

# protocols.ts and index.ts both state in their headers that SRU and OAI-PMH "expose
# bibliographic records ONLY — never borrowers, loans, staff or holdings barcodes".
# They published 852 $p for every copy to any anonymous caller. A barcode is the token
# that identifies a physical volume at the desk, and every other route in this worker
# needs a session to see one.
st, _cfg65 = call("GET", "/api/library-settings")
_prior65 = (_cfg65 or {}).get("publicSharing")
call("PUT", "/api/library-settings", {"publicSharing": "on"})
try:
    _bc = local_sql("SELECT book_id FROM items WHERE barcode IS NOT NULL "
                    "AND TRIM(barcode) <> '' AND deleted_at IS NULL LIMIT 1") if LOCAL else None
    _bid65 = _bc[0]["book_id"] if _bc else None
    _isil65 = (_cfg65 or {}).get("isil") or "GR-ZZTEST"
    if _bid65:
        st, pub = call_text("GET", f"/api/oai?verb=GetRecord&metadataPrefix=marcxml"
                                   f"&identifier=oai:{_isil65}:{_bid65}")
        check("the record is served publicly at all", st == 200 and "<record" in (pub or ""), (pub or "")[:140])
        check("but the public record carries no barcode subfield",
              'code="p"' not in (pub or ""), "852 $p is present on an anonymous request")
        # And the staff export must NOT have been weakened to achieve that.
        st, staff = call_text("GET", f"/api/books/{_bid65}/marc?format=marcxml")
        check("while the staff export still carries it, where it belongs",
              st == 200 and 'code="p"' in (staff or ""), (staff or "")[:140])
    else:
        check("a barcoded copy exists to test with", False, "no barcoded copy found")
finally:
    call("PUT", "/api/library-settings", {"publicSharing": _prior65 or "off"})

print("=== 64. REGRESSION: OAI-PMH argument handling ===")

# Sharing must be ON for these; restored below whatever it was.
st, _cfg = call("GET", "/api/library-settings")
_prior_sharing = (_cfg or {}).get("publicSharing")
call("PUT", "/api/library-settings", {"publicSharing": "on"})
try:
    _today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")

    # Day granularity is REQUIRED by the spec and `until` is INCLUSIVE. Both bounds
    # went straight into a string comparison against a millisecond timestamp, so a
    # bare date in `until` is a strict prefix of every timestamp on that day and
    # excluded the whole day it named: a single-day harvest returned nothing.
    st, body = call_text("GET", f"/api/oai?verb=ListIdentifiers&metadataPrefix=oai_dc&from={_today}&until={_today}")
    check("a single-day harvest returns the records saved that day",
          st == 200 and "<identifier>" in body and "noRecordsMatch" not in body,
          body[:160])

    # `set` was read only as a forbidden companion to resumptionToken and otherwise
    # ignored, so a harvester asking for one set silently received the whole
    # catalogue — while ListSets answered noSetHierarchy. The two halves disagreed.
    st, body = call_text("GET", "/api/oai?verb=ListRecords&metadataPrefix=oai_dc&set=theology")
    check("asking for a set is refused, not silently ignored",
          'code="noSetHierarchy"' in body, body[:160])

    # A malformed datestamp ran as a nonsense string comparison instead of erroring.
    st, body = call_text("GET", "/api/oai?verb=ListRecords&metadataPrefix=oai_dc&from=March%203%202027")
    check("a malformed datestamp is a badArgument", 'code="badArgument"' in body, body[:160])
    st, body = call_text("GET", f"/api/oai?verb=ListRecords&metadataPrefix=oai_dc&from={_today}&until=2020-01-01")
    check("and until before from is a badArgument", 'code="badArgument"' in body, body[:160])
    st, body = call_text("GET", f"/api/oai?verb=ListRecords&metadataPrefix=oai_dc&from={_today}&until={_today}T00:00:00Z")
    check("and mixed granularity is a badArgument", 'code="badArgument"' in body, body[:160])

    # `const echoable = code === 'badVerb' || code === 'badArgument' ? '' : ''` — both
    # arms empty, so NO error response echoed its request. The spec wants the request
    # attributes on every code EXCEPT those two.
    st, body = call_text("GET", "/api/oai?verb=GetRecord&metadataPrefix=nonsense&identifier=oai:x:y")
    check("an error echoes the request it failed",
          'code="cannotDisseminateFormat"' in body and 'verb="GetRecord"' in body, body[:200])
    st, body = call_text("GET", "/api/oai?verb=ListRecords&metadataPrefix=oai_dc&from=nonsense")
    check("but badArgument carries no attributes, as the spec requires",
          'code="badArgument"' in body and "<request>" in body, body[:200])
finally:
    call("PUT", "/api/library-settings", {"publicSharing": _prior_sharing or "off"})

print("=== 63. REGRESSION: an expired hold advances every queue, and the promotion pins a copy ===")
uniq = uuid.uuid4().hex[:6]

# Expiry is only evaluated on READ — there is no scheduled handler — so two titles
# whose pickup windows lapse together is the normal state after a weekend. Two
# defects turned that into readers stranded rather than delayed:
#
#   * the promotion subquery ended in a bare LIMIT 1 across every affected title,
#     so exactly ONE queue advanced per sweep; and because the outer match is
#     `closed_at = <this sweep's now>`, no later sweep could ever repair the rest.
#   * the promotion set only `status`, leaving item_id and expires_at NULL. Such a
#     hold pins no copy, is invisible to fillNextHold (which looks for 'waiting'),
#     and can never lapse — so a walk-in could borrow the copy, the next return
#     would skip that reader for the person behind them, and the unique index
#     would refuse them a fresh hold. Promoted for good, served never.
if LOCAL:
    def _mkbook63(title):
        st, r = call("POST", "/api/books", {"title": title, "author": "ZZ"})
        return (r or {}).get("id")

    def _mkreader63(name):
        st, r = call("POST", "/api/borrowers", {"name": name})
        return (r or {}).get("borrower", r or {}).get("id")

    _b1, _b2 = _mkbook63("ZZHOLD1 " + uniq), _mkbook63("ZZHOLD2 " + uniq)
    _rr = [_mkreader63("ZZHOLD r%d %s" % (i, uniq)) for i in range(4)]
    if _b1 and _b2 and all(_rr):
        CREATED.extend([_b1, _b2])
        # Each title: one reader takes the free copy (goes 'ready'), one queues behind.
        for _b, _head, _next in ((_b1, _rr[0], _rr[1]), (_b2, _rr[2], _rr[3])):
            call("POST", "/api/books/%s/holds" % _b, {"borrowerId": _head})
            call("POST", "/api/books/%s/holds" % _b, {"borrowerId": _next})
        # Force both pickup windows to have lapsed.
        local_sql(
            "UPDATE holds SET expires_at = '2020-01-01T00:00:00.000Z' "
            "WHERE book_id IN ('%s', '%s') AND status = 'ready'" % (_b1, _b2))
        # ONE read of the hold shelf must repair BOTH queues.
        call("GET", "/api/holds")
        rows = local_sql(
            "SELECT book_id, status, (item_id IS NOT NULL) AS pins, "
            "(expires_at IS NOT NULL) AS clock FROM holds "
            "WHERE book_id IN ('%s', '%s')" % (_b1, _b2)) or []
        ready = [r for r in rows if r["status"] == "ready"]
        check("one sweep advances the queue of EVERY title whose hold lapsed",
              len(set(r["book_id"] for r in ready)) == 2, rows)
        check("and each promoted hold actually pins a copy",
              bool(ready) and all(int(r["pins"]) == 1 for r in ready), ready)
        check("and carries a pickup deadline, so it can lapse in its turn",
              bool(ready) and all(int(r["clock"]) == 1 for r in ready), ready)
        # The invariant behind all of it, stated over the whole table.
        bad = local_sql("SELECT COUNT(*) AS n FROM holds WHERE status = 'ready' "
                        "AND (item_id IS NULL OR expires_at IS NULL)")
        check("no ready hold anywhere lacks a copy or a deadline",
              bool(bad) and int(bad[0]["n"]) == 0,
              bad[0]["n"] if bad else "query failed")
        _nowz = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        # Close this section's own holds. The two probe books are purged with
        # CREATED, but a hold outlives a soft-delete, and the invariant above is
        # global — so residue from THIS section would fail the NEXT run and read as
        # a live defect. (Which is how it was found: a run against deliberately
        # reverted code left exactly such a row behind.)
        local_sql("UPDATE holds SET status = 'cancelled', closed_at = '%s', updated_at = '%s' "
                  "WHERE book_id IN ('%s', '%s') AND status IN ('waiting', 'ready')"
                  % (_nowz, _nowz, _b1, _b2))

print("=== 62. REGRESSION: D1's 100-parameter ceiling ===")
uniq = uuid.uuid4().hex[:8]

# D1 accepts at most 100 BOUND PARAMETERS per statement. Four places built one
# placeholder per caller-supplied element with no chunking, against schemas that
# permit far more, so each 500'd the moment a real workload crossed the line:
#
#   /api/books/merge-candidates  flattened every id of every group into one IN(...)
#                                — 500 from limit=5 upward, i.e. every call the
#                                merge screen makes. Only ?limit=1 ever worked.
#   /api/books/duplicates        two binds per group, limit clamped to 200 — worked
#                                only at the default 50, which binds exactly 100.
#   /api/items/add-copies        schema permits 500 ids, client sends 200.
#   /api/items/assign-barcodes   same, plus loadItemsForBooks underneath.
#
# The gate did not catch any of it: all three merge-candidate assertions used
# ?limit=1 or a `q` narrow enough to return one group. These probe the sizes a
# librarian actually produces.
for _limit in (1, 5, 50, 100):
    st, body = call("GET", f"/api/books/merge-candidates?limit={_limit}")
    check(f"merge-candidates answers at limit={_limit}", st == 200, f"{st} {str(body)[:90]}")
for _limit in (1, 50, 99, 200):
    st, body = call("GET", f"/api/books/duplicates?limit={_limit}")
    check(f"duplicates answers at limit={_limit}", st == 200, f"{st} {str(body)[:90]}")

# The bulk actions, at a selection larger than the ceiling. 200 is what the web
# client sends per batch.
_ids = []
for _page in (1, 2):
    st, pg = call("GET", f"/api/books?pageSize=100&page={_page}")
    _ids += [b["id"] for b in (pg or {}).get("items", [])]
check("two pages of ids were fetched for the bulk probes", len(_ids) > 150, len(_ids))
if len(_ids) > 150:
    # limit=1 so the sweep labels a single copy: this asserts the QUERY survives the
    # id list, not that a bulk write is a good idea inside the gate.
    st, body = call("POST", "/api/items/assign-barcodes", {"bookIds": _ids, "limit": 1})
    check("assign-barcodes accepts a selection past the parameter ceiling",
          st == 200, f"{st} {str(body)[:110]}")
    # add-copies WRITES, so it is exercised against a scratch selection of two.
    st, mk1 = call("POST", "/api/books", {"title": f"ZZCEIL A {uniq}", "author": "ZZ"})
    st, mk2 = call("POST", "/api/books", {"title": f"ZZCEIL B {uniq}", "author": "ZZ"})
    _two = [x for x in [(mk1 or {}).get("id"), (mk2 or {}).get("id")] if x]
    CREATED.extend(_two)
    if len(_two) == 2:
        st, body = call("POST", "/api/items/add-copies", {"bookIds": _two, "count": 1})
        check("add-copies still works on a small selection", st == 200, f"{st} {str(body)[:90]}")

# The shared loader underneath all of them.
_db_src2 = _slurp(_REPO, "apps", "api-worker", "src", "db.ts")
check("loadItemsForBooks chunks its id list",
      "i += 90" in _db_src2.split("export async function loadItemsForBooks")[1][:900], None)

print("=== 61. REGRESSION: validated input must be written, defaults must not overwrite ===")
uniq = uuid.uuid4().hex[:8]

# (a) /api/import/books accepted seven CreateBookSchema fields, normalised them,
# counted the row as imported and wrote none of them: the INSERT and UPDATE column
# lists simply omitted date_edtf, publication_year_end, ddc, bib_level and the three
# romanized forms. A sheet carrying an EDTF date or a serial marking lost it in
# silence, and the import reported success.
_legacy = f"ZZIMP-{uniq}"
st, res = call("POST", "/api/import/books", {"dryRun": False, "rows": [{
    "legacyId": _legacy, "title": f"ZZIMPORT {uniq}", "author": "ZZ",
    "dateEdtf": "1955/1957", "ddc": "270.1", "bibLevel": "serial",
    "titleRomanized": "Zz Import", "authorRomanized": "Zz Author",
    "publisherRomanized": "Zz Pub"}]})
check("an import row is accepted", st in (200, 201) and (res or {}).get("importedRows") == 1, f"{st} {res}")
if LOCAL:
    _r = local_sql(f"""SELECT date_edtf, publication_year_end, ddc, bib_level,
                              title_romanized, author_romanized, publisher_romanized,
                              title_romanized_fold, id
                         FROM books WHERE legacy_id = '{_legacy}'""")
    row = _r[0] if _r else None
    if row:
        CREATED.append(row["id"])
    check("the import writes the EDTF date it validated",
          row and row["date_edtf"] == "1955/1957", row)
    check("and derives the end year from it",
          row and int(row["publication_year_end"] or 0) == 1957, row)
    check("and writes the Dewey number and the serial marking",
          row and row["ddc"] == "270.1" and row["bib_level"] == "serial", row)
    check("and the three romanized forms, folded so they are searchable",
          row and row["title_romanized"] == "Zz Import"
          and row["author_romanized"] == "Zz Author"
          and row["publisher_romanized"] == "Zz Pub"
          and (row["title_romanized_fold"] or "") != "", row)

# (b) ItemCoreSchema defaults itemType to 'book'. ReplaceItemsSchema drives the
# UPDATE of an EXISTING copy too, so an edit that did not resend the type silently
# reclassified a manuscript as a book — the `.partial()`/`.default()` trap three
# sibling schemas avoid by hand.
st, mk = call("POST", "/api/books", {"title": f"ZZTYPE {uniq}", "author": "ZZ"})
_bid = (mk or {}).get("id")
if _bid:
    CREATED.append(_bid)
    st, got = call("GET", f"/api/books/{_bid}/items")
    items = (got or {}).get("items", [])
    if items:
        _iid = items[0]["id"]
        st, _ = call("PUT", f"/api/books/{_bid}/items",
                     {"items": [{"id": _iid, "itemType": "manuscript", "shelfCode": "01-001"}]})
        check("a copy can be classified as something other than a book", st == 200, st)
        # The edit that matters: same copy, no itemType in the payload.
        st, _ = call("PUT", f"/api/books/{_bid}/items",
                     {"items": [{"id": _iid, "shelfCode": "01-002"}]})
        st, after = call("GET", f"/api/books/{_bid}/items")
        kept = ((after or {}).get("items") or [{}])[0].get("itemType")
        check("and an edit that does not mention the type leaves it alone",
              kept == "manuscript", f"itemType became {kept!r}")

# (c) Two CSV export paths existed and only the server one neutralised formula
# injection. They now share one cell escaper, so a title beginning '=' cannot
# execute when the librarian opens either export.
_shared = _slurp(_REPO, "packages", "shared", "src", "index.ts")
check("the CSV cell escaper is shared, not duplicated",
      "export function csvCell" in _shared
      and "csvCell" in _slurp(_REPO, "apps", "api-worker", "src", "utils.ts")
      and "csvCell" in main_tsx, None)
check("and it neutralises the formula characters",
      "/^[=+\\-@\\t\\r]/" in _shared, None)
check("neither export path hand-rolls its own escaper any more",
      "text.includes(',') || text.includes('\"')" not in main_tsx, None)

# (d) The GDPR erase rewrote the reader's name across the WHOLE audit table by
# substring. 9,927 book.create entries carry {"title","author"}, and in a Greek
# library a reader and an author routinely share a surname — so erasing one reader
# quietly rewrote the catalogue's own history of unrelated books.
_worker_src = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
_erase = _worker_src[_worker_src.index("app.post('/api/borrowers/:id/erase'"):]
_erase = _erase[:_erase.index("return c.json({ id, anonymizedName")]
# Strip the comments before matching. The first version of this check searched the
# raw text for "REPLACE(metadata" and matched the comment that EXPLAINS why the
# REPLACE was removed — a check that reported the defect it was written to prove
# absent. Exactly the failure mode this section exists to catch, one level up.
_erase_code = "\n".join(l for l in _erase.split("\n") if not l.strip().startswith("//"))
check("erasure targets audit metadata by key, not by substring",
      "REPLACE(metadata" not in _erase_code and "json_set(metadata" in _erase_code,
      "an unanchored REPLACE over audit_logs is still present")
# Over the code, not the raw text: the sibling assertion above exists because a
# comment satisfied it once, and this one was still reading `_erase` — so deleting
# the three UPDATEs while leaving a comment that names the actions would have passed.
# All three names live in SQL today, so nothing changes but the hole.
check("and it names the actions that actually carry a reader name",
      all(a in _erase_code for a in ("book.return", "hold.place", "borrower.create")), None)

# (e) OAI-PMH paged on a row OFFSET over an ordering whose rows move when a record
# is saved, so a harvest of a live catalogue skipped a record for every edit made
# while it ran. Same defect as /api/sync/pull, same fix: a keyset.
_proto = _slurp(_REPO, "apps", "api-worker", "src", "protocols.ts")
check("the OAI resumption token carries a keyset position",
      "lastUpdatedAt" in _proto and "lastId" in _proto, None)
_db_src = _slurp(_REPO, "apps", "api-worker", "src", "db.ts")
check("and loadOaiPage resumes strictly after the last row handed out",
      "updated_at > ? OR (updated_at = ? AND id > ?)" in _db_src, None)

print("=== 60. REGRESSION: EDTF sort sentinels are not dates ===")
uniq = uuid.uuid4().hex[:8]

# parseEdtf stores 1000 for an unknown start and 3000 for an unknown end so that
# "../1960" and "1960/.." sort and range-filter with real years. marc008 read them
# as authored dates, so "before 1960" was published to partner libraries as a work
# OF THE YEAR 1000, and "1960 onwards" as ceasing in 3000. MARC has codes for both
# cases; the module's own docstring says a wrong code here is worse than no code.
for _edtf, _want1, _want2, _label in (
        ("../1960", "uuuu", "1960", "unknown start, known end"),
        ("1960/..", "1960", "9999", "known start, open end")):
    st, made = call("POST", "/api/books", {"title": f"ZZEDTF {_label} {uniq}", "author": "ZZ",
                                           "dateEdtf": _edtf})
    _id = (made or {}).get("id")
    if not _id:
        check(f"a record can carry the EDTF interval {_edtf}", False, f"{st} {str(made)[:120]}")
        continue
    CREATED.append(_id)
    st, xml = call_text("GET", f"/api/books/{_id}/marc?format=marcxml")
    m = re.search(r'<controlfield tag="008">(.*?)</controlfield>', xml or "")
    f008 = m.group(1) if m else ""
    # 008/06 type, 008/07-10 date1, 008/11-14 date2
    check(f"{_edtf} exports date1 as {_want1}, not a sentinel year",
          len(f008) >= 15 and f008[7:11] == _want1, f"008={f008[:20]!r}")
    check(f"and date2 as {_want2}",
          len(f008) >= 15 and f008[11:15] == _want2, f"008={f008[:20]!r}")
    check(f"and never states the sentinel 1000/3000 as a date for {_edtf}",
          "1000" not in f008[7:15] and "3000" not in f008[7:15], f"008={f008[:20]!r}")

print("=== 59. REGRESSION: a merge carries the hold queue with it ===")
uniq = uuid.uuid4().hex[:8]

# Merge re-parented items, loans, codes and serial runs to the keeper and left the
# HOLDS behind, pointing at a record that no longer exists. Two consequences, and
# the second hid the first: a reader waiting for the merged-away title kept a place
# in a queue on a tombstone — the copies had moved, so returns were processed
# against the keeper and the hold could never be filled — and the orphan row still
# referenced `item_id`, so the keeper could never be purged either. The purge fix
# committed one commit earlier deletes holds BY BOOK, which cannot see this row.
def _mkbook(t):
    st, r = call("POST", "/api/books", {"title": t, "author": "ZZ"})
    return (r or {}).get("id")

a_id, b_id = _mkbook(f"ZZMH A {uniq}"), _mkbook(f"ZZMH B {uniq}")
st, r1 = call("POST", "/api/borrowers", {"name": f"ZZMH both {uniq}"})
st, r2 = call("POST", "/api/borrowers", {"name": f"ZZMH onlyB {uniq}"})
r1id = (r1 or {}).get("borrower", r1 or {}).get("id")
r2id = (r2 or {}).get("borrower", r2 or {}).get("id")

if a_id and b_id and r1id and r2id:
    CREATED.append(a_id)
    # r1 queues on BOTH records — the case that collides with
    # idx_holds_one_per_borrower if the merge moves rows without thinking.
    call("POST", f"/api/books/{a_id}/holds", {"borrowerId": r1id})
    call("POST", f"/api/books/{b_id}/holds", {"borrowerId": r1id})
    call("POST", f"/api/books/{b_id}/holds", {"borrowerId": r2id})
    st, body = call("POST", "/api/books/merge", {"keepId": a_id, "mergeIds": [b_id], "dryRun": False})
    check("a merge survives a reader queued on both records", st == 200, f"{st} {str(body)[:130]}")

    if LOCAL:
        rows = local_sql(f"""SELECT status, (book_id = '{a_id}') AS on_keeper,
                                    (borrower_id = '{r1id}') AS is_dup_reader
                               FROM holds
                              WHERE borrower_id IN ('{r1id}', '{r2id}')""") or []
        check("no hold is left pointing at the record that was merged away",
              rows and all(int(r["on_keeper"]) == 1 for r in rows),
              [r for r in rows if int(r["on_keeper"]) != 1])
        # ON THE KEEPER, not merely alive: before the fix this reader's hold survived
        # perfectly well — on a record that no longer existed — so a check that only
        # counted live holds passed while the reader waited forever.
        live_other = [r for r in rows if int(r["is_dup_reader"]) == 0
                      and r["status"] in ("waiting", "ready") and int(r["on_keeper"]) == 1]
        check("a reader who was only in the merged-away queue keeps their place",
              len(live_other) == 1, rows)
        live_dup = [r for r in rows if int(r["is_dup_reader"]) == 1
                    and r["status"] in ("waiting", "ready") and int(r["on_keeper"]) == 1]
        check("and a reader queued on both ends up with exactly one live hold",
              len(live_dup) == 1, rows)

    # The purge that used to be impossible. Delete-by-book could not see the orphan;
    # the keeper is the record that inherited the copies it pointed at.
    call("DELETE", f"/api/books/{a_id}")
    st, body = call("DELETE", f"/api/books/{a_id}/purge")
    check("and the keeper can still be purged afterwards", st == 204, f"{st} {str(body)[:130]}")

print("=== 58. REGRESSION: a hold must not make a record or a reader undeletable ===")
# STRUCTURAL, not behavioural: every table that points at books(id) or items(id)
# WITHOUT a declared cascade must be named in the purge handler, or purging trips a
# foreign key and the record is stuck in the trash for good. Two tables have now
# been missed this way — `book_authorities` and `holds` — so the next one should be
# caught by the build rather than by a librarian pressing a button that only fails.
if LOCAL:
    _tables = local_sql("SELECT name, sql FROM sqlite_master WHERE type='table'") or []
    _wsrc = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
    _purge_src = _wsrc[_wsrc.index("app.delete('/api/books/:id/purge'"):]
    _purge_src = _purge_src[:_purge_src.index("bumpBooksCacheVersion")]
    _missing = []
    for _t in _tables:
        _sql = (_t.get("sql") or "")
        for _m in re.finditer(r'REFERENCES\s+(books|items)\s*\(\s*id\s*\)([^,\n)]*)', _sql, re.I):
            _parent, _tail = _m.group(1), _m.group(2)
            if re.search(r'ON\s+DELETE\s+(CASCADE|SET\s+NULL)', _tail, re.I):
                continue
            _child = _t["name"]
            if _child == "books":
                continue  # books.merged_into is handled by an UPDATE, not a DELETE
            # Whitespace-insensitive: the SQL is formatted across lines, and a check
            # that only matches one layout reports a false positive the moment the
            # statement is reformatted — which it was, one commit after this landed.
            if f"DELETE FROM {_child} WHERE" not in re.sub(r"\s+", " ", _purge_src):
                _missing.append(f"{_child} -> {_parent} (ON DELETE NO ACTION)")
    check("the purge cascade names every table that blocks a hard delete",
          not _missing, sorted(set(_missing)))


uniq = uuid.uuid4().hex[:8]

# `holds.book_id` is NOT NULL REFERENCES books(id) with no cascade, and
# `holds.item_id` references items(id) (migration 0029). The purge batch named eight
# child tables and not `holds`, so a record that had EVER been held — including
# holds long since fulfilled or cancelled — tripped the foreign key twice over.
# Purge answered 500 for good: the record could not leave the trash by any route,
# while the Trash screen kept offering a button that could only fail.
st, mk = call("POST", "/api/books", {"title": f"ZZHOLDFK {uniq}", "author": "ZZ"})
bid = (mk or {}).get("id")
st, br = call("POST", "/api/borrowers", {"name": f"ZZHOLDFK reader {uniq}"})
brid = (br or {}).get("borrower", br or {}).get("id")
if bid and brid:
    st, _ = call("POST", f"/api/books/{bid}/holds", {"borrowerId": brid})
    check("a hold can be placed on the probe record", st in (200, 201), st)
    # Cancel it, so what remains is only hold HISTORY — the case that used to 500.
    rows = local_sql(f"SELECT id FROM holds WHERE book_id = '{bid}'") if LOCAL else None
    if rows:
        call("DELETE", f"/api/holds/{rows[0]['id']}")
    st, _ = call("DELETE", f"/api/books/{bid}")
    st, body = call("DELETE", f"/api/books/{bid}/purge")
    check("a record that was once held can still be purged", st == 204, f"{st} {str(body)[:120]}")
    # NOT via GET: a soft-deleted record 404s too, so a purge that failed and left
    # the book sitting in the trash satisfied that form of the check. Ask the table.
    _left = local_sql(f"SELECT COUNT(*) AS n FROM books WHERE id = '{bid}'") if LOCAL else None
    if LOCAL:
        check("and the row is really gone, not just hidden",
              _left and int(_left[0]["n"]) == 0, _left[0]["n"] if _left else "query failed")
    else:
        st, _ = call("GET", f"/api/books/{bid}")
        check("and the row is really gone, not just hidden", st == 404, st)

    # The same foreign key from the other side. The route already refused a borrower
    # with loan history via a helpful 409; a borrower with hold history got an opaque
    # 500 instead of either outcome.
    st, mk2 = call("POST", "/api/books", {"title": f"ZZHOLDFK2 {uniq}", "author": "ZZ"})
    bid2 = (mk2 or {}).get("id")
    st, br2 = call("POST", "/api/borrowers", {"name": f"ZZHOLDFK reader2 {uniq}"})
    brid2 = (br2 or {}).get("borrower", br2 or {}).get("id")
    if bid2 and brid2:
        CREATED.append(bid2)
        call("POST", f"/api/books/{bid2}/holds", {"borrowerId": brid2})
        st, body = call("DELETE", f"/api/borrowers/{brid2}")
        check("deleting a reader with a LIVE hold is refused, and says why",
              st == 409 and "hold" in str(body).lower(), f"{st} {str(body)[:140]}")
        rows2 = local_sql(f"SELECT id FROM holds WHERE borrower_id = '{brid2}'") if LOCAL else None
        if rows2:
            call("DELETE", f"/api/holds/{rows2[0]['id']}")
        st, body = call("DELETE", f"/api/borrowers/{brid2}")
        check("and once it is cancelled the reader can be deleted",
              st == 204, f"{st} {str(body)[:120]}")
        if LOCAL:
            left = local_sql(f"SELECT COUNT(*) AS n FROM holds WHERE borrower_id = '{brid2}'")
            check("leaving no hold row pointing at a reader who no longer exists",
                  left and int(left[0]["n"]) == 0, left[0]["n"] if left else "query failed")

# The general form, over the whole table: no hold may reference a book, item or
# borrower that is gone. This is what both bugs above would have produced had the
# foreign keys not been enforced.
if LOCAL:
    dangling = local_sql("""SELECT
          (SELECT COUNT(*) FROM holds h WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.id = h.book_id)) AS no_book,
          (SELECT COUNT(*) FROM holds h WHERE h.item_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = h.item_id)) AS no_item,
          (SELECT COUNT(*) FROM holds h WHERE h.borrower_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM borrowers b WHERE b.id = h.borrower_id)) AS no_borrower""")
    check("no hold points at a book, copy or reader that is gone",
          dangling and all(int(dangling[0][k]) == 0 for k in ("no_book", "no_item", "no_borrower")),
          dangling[0] if dangling else "query failed")

print("=== 57. REGRESSION: refusals must not half-apply, and cursors must not skip ===")
uniq = uuid.uuid4().hex[:8]

# (a) A borrow refused by the loan cap used to return 201 and mark the copy
# 'borrowed' with NO ledger row behind it. The copy was then unlendable (status
# says borrowed) AND unreturnable (no open loan to close), in no loan report, with
# nothing in the interface able to repair it. Cause: the INSERT carried the cap in
# its guard, the copy UPDATE did not, and the handler read the UPDATE's row count
# to decide whether a loan had happened.
_pol = local_sql("SELECT id, max_concurrent_loans FROM loan_policies WHERE id = 'pol_*_*'") if LOCAL else None
if LOCAL and _pol:
    _restore = _pol[0]["max_concurrent_loans"]
    local_sql("UPDATE loan_policies SET max_concurrent_loans = 1 WHERE id = 'pol_*_*'")
    try:
        st, br = call("POST", "/api/borrowers", {"name": f"ZZCAP {uniq}", "category": "standard"})
        brid = (br or {}).get("borrower", br or {}).get("id")
        st, lst = call("GET", "/api/books?pageSize=8&status=available")
        two = [b["id"] for b in (lst or {}).get("items", [])][:2]
        if brid and len(two) == 2:
            st1, _ = call("POST", f"/api/books/{two[0]}/borrow", {"borrowerId": brid})
            st2, body2 = call("POST", f"/api/books/{two[1]}/borrow", {"borrowerId": brid})
            check("a borrow over the loan cap is refused, not half-applied",
                  st1 in (200, 201) and st2 == 409, f"first={st1}, over-cap={st2} {str(body2)[:120]}")
            rows = local_sql(f"""SELECT i.status AS s,
                     (SELECT COUNT(*) FROM borrow_transactions t
                       WHERE t.item_id = i.id AND t.returned_at IS NULL) AS open_loans
                     FROM items i WHERE i.book_id = '{two[1]}'""")
            stuck = [r for r in (rows or []) if r["s"] == "borrowed" and int(r["open_loans"]) == 0]
            check("and it leaves no copy marked borrowed with no loan behind it",
                  not stuck, stuck[:3])
            # Clean up the loan the first call legitimately created.
            call("POST", f"/api/books/{two[0]}/return", {})
        else:
            check("a borrow over the loan cap is refused, not half-applied", False, "setup failed")
    finally:
        local_sql("UPDATE loan_policies SET max_concurrent_loans = "
                  + ("NULL" if _restore is None else str(int(_restore)))
                  + " WHERE id = 'pol_*_*'")

# The invariant stated globally: this is what the bug above violated, and it is
# cheap enough to assert over the whole table on every run.
if LOCAL:
    orphans = local_sql("""SELECT COUNT(*) AS n FROM items i
        WHERE i.deleted_at IS NULL AND i.status = 'borrowed'
          AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
                           WHERE t.item_id = i.id AND t.returned_at IS NULL)""")
    check("no copy anywhere is 'borrowed' without an open loan",
          orphans and int(orphans[0]["n"]) == 0, orphans[0]["n"] if orphans else "query failed")

# (b) /api/sync/pull paged on `updated_at > last_seen`. That column is not unique
# here — the import wrote thousands of records inside one millisecond — so the
# cursor stepped over every record sharing the last row's timestamp. Measured: a
# full sync delivered 12,225 of 12,555 records and reported success.
_seen, _cur, _cid, _pages = set(), "1970-01-01T00:00:00.000Z", "", 0
while _pages < 60:
    st, page = call("GET", f"/api/sync/pull?since={_cur}&sinceId={_cid}")
    if st != 200:
        break
    items = (page or {}).get("items", [])
    _pages += 1
    if not items:
        break
    for b in items:
        _seen.add(b["id"])
    nc, nci = page.get("nextCursor"), page.get("nextCursorId", "")
    if nc == _cur and nci == _cid:
        break
    _cur, _cid = nc, nci
_total = None
if LOCAL:
    r = local_sql("SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL")
    _total = int(r[0]["n"]) if r else None
check("a full offline sync delivers every record",
      _total is not None and len(_seen) == _total, f"{len(_seen)} of {_total} in {_pages} pages")
check("and the sync cursor is a total order, not a bare timestamp",
      "nextCursorId" in (page or {}), sorted((page or {}).keys()))

# (c) Committing a merge removes records, so it needs books.delete — which is FALSE
# for librarians by default. The route is gated on books.write alone, so without the
# re-check a librarian refused DELETE, the trash and restore could still clear the
# catalogue by merging unrelated records, and could not undo it.
lu = f"zzmerge{uniq[:6]}"
st, _ = call("POST", "/api/users", {"username": lu, "password": "ZZmerge!2026", "role": "librarian"})
if st in (200, 201):
    USERS.append(lu)
    ltok = login(lu, "ZZmerge!2026")
    st, perms = call("GET", "/api/me/permissions", token=ltok)
    can_delete = (perms or {}).get("permissions", perms or {}).get("books.delete")
    check("books.delete is denied to a librarian by default", can_delete is False, perms)
    a = call("POST", "/api/books", {"title": f"ZZMERGE A {uniq}", "author": "ZZ"})[1]
    b = call("POST", "/api/books", {"title": f"ZZMERGE B {uniq}", "author": "ZZ"})[1]
    aid, bid = (a or {}).get("id"), (b or {}).get("id")
    if aid and bid:
        CREATED.extend([aid, bid])
        st, _ = call("POST", "/api/books/merge",
                     {"keepId": aid, "mergeIds": [bid], "dryRun": True}, token=ltok)
        check("a librarian may still PREVIEW a merge", st == 200, st)
        st, body = call("POST", "/api/books/merge",
                        {"keepId": aid, "mergeIds": [bid], "dryRun": False}, token=ltok)
        check("but committing one without books.delete is refused", st == 403, f"{st} {str(body)[:110]}")
        st, _ = call("GET", f"/api/books/{bid}")
        check("and the record it would have removed is still there", st == 200, st)

# (d) /api/scan/:value names the current reader. Four sibling routes require
# `circulation` for that same fact, and this one required nothing — so a viewer
# refused all four could walk /api/books/ids and rebuild the loan roster.
vu = f"zzscan{uniq[:6]}"
st, _ = call("POST", "/api/users", {"username": vu, "password": "ZZscan!2026", "role": "viewer"})
if st in (200, 201):
    USERS.append(vu)
    vtok = login(vu, "ZZscan!2026")
    st, made = call("POST", "/api/books", {"title": f"ZZSCAN {uniq}", "author": "ZZ"})
    sid = (made or {}).get("id")
    if sid:
        CREATED.append(sid)
        call("POST", f"/api/books/{sid}/borrow", {"borrowerName": f"ZZREADER {uniq}"})
        st, scan = call("GET", f"/api/scan/{sid}", token=vtok)
        check("a viewer can still identify a scanned book", st == 200 and (scan or {}).get("book"), st)
        check("but the scan does not name the reader to them",
              (scan or {}).get("openLoan") is None, (scan or {}).get("openLoan"))
        st, scan2 = call("GET", f"/api/scan/{sid}")
        check("while the desk still sees who has it",
              ((scan2 or {}).get("openLoan") or {}).get("borrower_name", "").startswith("ZZREADER"),
              (scan2 or {}).get("openLoan"))
        call("POST", f"/api/books/{sid}/return", {})

print("=== 56. REGRESSION: the course records that it was read ===")
uniq = uuid.uuid4().hex[:8]
_ob = _slurp(_REPO, "apps", "web", "src", "onboarding.tsx")

# The course used to carry its own 56 KB of prose, written before the standards
# work. It taught re-cataloguing a duplicate as a NEW RECORD — the habit the merge
# tool exists to clean up — so a librarian who read it carefully was worse off than
# one who had not. It is now a curated sequence of Handbook chapters: one corpus,
# one renderer, and a correction to the Handbook is a correction to the course.
check("the course has no prose of its own",
      "kind: 'p'" not in _ob and "COURSE_CHAPTERS" in _ob, None)
course_ids = re.findall(r"^  '([a-z0-9-]+)'", _ob.split("COURSE_CHAPTERS")[1].split(" = [")[1].split("];")[0], re.M)
declared = set(re.findall(r"^  '([a-z0-9-]+)',?$", hb_reg, re.M))
check("every course chapter is a real Handbook chapter",
      course_ids and set(course_ids) <= declared, [c for c in course_ids if c not in declared])
check("and the course is a subset, not the whole Handbook",
      0 < len(course_ids) < len(declared), f"{len(course_ids)} of {len(declared)}")

# Finishing used to be `mandatory ? onFinish() : (onClose ?? onFinish)()`. A replay
# always passes onClose, so pressing Finish on a replay closed the dialog and
# recorded NOTHING — the librarian had read it to the end and the system did not
# know, and a version bump could never be acknowledged voluntarily.
_fin = _ob.split("function finish()")[1].split("}")[0] if "function finish()" in _ob else ""
check("finishing always records completion, replay included",
      "onFinish();" in _fin and "??" not in _fin, _fin.strip() or "no finish()")

# The replay lived in Settings, which needs the `settings` permission — so the one
# person the course is FOR could not re-read it.
#
# The old form was `'profile.replayCourse' in main_tsx and "settings.training.start"
# not in main_tsx`. That second string appears NOWHERE in this repository — grep it
# — so half the conjunction had no possible subject and the assertion reduced to
# "the button's label exists". Assert the ancestry instead: everything between the
# profile dialog that holds the button and the button itself must mention no
# permission at all, which is what "behind nothing" means.
_replay_ancestry = main_tsx.split("PROFILE MODAL", 1)[-1].split("'profile.replayCourse'", 1)[0]
_replay_guards = sorted(set(re.findall(r"\bcan[A-Z]\w*|\bperms\.\w+|\bpermissions\.\w+|\bhasPerm\w*",
                                      _replay_ancestry)))
check("the replay is not behind a permission guard",
      "'profile.replayCourse'" in main_tsx and "PROFILE MODAL" in main_tsx and not _replay_guards,
      _replay_guards or "the profile modal or its replay button is gone")

# The Handbook prose is a lazy chunk, and the mandatory course is the one screen a
# librarian cannot get past. Without a fallback it would show an empty panel.
check("the course shows something while the prose chunk loads",
      "Suspense" in _ob and "common.loading" in _ob, None)

# The version gate: bumping it is what makes an existing librarian see the new
# course. If the bump were forgotten, everyone who acknowledged the old one would
# never be shown the replacement.
worker = _slurp(_REPO, "apps", "api-worker", "src", "index.ts")
ver = re.search(r"const ONBOARDING_VERSION = (\d+);", worker)
check("the onboarding version was bumped past 1", ver and int(ver.group(1)) >= 2,
      ver.group(1) if ver else None)

# End to end: a fresh librarian is gated, and completing clears the gate.
lu = f"zzlib{uniq[:6]}"
st, made = call("POST", "/api/users", {"username": lu, "password": "ZZlibrarian!2026", "role": "librarian"})
if st in (200, 201):
    USERS.append(lu)
    tok = login(lu, "ZZlibrarian!2026")
    st, me = call("GET", "/api/auth/session", token=tok)
    check("a new librarian is asked to read the course",
          (me or {}).get("user", me).get("needsOnboarding") is True, me)
    st, _ = call("POST", "/api/me/onboarding-complete", None, token=tok)
    st, me2 = call("GET", "/api/auth/session", token=tok)
    check("and finishing it clears the gate",
          (me2 or {}).get("user", me2).get("needsOnboarding") is False, me2)
else:
    check("a new librarian is asked to read the course", False, f"could not create: {st} {made}")

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
    #
    # WALKED, not hand-listed. The list used to be exactly ("main.tsx", "ui.tsx",
    # "api.ts", "types.ts"), so the eight screens under screens/, onboarding.tsx
    # and the handbook were invisible to it — 2,500-odd lines of UI, five of the
    # eleven Dialogs in the app, all of it imported by main.tsx. Four assertions
    # below therefore certified accessibility for files they had never read:
    # planting a hand-rolled backdrop, an aria-label on a roleless <span> and an
    # unnamed Dialog in screens/copies.tsx left every one of them PASSING.
    # scripts/check_i18n.mjs walks the tree for exactly this reason and its comment
    # names this section as having had the same blind spot. It no longer has it.
    _sources = []
    for _dir, _subdirs, _files in os.walk(_WEB):
        _sources += [os.path.join(_dir, f) for f in sorted(_files)
                     if f.endswith((".ts", ".tsx")) and not f.endswith(".d.ts")]
    _sources.sort()
    tsx = "\n".join(open(p, encoding="utf-8").read() for p in _sources)
    check("the corpus these assertions read is the whole app",
          len(_sources) >= 20 and any(os.sep + "screens" + os.sep in p for p in _sources),
          [os.path.relpath(p, _WEB) for p in _sources])

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
        # `[a-z0-9-]`, not `[a-z-]`. --surface-2 is a real token in both themes and
        # the digit put it outside the old character class, so it never reached this
        # dict — and the `if toks.get(bg)` filter below then dropped it silently.
        # "reaches 4.5:1 on every surface" was measured on two of the three surfaces
        # named in the very same line. (It holds on --surface-2 too: 4.89 light,
        # 5.30 dark. So this widens the coverage without moving the verdict.)
        return dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", m.group(1))) if m else {}

    _CONTRAST_TOKENS = ("text-light", "text-muted", "field-border", "on-accent",
                        "accent", "surface", "surface-2", "bg")
    light = _tokens(r":root")
    dark = _tokens(r'\[data-theme="dark"\]')
    for name, toks in (("light", light), ("dark", dark)):
        # An assertion, not a `continue`. Renaming a token or the dark-theme
        # selector used to make every contrast check below VANISH from the run —
        # 8 assertions quietly reduced to none, with the gate still all-green.
        check(f"{name}: the colour tokens the contrast checks read are all present",
              all(toks.get(t) for t in _CONTRAST_TOKENS),
              sorted(t for t in _CONTRAST_TOKENS if not toks.get(t)))
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
    # Comments stripped first. The count is of RENDERERS, and a comment that quotes
    # the class name — ui.tsx now carries one explaining why exactly one element may
    # have it — is documentation, not a second backdrop. Counting the raw text made
    # the check fail the moment someone wrote down the rule it enforces.
    tsx_code = re.sub(r'/\*.*?\*/', '', tsx, flags=re.S)
    tsx_code = "\n".join(l for l in tsx_code.split("\n") if not l.strip().startswith("//"))
    overlays = re.findall(r'className="modal-overlay"', tsx_code)
    check("only the Dialog primitive renders a backdrop", len(overlays) == 1, len(overlays))
    check("no overlay claims the dialog role on its backdrop",
          'className="modal-overlay" onClick' not in tsx and 'modal-overlay" role=' not in tsx,
          "an overlay still does")
    # Every Dialog in the app, each one examined, rather than two totals from one
    # file compared against each other. `main_only.count("<Dialog onClose") ==
    # main_only.count("labelledBy=")` could not see the five Dialogs in screens/,
    # missed any tag whose props were reordered or wrapped onto the next line, and
    # was satisfied by two mistakes that cancelled — one Dialog unnamed, one
    # labelledBy on something else.
    #
    # A regex cannot find the end of a JSX tag: `onClose={() => close(false)}` holds
    # both `>` and `}`, so `<Dialog[^>]*>` stops inside the arrow function. This
    # walks each tag counting brace/paren depth and stops at the first `>` outside
    # them. Tags with no attributes at all are the prose mentions of "<Dialog>" in
    # comments, and are skipped.
    def _jsx_open_tags(src, name):
        found = []
        for m in re.finditer(r"<" + name + r"\b", src):
            i, depth = m.end(), 0
            while i < len(src):
                ch = src[i]
                if ch in "{(":
                    depth += 1
                elif ch in "})":
                    depth -= 1
                elif ch == ">" and depth == 0:
                    break
                i += 1
            found.append(src[m.end():i])
        return found

    _dialogs = [d for d in _jsx_open_tags(tsx, "Dialog") if d.strip()]
    _unnamed = [" ".join(d.split())[:70] for d in _dialogs if "labelledBy" not in d]
    check("every Dialog is named", len(_dialogs) >= 11 and not _unnamed,
          f"{len(_dialogs)} dialogs found, unnamed: {_unnamed}")

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

# The library's own identity record goes back exactly as the run found it — the one
# restore, writing the ORIGINAL values. Asserted rather than assumed: this table is
# the institution's name and ISIL, it reaches every MARC 852 $a, 003 and OAI-PMH
# Identify the catalogue emits, and the gate is documented as running against
# production. A restore nobody checks is how "ZZ Test Library" became the library's
# name in the first place.
_settings_after = restore_library_settings()
if LIBRARY_SETTINGS_BEFORE:
    check("the library's own identity record is exactly as the run found it",
          _settings_after == LIBRARY_SETTINGS_BEFORE,
          {k: (LIBRARY_SETTINGS_BEFORE.get(k), (_settings_after or {}).get(k))
           for k in set(LIBRARY_SETTINGS_BEFORE) | set(_settings_after or {})
           if LIBRARY_SETTINGS_BEFORE.get(k) != (_settings_after or {}).get(k)})

# A probe that could not run answers nothing, so it must not be able to pass for an
# answer. Every local_sql failure of the whole run is reported here by name: a
# renamed table, a dropped column or an invocation from the wrong directory used to
# be indistinguishable from a clean empty result.
if LOCAL:
    check("every direct D1 probe in the run actually executed", not LOCAL_SQL_FAILURES,
          LOCAL_SQL_FAILURES[:3])

print("\n" + "=" * 62)
print(f"PASSED: {len(PASSES)}   FAILED: {len(FAILURES)}")
if FAILURES:
    print("\nFAILURES:")
    for f in FAILURES: print("  - " + f)
    sys.exit(1)
print("All integrity checks held.")
