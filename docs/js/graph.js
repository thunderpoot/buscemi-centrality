// Build the author co-authorship graph + per-person leaderboard stats from
// Datatracker rows.
//
// Input:
//   documentAuthors: [{p, d, t, o}] where p=person_id, d=doc_slug, t="rfc"|"draft", o=order
//   persons:        [{id, name, ascii}]
//
// Output: a Graph object with `persons` (with stats) and an adjacency map.

const EDGE_TYPES = ["coauthored_id", "coauthored_rfc", "repeated_coauthorship"];

// Choose the strongest applicable edge type for a pair's shared-doc counts.
function chooseEdgeType(rfcShared, idShared, repeatedThreshold) {
  if (rfcShared + idShared >= repeatedThreshold) return "repeated_coauthorship";
  if (rfcShared > 0) return "coauthored_rfc";
  return "coauthored_id";
}

function edgeKey(a, b) {
  return a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
}

export function buildGraph(documentAuthors, persons, { repeatedThreshold = 3 } = {}) {
  // --- 1. Index persons by id, seed stats.
  const personMap = new Map();
  for (const p of persons) {
    personMap.set(p.id, {
      id: p.id,
      name: p.name,
      ascii: p.ascii || p.name,
      rfcFirst: 0,
      rfcCo: 0,
      idFirst: 0,
      idCo: 0,
      totalDocs: 0,
      weighted: 0,
      hindex: 0,
      docs: 0, // total doc count for sanity
    });
  }

  // --- 2. Collate doc -> {type, authors:[{p, o}]}
  const docMap = new Map();
  for (const r of documentAuthors) {
    let entry = docMap.get(r.d);
    if (!entry) {
      entry = { type: r.t, authors: [] };
      docMap.set(r.d, entry);
    }
    entry.authors.push({ p: r.p, o: r.o });
    // If the person wasn't in persons (shouldn't happen, but be defensive):
    if (!personMap.has(r.p)) {
      personMap.set(r.p, {
        id: r.p, name: `person-${r.p}`, ascii: `person-${r.p}`,
        rfcFirst: 0, rfcCo: 0, idFirst: 0, idCo: 0,
        totalDocs: 0, weighted: 0, hindex: 0, docs: 0,
      });
    }
  }

  // --- 3. Per-person authorship counts + per-person doc list for h-index.
  const perPersonDocs = new Map(); // person_id -> array of co-author counts per doc
  for (const [slug, doc] of docMap) {
    const nAuthors = doc.authors.length;
    for (const { p, o } of doc.authors) {
      const row = personMap.get(p);
      row.docs++;
      if (doc.type === "rfc") {
        if (o === 0) row.rfcFirst++;
        else row.rfcCo++;
      } else if (doc.type === "draft") {
        if (o === 0) row.idFirst++;
        else row.idCo++;
      }
      let list = perPersonDocs.get(p);
      if (!list) { list = []; perPersonDocs.set(p, list); }
      list.push(Math.max(0, nAuthors - 1)); // # co-authors on this doc
    }
  }
  for (const p of personMap.values()) {
    p.totalDocs = p.rfcFirst + p.rfcCo + p.idFirst + p.idCo;
    p.weighted = p.rfcFirst + p.idFirst + 0.5 * (p.rfcCo + p.idCo);
    // h-index: largest h such that person has h docs with >= h co-authors.
    const counts = (perPersonDocs.get(p.id) || []).slice().sort((a, b) => b - a);
    let h = 0;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] >= i + 1) h = i + 1;
      else break;
    }
    p.hindex = h;
  }

  // --- 4. Build edges. For each doc, for each unordered pair of authors, bump counts.
  // Use a flat Map keyed by edgeKey(a,b).
  const edgeMap = new Map(); // key -> { u, v, rfcShared, idShared }
  for (const [slug, doc] of docMap) {
    const as = doc.authors;
    // Avoid exploding on pathological docs (> ~25 authors; rare, since RFC 7322 caps the front page at 5).
    if (as.length < 2) continue;
    // pair-wise
    for (let i = 0; i < as.length; i++) {
      for (let j = i + 1; j < as.length; j++) {
        const a = as[i].p, b = as[j].p;
        if (a === b) continue;
        const k = edgeKey(a, b);
        let e = edgeMap.get(k);
        if (!e) { e = { u: a < b ? a : b, v: a < b ? b : a, rfcShared: 0, idShared: 0 }; edgeMap.set(k, e); }
        if (doc.type === "rfc") e.rfcShared++;
        else e.idShared++;
      }
    }
  }

  // --- 5. Assign edge type + build symmetric adjacency map.
  // adj: Map<pid, Map<neighbourPid, {type, rfcShared, idShared}>>
  const adj = new Map();
  for (const p of personMap.keys()) adj.set(p, new Map());
  for (const e of edgeMap.values()) {
    e.type = chooseEdgeType(e.rfcShared, e.idShared, repeatedThreshold);
    adj.get(e.u).set(e.v, e);
    adj.get(e.v).set(e.u, e);
  }

  return {
    persons: personMap,      // Map<id, personStats>
    adj,                     // Map<id, Map<id, edge>>
    edges: edgeMap,          // Map<edgeKey, edge>
    docs: docMap,            // Map<slug, {type, authors}>
    repeatedThreshold,
    stats: {
      nPersons: personMap.size,
      nAuthors: [...personMap.values()].filter(p => p.docs > 0).length,
      nEdges: edgeMap.size,
      nDocs: docMap.size,
      nRfcs: [...docMap.values()].filter(d => d.type === "rfc").length,
      nDrafts: [...docMap.values()].filter(d => d.type === "draft").length,
    },
  };
}

