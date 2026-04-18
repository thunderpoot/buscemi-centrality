// Entry point.
//   Auto-fetches the snapshot at page load.
//   Tabs: ARIA tablist with arrow-key navigation (Leaderboards, BC Explorer, About).
//   Leaderboards: sortable, searchable.
//   BC Explorer: source picker, live-tunable parameters, D3 force viz.

import { loadDocumentAuthors, loadPersons, formatSource } from "./datatracker.js";
import { buildGraph, leaderboard, retypeEdges, nameLooksReal, metricField } from "./graph.js";
import { buscemiCentrality } from "./centrality.js";
import { renderSubgraph } from "./viz.js";

// ========= state =========
const state = {
  graph: null,
  source: null,
  lastBC: null,
  lbSort: { col: "total_docs", dir: "desc" },
  bcSort: { col: "BC", dir: "desc" },
};

// ========= helpers =========
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Return true if the user just finished a text drag-selection. We skip
 *  row/header activation in that case so the user can actually copy from
 *  the tables. */
function suppressedByTextSelection() {
  const sel = window.getSelection?.();
  return !!(sel && sel.toString().trim().length > 0);
}

/** Wire a clickable row that still permits normal text selection.
 *  - Drag-select: suppressedByTextSelection() guards against the trailing click.
 *  - Double-click to select a word: single-click is deferred by 240ms so dblclick
 *    can cancel it. The user can then Cmd-C/Ctrl-C the selection.
 *  - Enter/Space on a focused row activates immediately (keyboard path bypasses
 *    the delay since there's no selection ambiguity). */
function bindRowClick(el, activate) {
  let timer = null;
  el.addEventListener("click", () => {
    if (suppressedByTextSelection()) return;
    if (timer) return;
    timer = setTimeout(() => { timer = null; activate(); }, 240);
  });
  el.addEventListener("dblclick", () => {
    if (timer) { clearTimeout(timer); timer = null; }
  });
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(); }
  });
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function tick() { return new Promise((r) => requestAnimationFrame(() => r())); }
function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ========= URL state =========
// Query-string layout (tab lives in the hash, as before):
//   s    source person id
//   l    lambda
//   r    neighbourhood radius
//   d    path depth cap
//   k    Pareto width
//   cr   cost coauthored_rfc         qr   quality coauthored_rfc
//   ci   cost coauthored_id          qi   quality coauthored_id
//   cp   cost repeated_coauthorship  qp   quality repeated_coauthorship
//   rt   repeated-coauthorship threshold
//   find lookup input text
//
// Only non-default values are written. Omit parameters that match their
// HTML-declared default to keep shared URLs short.
const URL_PARAM_DEFAULTS = {
  l: "0.5", r: "2", d: "3", k: "6",
  cr: "1", qr: "0.9",
  ci: "1", qi: "0.8",
  cp: "1", qp: "0.95",
  rt: "3",
};
const URL_PARAM_TO_INPUT = {
  l: "#param-lambda", r: "#param-r", d: "#param-depth", k: "#param-k",
  cr: "#cost-rfc", qr: "#q-rfc",
  ci: "#cost-id", qi: "#q-id",
  cp: "#cost-rep", qp: "#q-rep",
  rt: "#rep-threshold",
};
let _urlWriteSuspended = false;

// Normalise a person's name for use in a URL slug: lowercase, strip diacritics,
// collapse non-alphanumerics into single hyphens.
function slugifyName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Find the person whose slug matches, preferring the most-documented match
// if the slug is ambiguous.
function findPersonBySlug(slug) {
  if (!state.graph || !slug) return null;
  const target = slug.toLowerCase();
  let best = null, bestScore = -1;
  for (const p of state.graph.persons.values()) {
    if (p.docs === 0) continue;
    if (slugifyName(p.name) === target && p.totalDocs > bestScore) {
      best = p; bestScore = p.totalDocs;
    }
  }
  return best;
}

function writeURL() {
  if (_urlWriteSuspended) return;
  const p = new URLSearchParams();
  if (state.source != null) {
    const src = state.graph?.persons.get(state.source);
    const slug = src ? slugifyName(src.name) : "";
    p.set("s", slug || String(state.source));
  }
  for (const [key, sel] of Object.entries(URL_PARAM_TO_INPUT)) {
    const el = $(sel);
    if (!el) continue;
    const v = String(el.value);
    if (v !== URL_PARAM_DEFAULTS[key]) p.set(key, v);
  }
  const lookup = $("#bc-lookup")?.value?.trim() ?? "";
  if (lookup) p.set("find", lookup);
  const url = new URL(window.location.href);
  url.search = p.toString();
  history.replaceState(null, "", url);
}
const writeURLDebounced = debounce(writeURL, 120);

