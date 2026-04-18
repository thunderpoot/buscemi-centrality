#!/usr/bin/env python3
"""
Refresh the Datatracker snapshot used by the Buscemi Centrality Explorer.

Paginates:
  https://datatracker.ietf.org/api/v1/doc/documentauthor/
  https://datatracker.ietf.org/api/v1/person/person/

Trims each response to the fields the client actually uses, and writes two
JSON files:
  docs/data/documentauthor.json
  docs/data/persons.json

Both files have the form:
  {"generated_at": <unix_seconds>, "count": N, "rows": [...]}

Stdlib only; intended to run from a scheduled GitHub Actions workflow.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

API_ROOT = "https://datatracker.ietf.org/api/v1"
USER_AGENT = "buscemi-centrality-snapshot/1.0 (+https://github.com/; runs in GitHub Actions)"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def slug_from_uri(uri: str) -> str:
    """'/api/v1/doc/document/rfc9000/' -> 'rfc9000'."""
    return uri.rstrip("/").rsplit("/", 1)[-1] if uri else ""


def classify_doc_slug(slug: str) -> str | None:
    if not slug:
        return None
    if slug.startswith("rfc"):
        return "rfc"
    if slug.startswith("draft-"):
        return "draft"
    return None


def fetch_json(url: str, timeout: int = 60, retries: int = 5) -> dict:
    """GET url, decode JSON. Retries on 429/5xx with exponential backoff."""
    backoff = 2.0
    last_err: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429 or 500 <= e.code < 600:
                log(f"  {url} -> HTTP {e.code}, retry {attempt + 1}/{retries} after {backoff:.1f}s")
                time.sleep(backoff)
                backoff *= 1.8
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            log(f"  {url} -> {e!r}, retry {attempt + 1}/{retries} after {backoff:.1f}s")
            time.sleep(backoff)
            backoff *= 1.8
    assert last_err is not None
    raise last_err


def paginate(path: str, limit: int = 1000, pause: float = 0.0, concurrency: int = 8) -> list[dict]:
    """Fetch every tastypie object from /api/v1<path>, with up to `concurrency`
    requests in flight. Returns a single combined list, ordered by offset.

    The first request reveals total_count; subsequent pages are dispatched in
    parallel. `pause` is honoured between dispatches as a courtesy throttle."""
    first_url = f"{API_ROOT}{path}?format=json&limit={limit}&offset=0"
    first = fetch_json(first_url)
    total = int(first["meta"]["total_count"])
    log(f"{path}: total_count = {total:,} (concurrency={concurrency})")

    pages: dict[int, list[dict]] = {0: first.get("objects") or []}

    def fetch_page(p: int) -> tuple[int, list[dict]]:
        offset = p * limit
        url = f"{API_ROOT}{path}?format=json&limit={limit}&offset={offset}"
        body = fetch_json(url)
        return p, (body.get("objects") or [])

    page_count = -(-total // limit)  # ceil
    remaining = list(range(1, page_count))

    done = 1
    log_every = max(1, page_count // 20)
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures = []
        for p in remaining:
            if pause:
                time.sleep(pause)
            futures.append(ex.submit(fetch_page, p))
        for fut in futures:
            p, batch = fut.result()
            pages[p] = batch
            done += 1
            if done % log_every == 0 or done == page_count:
                log(f"  {path}: {done * limit:,}/{total:,} (page {done}/{page_count})")

    out: list[dict] = []
    for p in sorted(pages):
        out.extend(pages[p])
    return out


def compact_documentauthors(rows: Iterable[dict]) -> list[dict]:
    out: list[dict] = []
    skipped = 0
    for r in rows:
        slug = slug_from_uri(r.get("document") or "")
        t = classify_doc_slug(slug)
        if not t:
            skipped += 1
            continue
        person_uri = r.get("person") or ""
        person_id = slug_from_uri(person_uri)
        try:
            pid = int(person_id)
        except (TypeError, ValueError):
            skipped += 1
            continue
        out.append({"p": pid, "d": slug, "t": t, "o": int(r.get("order") or 0)})
    if skipped:
        log(f"  documentauthor: skipped {skipped:,} rows (non-rfc/draft or missing person)")
    return out


def compact_persons(rows: Iterable[dict]) -> list[dict]:
    out: list[dict] = []
    for r in rows:
        pid = r.get("id")
        if pid is None:
            continue
        name = r.get("name") or r.get("ascii") or f"person-{pid}"
        ascii_name = r.get("ascii") or r.get("name") or f"person-{pid}"
        out.append({"id": int(pid), "name": name, "ascii": ascii_name})
    return out


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(path)
    log(f"  wrote {path} ({path.stat().st_size / 1_000_000:.1f} MB)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("docs/data"),
                    help="output directory (default: docs/data)")
    ap.add_argument("--limit", type=int, default=1000, help="page size (max 1000)")
    ap.add_argument("--pause", type=float, default=0.0, help="sleep between dispatches (seconds)")
    ap.add_argument("--concurrency", type=int, default=8, help="parallel requests in flight")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch only a single page of each endpoint (for local testing)")
    args = ap.parse_args()

    now = int(time.time())

    # --- documentauthor
    log("fetching documentauthor…")
    if args.dry_run:
        body = fetch_json(f"{API_ROOT}/doc/documentauthor/?format=json&limit={args.limit}&offset=0")
        raw = body.get("objects") or []
    else:
        raw = paginate("/doc/documentauthor/", limit=args.limit, pause=args.pause, concurrency=args.concurrency)
    compact = compact_documentauthors(raw)
    write_json(args.out / "documentauthor.json", {
        "generated_at": now, "count": len(compact), "rows": compact,
    })
    log(f"documentauthor: {len(compact):,} rows")

    # --- persons
    log("fetching persons…")
    if args.dry_run:
        body = fetch_json(f"{API_ROOT}/person/person/?format=json&limit={args.limit}&offset=0")
        raw = body.get("objects") or []
    else:
        raw = paginate("/person/person/", limit=args.limit, pause=args.pause, concurrency=args.concurrency)
    compact = compact_persons(raw)
    write_json(args.out / "persons.json", {
        "generated_at": now, "count": len(compact), "rows": compact,
    })
    log(f"persons: {len(compact):,} rows")

    # --- heartbeat
    # Always-changing file so the workflow's commit lands every run, even if
    # both JSON files happened to be byte-identical to the previous run. That
    # keeps GitHub's 60-day inactivity timer for scheduled workflows from
    # ever firing.
    heartbeat = args.out / ".last-run"
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    heartbeat.parent.mkdir(parents=True, exist_ok=True)
    heartbeat.write_text(
        f"{iso}\n"
        f"# Buscemi Centrality snapshot heartbeat. Updated by\n"
        f"# scripts/refresh-snapshot.py on every run, including zero-diff\n"
        f"# runs, so the workflow's commit always pushes and resets GitHub's\n"
        f"# scheduled-workflow inactivity clock. Safe to ignore.\n"
    )
    log(f"  wrote heartbeat {heartbeat} ({iso})")

    log("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