// Recompute *just* the edge types (without rebuilding); used when the repeated-coauthorship
// threshold changes in the UI.
export function retypeEdges(graph, repeatedThreshold) {
  graph.repeatedThreshold = repeatedThreshold;
  for (const e of graph.edges.values()) {
    e.type = chooseEdgeType(e.rfcShared, e.idShared, repeatedThreshold);
  }
}

// HTML <select> values use snake_case but person stat fields are camelCase.
const METRIC_FIELD = {
  rfc_first:  "rfcFirst",
  rfc_co:     "rfcCo",
  id_first:   "idFirst",
  id_co:      "idCo",
  total_docs: "totalDocs",
  weighted:   "weighted",
  hindex:     "hindex",
  rank:       "totalDocs", // synthetic: rank by current default metric
  name:       "name",
};
export function metricField(metric) {
  return METRIC_FIELD[metric] ?? metric;
}

// Heuristic: does the Datatracker name look like a real person's name, vs. a
// data-quality artifact like "-", "\"juga\"", a bare email, an un-decoded
// MIME-encoded word, or a raw hex blob?
export function nameLooksReal(rawName) {
  if (!rawName) return false;
  const s = String(rawName).trim();
  if (s.length < 2) return false;
  // Must contain at least one Unicode letter.
  if (!/[\p{L}]/u.test(s)) return false;
  // Un-decoded RFC 2047 encoded-word: =?charset?b?base64?= or =?charset?q?qp?=
  if (/^=\?[^?]+\?[bq]\?[^?]*\?=$/i.test(s)) return false;
  // Bare email address in the name field.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return false;
  // Hex-only blob of >= 10 chars (e.g. "5265644D61736F6E" = "ReddMason").
  if (/^[0-9a-fA-F]{10,}$/.test(s)) return false;
  // Wrapped-in-quotes username, e.g. "juga".
  if (/^["'`].*["'`]$/.test(s)) return false;
  return true;
}

// Sort persons by metric (snake_case from the UI) and direction. Filters to
// authors (docs > 0) and, by default, to plausibly-real names.
export function leaderboard(graph, metric, {
  limit = 100, search = "", direction = "desc", showJunk = false,
} = {}) {
  const q = search.trim().toLowerCase();
  const field = metricField(metric);
  const rows = [];
  for (const p of graph.persons.values()) {
    if (p.docs === 0) continue;
    if (!showJunk && !nameLooksReal(p.name)) continue;
    if (q && !p.name.toLowerCase().includes(q) && !p.ascii.toLowerCase().includes(q)) continue;
    rows.push(p);
  }
  const cmp = field === "name"
    ? (a, b) => a.name.localeCompare(b.name)
    : (a, b) => (b[field] ?? 0) - (a[field] ?? 0) || a.name.localeCompare(b.name);
  rows.sort(cmp);
  if (direction === "asc") rows.reverse();
  if (limit === "all" || limit == null) return rows;
  return rows.slice(0, limit);
}
