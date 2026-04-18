// IETF Datatracker data source.
//
// Two paths, in order of preference:
//   1. Snapshot: HTTP GET of data/{documentauthor,persons}.json on the same
//      origin as the page. Refreshed weekly by .github/workflows/refresh-snapshot.yml.
//      One request per file, ~1-2 MB each, gzipped by the GitHub Pages CDN.
//   2. Live (fallback only): paginated GET against datatracker.ietf.org/api/v1/
//      when the snapshot is missing (e.g. before the workflow has ever run).
//      ~190 requests, slow. CORS is open on the live API.

const API_ROOT = "https://datatracker.ietf.org/api/v1";
const SNAPSHOT_ROOT = "data";

// ================= utilities =================

export function slugFromUri(uri) {
  if (!uri) return "";
  const parts = uri.split("/").filter(Boolean);
  return parts[parts.length - 1];
}
export function idFromUri(uri) {
  const s = slugFromUri(uri);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export function classifyDocSlug(slug) {
  if (!slug) return null;
  if (slug.startsWith("rfc")) return "rfc";
  if (slug.startsWith("draft-")) return "draft";
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ================= snapshot fetch =================

export class SnapshotMissing extends Error {
  constructor(message) { super(message); this.name = "SnapshotMissing"; }
}

async function loadSnapshotFile(filename, onProgress, label) {
  const url = `${SNAPSHOT_ROOT}/${filename}`;
  onProgress?.({ phase: "snapshot-start", key: label, url });
  let res;
  try {
    res = await fetch(url, { credentials: "omit" });
  } catch (e) {
    throw new SnapshotMissing(`snapshot ${filename}: ${e.message}`);
  }
  if (!res.ok) throw new SnapshotMissing(`snapshot ${filename}: HTTP ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.rows)) {
    throw new SnapshotMissing(`snapshot ${filename}: unexpected shape`);
  }
  if (body.placeholder === true || body.rows.length === 0) {
    throw new SnapshotMissing(`snapshot ${filename}: placeholder or empty`);
  }
  onProgress?.({ phase: "snapshot-done", key: label, rows: body.rows.length, generatedAt: body.generated_at });
  return { rows: body.rows, generatedAt: body.generated_at, source: "snapshot" };
}

// ================= live paginated fetch =================

async function fetchAllLive(path, { limit = 1000, filter = {}, concurrency = 4, onProgress } = {}) {
  const params = new URLSearchParams({ format: "json", limit: String(limit), offset: "0", ...filter });
  const firstUrl = `${API_ROOT}${path}?${params.toString()}`;
  const firstRes = await fetch(firstUrl, { credentials: "omit" });
  if (!firstRes.ok) throw new Error(`${firstRes.status} on ${firstUrl}`);
  const first = await firstRes.json();
  const totalCount = first.meta.total_count;
  const pageSize = first.meta.limit;
  const totalPages = Math.ceil(totalCount / pageSize);
  const rows = new Array(totalCount);

  for (let i = 0; i < first.objects.length; i++) rows[i] = first.objects[i];
  let completedPages = 1;
  onProgress?.({ path, done: completedPages, total: totalPages, rows: first.objects.length, totalRows: totalCount });

  const queue = [];
  for (let p = 1; p < totalPages; p++) queue.push(p);

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (p === undefined) return;
      const offset = p * pageSize;
      const ps = new URLSearchParams({ format: "json", limit: String(limit), offset: String(offset), ...filter });
      const url = `${API_ROOT}${path}?${ps.toString()}`;
      let attempt = 0;
      while (true) {
        try {
          const res = await fetch(url, { credentials: "omit" });
          if (res.status === 429) { await sleep(2000 * (attempt + 1)); attempt++; continue; }
          if (!res.ok) throw new Error(`${res.status} on ${url}`);
          const body = await res.json();
          for (let i = 0; i < body.objects.length; i++) rows[offset + i] = body.objects[i];
          completedPages++;
          onProgress?.({ path, done: completedPages, total: totalPages, rows: body.objects.length, totalRows: totalCount });
          break;
        } catch (err) {
          if (attempt >= 4) throw err;
          await sleep(1000 * 2 ** attempt);
          attempt++;
        }
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, totalPages) }, () => worker());
  await Promise.all(workers);
  return rows.filter(Boolean);
}

async function loadDocumentAuthorsLive(onProgress, pageSize) {
  onProgress?.({ phase: "live-start", key: "documentauthor" });
  const raw = await fetchAllLive("/doc/documentauthor/", {
    limit: pageSize ?? 1000,
    onProgress: (p) => onProgress?.({ phase: "live", key: "documentauthor", ...p }),
  });
  const compact = [];
  for (const r of raw) {
    const slug = slugFromUri(r.document);
    const type = classifyDocSlug(slug);
    if (!type) continue;
    const pid = idFromUri(r.person);
    if (pid == null) continue;
    compact.push({ p: pid, d: slug, t: type, o: r.order ?? 0 });
  }
  onProgress?.({ phase: "live-done", key: "documentauthor", rows: compact.length });
  return { rows: compact, generatedAt: Math.floor(Date.now() / 1000), source: "live" };
}

async function loadPersonsLive(onProgress, pageSize) {
  onProgress?.({ phase: "live-start", key: "persons" });
  const raw = await fetchAllLive("/person/person/", {
    limit: pageSize ?? 1000,
    onProgress: (p) => onProgress?.({ phase: "live", key: "persons", ...p }),
  });
  const compact = raw.map((r) => ({
    id: r.id,
    name: r.name || r.ascii || `person-${r.id}`,
    ascii: r.ascii || r.name || `person-${r.id}`,
  }));
  onProgress?.({ phase: "live-done", key: "persons", rows: compact.length });
  return { rows: compact, generatedAt: Math.floor(Date.now() / 1000), source: "live" };
}

// ================= public API =================

async function loadEndpoint({ snapshotFilename, label, liveFn }, opts = {}) {
  const { onProgress, pageSize } = opts;
  try {
    return await loadSnapshotFile(snapshotFilename, onProgress, label);
  } catch (err) {
    if (!(err instanceof SnapshotMissing)) throw err;
    onProgress?.({ phase: "snapshot-miss", key: label, reason: err.message });
    return await liveFn(onProgress, pageSize);
  }
}

export function loadDocumentAuthors(opts) {
  return loadEndpoint({
    snapshotFilename: "documentauthor.json",
    label: "documentauthor",
    liveFn: loadDocumentAuthorsLive,
  }, opts);
}

export function loadPersons(opts) {
  return loadEndpoint({
    snapshotFilename: "persons.json",
    label: "persons",
    liveFn: loadPersonsLive,
  }, opts);
}

export function formatSource(source, generatedAt) {
  const when = generatedAt
    ? new Date(generatedAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "unknown";
  if (source === "snapshot") return `snapshot from ${when}`;
  if (source === "live") return `live fetch at ${when}`;
  return `source=${source}`;
}