function readURL() {
  const p = new URLSearchParams(window.location.search);
  return {
    source: p.get("s"), // string slug, or numeric ID as string for back-compat
    params: Object.fromEntries(
      Object.keys(URL_PARAM_TO_INPUT).map((k) => [k, p.get(k)]).filter(([, v]) => v != null)
    ),
    lookup: p.get("find") || "",
  };
}

function applyURLState() {
  if (!state.graph) return;
  const urlState = readURL();
  _urlWriteSuspended = true;
  try {
    // Restore parameter inputs first so compute() uses them.
    for (const [key, val] of Object.entries(urlState.params)) {
      const sel = URL_PARAM_TO_INPUT[key];
      const el = sel && $(sel);
      if (el) {
        el.value = val;
        // keep slider <output> in sync if any
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    // Restore source. Prefer slug lookup; fall back to numeric ID for
    // backwards compatibility with older shared links.
    if (urlState.source) {
      const asNum = Number(urlState.source);
      if (Number.isFinite(asNum) && state.graph.persons.has(asNum)) {
        setSource(asNum);
      } else {
        const p = findPersonBySlug(urlState.source);
        if (p) setSource(p.id);
      }
    }
    // Restore lookup text and render.
    const lookupEl = $("#bc-lookup");
    if (lookupEl && urlState.lookup) {
      lookupEl.value = urlState.lookup;
      renderLookup();
    }
  } finally {
    _urlWriteSuspended = false;
  }
}

// ========= tabs =========
function setupTabs() {
  const tabs = $$(".tab");
  const panels = $$('[role="tabpanel"]');

  function activate(name, focusTab = false) {
    for (const t of tabs) {
      const isActive = t.dataset.tab === name;
      t.setAttribute("aria-selected", String(isActive));
      t.setAttribute("tabindex", isActive ? "0" : "-1");
      if (focusTab && isActive) t.focus();
    }
    for (const p of panels) p.hidden = p.id !== `tab-${name}`;
    const url = new URL(window.location.href);
    url.hash = name;
    history.replaceState(null, "", url);
  }

  for (const t of tabs) {
    t.addEventListener("click", () => activate(t.dataset.tab));
    t.addEventListener("keydown", (ev) => {
      const i = tabs.indexOf(t);
      let next = null;
      if (ev.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (ev.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (ev.key === "Home") next = tabs[0];
      else if (ev.key === "End")  next = tabs[tabs.length - 1];
      if (next) { ev.preventDefault(); activate(next.dataset.tab, true); }
    });
  }

  const initial = (window.location.hash || "#leaderboards").slice(1);
  activate(tabs.some((t) => t.dataset.tab === initial) ? initial : "leaderboards");
}

// ========= auto-load at boot =========
async function autoLoad() {
  const chip = $("#status-chip");
  const chipText = $("#status-text");
  const setChip = (state, text) => {
    chip.setAttribute("data-state", state);
    chipText.textContent = text;
  };

  setChip("loading", "loading snapshot...");

  const onProgress = (p) => {
    if (p.phase === "snapshot-start") {
      setChip("loading", `fetching ${p.key}...`);
    } else if (p.phase === "snapshot-done") {
      setChip("loading", `${p.key} loaded`);
    } else if (p.phase === "snapshot-miss") {
      setChip("loading", "snapshot missing, live-fetching Datatracker...");
    } else if (p.phase === "live") {
      setChip("loading", `live-fetching ${p.key} (${p.done}/${p.total})`);
    } else if (p.phase === "live-done") {
      setChip("loading", `live ${p.key} done`);
    }
  };

  try {
    const [da, pp] = await Promise.all([
      loadDocumentAuthors({ onProgress }),
      loadPersons({ onProgress }),
    ]);
    setChip("loading", "building graph...");
    await tick();
    const t0 = performance.now();
    state.graph = buildGraph(da.rows, pp.rows, { repeatedThreshold: 3 });
    const dt = performance.now() - t0;

    const when = fmtIsoDate(da.generatedAt || pp.generatedAt);
    setChip("ready", `snapshot ${when}`);
    chip.title =
      `documentauthor: ${da.rows.length.toLocaleString()} rows [${formatSource(da.source, da.generatedAt)}]\n` +
      `persons: ${pp.rows.length.toLocaleString()} records [${formatSource(pp.source, pp.generatedAt)}]\n` +
      `${state.graph.stats.nAuthors.toLocaleString()} authors, ${state.graph.stats.nEdges.toLocaleString()} edges\n` +
      `graph build: ${dt.toFixed(0)} ms`;

    refreshLeaderboard();
    refreshSourcePresets();
    applyURLState();
  } catch (err) {
    console.error(err);
    setChip("error", `load failed: ${err.message.slice(0, 80)}`);
    chip.title = String(err.stack || err);
    const tbody = $("#leaderboard-tbody");
    if (tbody) tbody.innerHTML = `<tr class="loading-row"><td colspan="9">Load failed. ${escapeHtml(err.message)}</td></tr>`;
  }
}

function fmtIsoDate(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

// ========= sortable column headers (generic) =========
function bindSortHeaders(tableSel, sortState, onChange) {
  const table = $(tableSel);
  if (!table) return;
  for (const th of $$('thead th[data-col]', table)) {
    th.classList.add("sortable");
    th.setAttribute("role", "columnheader");
    th.setAttribute("tabindex", "0");
    const activate = () => {
      const col = th.dataset.col;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === "desc" ? "asc" : "desc";
      } else {
        sortState.col = col;
        sortState.dir = (col === "name" || col === "rank") ? "asc" : "desc";
      }
      onChange();
    };
    th.addEventListener("click", () => { if (!suppressedByTextSelection()) activate(); });
    th.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(); }
    });
  }
}

function syncAriaSort(tableSel, sortState) {
  for (const th of $$(`${tableSel} thead th[data-col]`)) {
    th.setAttribute("aria-sort", th.dataset.col === sortState.col
      ? (sortState.dir === "asc" ? "ascending" : "descending")
      : "none");
  }
}

// ========= leaderboards =========
function setupLeaderboards() {
  $("#lb-limit").addEventListener("change", refreshLeaderboard);
  $("#lb-search").addEventListener("input", debounce(refreshLeaderboard, 180));
  bindSortHeaders("#leaderboard-table", state.lbSort, refreshLeaderboard);
}

function refreshLeaderboard() {
  if (!state.graph) return;
  const limit = $("#lb-limit").value;
  const search = $("#lb-search").value;
  const rows = leaderboard(state.graph, state.lbSort.col, {
    limit: limit === "all" ? "all" : Number(limit),
    search,
    direction: state.lbSort.dir,
  });
  syncAriaSort("#leaderboard-table", state.lbSort);
  const tbody = $("#leaderboard-tbody");
  tbody.innerHTML = "";
  rows.forEach((p, i) => {
    const tr = document.createElement("tr");
    tr.classList.add("interactive");
    tr.setAttribute("role", "button");
    tr.setAttribute("tabindex", "0");
    tr.setAttribute("aria-label", `Set ${p.name} as Buscemi centrality source.`);
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td class="num">${p.rfcFirst}</td>
      <td class="num">${p.rfcCo}</td>
      <td class="num">${p.idFirst}</td>
      <td class="num">${p.idCo}</td>
      <td class="num">${p.totalDocs}</td>
      <td class="num">${p.weighted.toFixed(1)}</td>
      <td class="num">${p.hindex}</td>
    `;
    const activate = () => { setSource(p.id); $("#tab-btn-explorer").click(); };
    bindRowClick(tr, activate);
    tbody.appendChild(tr);
  });
}

// ========= explorer =========
function setupExplorer() {
  bindSliderOutput("#param-lambda", "#out-lambda", 2);
  bindSliderOutput("#param-r", "#out-r", 1);
  bindSliderOutput("#param-depth", "#out-depth", 0);
  bindSliderOutput("#param-k", "#out-k", 0);

  bindSortHeaders(".bc-ranking", state.bcSort, () => state.lastBC && renderBCRanking(state.lastBC));

  const searchEl = $("#source-search");
  const suggestEl = $("#source-suggest");
  let activeIdx = -1;

  searchEl.addEventListener("input", debounce(() => {
    renderSuggestions(searchEl.value);
    activeIdx = -1;
  }, 120));
  searchEl.addEventListener("keydown", (ev) => {
    const items = [...suggestEl.querySelectorAll("li")];
    if (ev.key === "ArrowDown" && items.length) {
      ev.preventDefault(); activeIdx = Math.min(items.length - 1, activeIdx + 1); updateActive(items, activeIdx);
    } else if (ev.key === "ArrowUp" && items.length) {
      ev.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); updateActive(items, activeIdx);
    } else if (ev.key === "Enter") {
      if (activeIdx >= 0 && items[activeIdx]) { ev.preventDefault(); items[activeIdx].click(); }
    } else if (ev.key === "Escape") {
      suggestEl.hidden = true;
    }
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".source-picker")) suggestEl.hidden = true;
  });

  function renderSuggestions(q) {
    if (!state.graph) return;
    const ql = q.trim().toLowerCase();
    if (!ql) { suggestEl.hidden = true; return; }
    const hits = [];
    for (const p of state.graph.persons.values()) {
      if (p.docs === 0) continue;
      if (!nameLooksReal(p.name)) continue;
      if (p.name.toLowerCase().includes(ql) || p.ascii.toLowerCase().includes(ql)) {
        hits.push(p);
        if (hits.length >= 12) break;
      }
    }
    suggestEl.innerHTML = "";
    for (const p of hits) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = `${p.name} (${p.totalDocs} docs)`;
      li.addEventListener("click", () => {
        setSource(p.id);
        searchEl.value = p.name;
        suggestEl.hidden = true;
      });
      suggestEl.appendChild(li);
    }
    suggestEl.hidden = hits.length === 0;
  }
  function updateActive(items, idx) {
    items.forEach((it, i) => it.classList.toggle("active", i === idx));
    items[idx]?.scrollIntoView({ block: "nearest" });
  }

  for (const btn of $$(".preset")) {
    btn.addEventListener("click", () => {
      const pid = findPresetId(btn.dataset.preset);
      if (pid != null) setSource(pid);
    });
  }

  $("#btn-compute").addEventListener("click", compute);
  for (const el of $$("#param-lambda, #param-r, #param-depth, #param-k, #cost-rfc, #q-rfc, #cost-id, #q-id, #cost-rep, #q-rep, #rep-threshold")) {
    el.addEventListener("change", debounce(() => {
      writeURLDebounced();
      if (state.source != null) compute();
    }, 160));
  }

  // Author lookup: find any author's BC relative to the current source.
  const lookup = $("#bc-lookup");
  lookup.addEventListener("input", debounce(() => {
    renderLookup();
    writeURLDebounced();
  }, 140));
}

function renderLookup() {
  const input = $("#bc-lookup");
  const results = $("#bc-lookup-results");
  const q = input.value.trim().toLowerCase();
  if (!q) { results.innerHTML = ""; return; }
  if (!state.graph) {
    results.innerHTML = `<div class="lookup-note">Graph is still loading.</div>`;
    return;
  }
  if (!state.lastBC || state.source == null) {
    results.innerHTML = `<div class="lookup-note">Select a source in the panel on the left to compute BC, then search here.</div>`;
    return;
  }

  const hits = [];
  for (const p of state.graph.persons.values()) {
    if (p.docs === 0) continue;
    const hay = p.name.toLowerCase() + "|" + p.ascii.toLowerCase();
    if (hay.includes(q)) {
      hits.push(p);
      if (hits.length >= 8) break;
    }
  }
  if (!hits.length) {
    results.innerHTML = `<div class="lookup-note">No author matches "${escapeHtml(q)}".</div>`;
    return;
  }

  const sourceName = state.graph.persons.get(state.source)?.name ?? "source";
  const rankMap = state.lastBCRankMap;
  const total = state.lastBCSorted?.length ?? 0;

  results.innerHTML = hits.map((p) => {
    const row = state.lastBC.rows.get(p.id);
    if (!row) {
      return `<div class="lookup-hit lookup-miss">
        <span class="lookup-name">${escapeHtml(p.name)}</span>
        <span class="lookup-badge">unreachable from ${escapeHtml(sourceName)}</span>
        <button class="lookup-reroot" type="button" data-pid="${p.id}">Use as source</button>
      </div>`;
    }
    const rank = rankMap?.get(p.id);
    return `<div class="lookup-hit">
      ${rank ? `<span class="lookup-rank">#${rank.toLocaleString()} / ${total.toLocaleString()}</span>` : ""}
      <span class="lookup-name">${escapeHtml(p.name)}</span>
      <span class="lookup-stat">A = <b>${row.A.toFixed(3)}</b></span>
      <span class="lookup-stat">BC = <b>${row.BC.toFixed(3)}</b></span>
      <button class="lookup-reroot" type="button" data-pid="${p.id}">Use as source</button>
    </div>`;
  }).join("");

  for (const btn of results.querySelectorAll(".lookup-reroot")) {
    btn.addEventListener("click", () => setSource(Number(btn.dataset.pid)));
  }
}

const PRESET_PATTERNS = {
  ekr: ["rescorla", "ekr"],
  jari: ["arkko"],
  stpeter: ["saint-andre", "saint andre"],
  mt: ["martin thomson"],
};

function findPresetId(key) {
  if (!state.graph) return null;
  const pats = PRESET_PATTERNS[key] || [];
  let best = null, bestScore = -1;
  for (const p of state.graph.persons.values()) {
    if (p.docs === 0) continue;
    const hay = p.name.toLowerCase() + "|" + p.ascii.toLowerCase();
    for (const pat of pats) {
      if (hay.includes(pat) && p.totalDocs > bestScore) {
        best = p.id; bestScore = p.totalDocs;
      }
    }
  }
  return best;
}

function setSource(pid) {
  if (!state.graph) return;
  const p = state.graph.persons.get(pid);
  if (!p) return;
  state.source = pid;
  writeURLDebounced();

  const banner = $("#source-banner");
  const nameEl = $("#source-name");
  const statsEl = $("#source-stats");
  const explainerEl = $("#source-explainer");
  const rankingSrcEl = $("#ranking-source-name");

  banner.setAttribute("data-set", "true");
  nameEl.textContent = p.name;
  statsEl.innerHTML = [
    `<span class="stat">RFCs &middot; <b>${p.rfcFirst}</b> first, <b>${p.rfcCo}</b> co</span>`,
    `<span class="stat">I-Ds &middot; <b>${p.idFirst}</b> first, <b>${p.idCo}</b> co</span>`,
    `<span class="stat">total <b>${p.totalDocs}</b></span>`,
    `<span class="stat">weighted <b>${p.weighted.toFixed(1)}</b></span>`,
    `<span class="stat">h-index <b>${p.hindex}</b></span>`,
  ].join("");
  explainerEl.textContent =
    `BC(v; ${p.name}) measures how strongly each IETF author v ` +
    `is connected to ${p.name} through co-authorship, combining direct accessibility ` +
    `A(v, ${p.name}) with embeddedness in the neighbourhood N_r(${p.name}).`;
  rankingSrcEl.textContent = p.name;

  compute();
}

function readEdgeParams() {
  return {
    coauthored_rfc: { c: Number($("#cost-rfc").value), q: Number($("#q-rfc").value) },
    coauthored_id:  { c: Number($("#cost-id").value),  q: Number($("#q-id").value)  },
    repeated_coauthorship: { c: Number($("#cost-rep").value), q: Number($("#q-rep").value) },
  };
}

async function compute() {
  if (!state.graph || state.source == null) return;
  const status = $("#compute-status");
  status.textContent = "Computing BC...";
  await tick();

  const thresh = Number($("#rep-threshold").value);
  if (thresh !== state.graph.repeatedThreshold) retypeEdges(state.graph, thresh);

  const edgeParams = readEdgeParams();
  const lambda = Number($("#param-lambda").value);
  const r = Number($("#param-r").value);
  const D = Number($("#param-depth").value);
  const K = Number($("#param-k").value);

  const t0 = performance.now();
  const result = buscemiCentrality(state.graph, state.source, edgeParams, {
    lambda, r, D, K, maxNeighbours: 50,
  });
  const dt = performance.now() - t0;
  state.lastBC = result;

  // Precompute the full real-name ranking for the lookup widget.
  const sorted = [];
  for (const [id, r] of result.rows) {
    const p = state.graph.persons.get(id);
    if (!p || !nameLooksReal(p.name)) continue;
    sorted.push({ id, A: r.A, BC: r.BC });
  }
  sorted.sort((a, b) => b.BC - a.BC);
  state.lastBCSorted = sorted;
  state.lastBCRankMap = new Map(sorted.map((r, i) => [r.id, i + 1]));

  const sourceName = state.graph.persons.get(state.source)?.name ?? "source";
  status.textContent =
    `Computed in ${dt.toFixed(0)} ms. |N_r(${sourceName})| = ${result.neighbourhood.length}, ` +
    `${sorted.length.toLocaleString()} authors reachable within depth ${D}.`;

  // Refresh lookup label and any already-rendered results.
  const lookupSourceEl = $("#lookup-source-name");
  if (lookupSourceEl) lookupSourceEl.textContent = sourceName;
  renderLookup();

  renderBCRanking(result);
  renderSubgraph({
    svg: $("#viz"),
    graph: state.graph,
    source: state.source,
    neighbourhood: result.neighbourhood,
    bcResult: result,
    alpha: result.alpha,
    reducedMotion: reducedMotion(),
    onNodeClick: (pid) => setSource(pid),
  });
}

function renderBCRanking(result) {
  syncAriaSort(".bc-ranking", state.bcSort);
  const tbody = $("#bc-tbody");
  tbody.innerHTML = "";

  // Build sortable view rows.
  const rows = [];
  for (const [id, r] of result.rows) {
    const p = state.graph.persons.get(id);
    if (!p) continue;
    if (!nameLooksReal(p.name)) continue;
    rows.push({ id, name: p.name, A: r.A, BC: r.BC });
  }

  const col = state.bcSort.col;
  const cmp = (a, b) => {
    if (col === "name") return a.name.localeCompare(b.name);
    if (col === "rank") return 0;
    return (b[col] ?? 0) - (a[col] ?? 0);
  };
  rows.sort(cmp);
  if (state.bcSort.dir === "asc") rows.reverse();

  for (let i = 0; i < Math.min(50, rows.length); i++) {
    const r = rows[i];
    const tr = document.createElement("tr");
    tr.classList.add("interactive");
    tr.setAttribute("role", "button");
    tr.setAttribute("tabindex", "0");
    tr.setAttribute("aria-label", `Re-root Buscemi centrality to ${r.name}.`);
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${r.A.toFixed(3)}</td>
      <td class="num">${r.BC.toFixed(3)}</td>
    `;
    const activate = () => setSource(r.id);
    bindRowClick(tr, activate);
    tbody.appendChild(tr);
  }
}

function refreshSourcePresets() {
  for (const btn of $$(".preset")) {
    const pid = findPresetId(btn.dataset.preset);
    if (pid != null) {
      const p = state.graph.persons.get(pid);
      btn.title = `${p.name} (${p.totalDocs} docs)`;
      btn.setAttribute("aria-label", `Set source to ${p.name}.`);
    }
  }
}

// ========= misc =========
function bindSliderOutput(inputSel, outputSel, precision) {
  const input = $(inputSel);
  const output = $(outputSel);
  const update = () => { output.value = Number(input.value).toFixed(precision); };
  input.addEventListener("input", update);
  update();
}

// ========= theme picker =========
function setupThemeToggle() {
  const buttons = $$(".theme-toggle button");
  function apply(theme) {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    try { localStorage.setItem("bc-theme", theme); } catch (_) {}
    for (const b of buttons) {
      b.setAttribute("aria-pressed", String(b.dataset.themeSet === theme));
    }
    // Re-render the viz so node colours pick up the new palette.
    if (state.lastBC && state.source != null) {
      renderSubgraph({
        svg: $("#viz"),
        graph: state.graph,
        source: state.source,
        neighbourhood: state.lastBC.neighbourhood,
        bcResult: state.lastBC,
        alpha: state.lastBC.alpha,
        reducedMotion: reducedMotion(),
        onNodeClick: (pid) => setSource(pid),
      });
    }
  }
  let saved = "system";
  try { saved = localStorage.getItem("bc-theme") || "system"; } catch (_) {}
  apply(saved);
  for (const b of buttons) b.addEventListener("click", () => apply(b.dataset.themeSet));
}

// ========= boot =========
setupTabs();
setupThemeToggle();
setupLeaderboards();
setupExplorer();
autoLoad();

// Re-layout the viz when the viewport resizes, so nodes/labels always fit.
window.addEventListener("resize", debounce(() => {
  if (state.lastBC && state.source != null) {
    renderSubgraph({
      svg: $("#viz"),
      graph: state.graph,
      source: state.source,
      neighbourhood: state.lastBC.neighbourhood,
      bcResult: state.lastBC,
      alpha: state.lastBC.alpha,
      reducedMotion: reducedMotion(),
      onNodeClick: (pid) => setSource(pid),
    });
  }
}, 200));
