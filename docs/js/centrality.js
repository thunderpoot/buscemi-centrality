// Buscemi centrality computation.
//
// Q(P) = (prod q(τ)) / (1 + sum c(τ))
// A(u, v) = max over paths u⇝v of Q(P),  A(v, v) = 1
// N_r(s) = { u : d_w(u, s) <= r }
// α(u; s) = A(u, s) / Σ_{x ∈ N_r(s)} A(x, s)
// BC(v; s) = λ·A(v, s) + (1−λ)·Σ_{u ∈ N_r(s)} α(u; s)·A(v, u)
//
// Since q ≤ 1 and c ≥ 0, cycles cannot strictly increase Q, so we can safely
// drop the simple-path constraint and do depth-limited label-setting with
// Pareto pruning over (log Σq, Σc) pairs. We cap the frontier at K labels
// per node.

/** @typedef {{c: number, q: number}} EdgeWeights */
/** @typedef {{coauthored_rfc: EdgeWeights, coauthored_id: EdgeWeights, repeated_coauthorship: EdgeWeights}} EdgeParams */

/**
 * Compute A(v, source) for all reachable v, along with d_w(v, source).
 * Returns { A: Map<id, number>, dw: Map<id, number> }.
 *
 * @param {any} graph
 * @param {number} source
 * @param {EdgeParams} edgeParams
 * @param {{D?: number, K?: number}} [opts]
 */
export function accessibilityFromSource(graph, source, edgeParams, { D = 3, K = 6 } = {}) {
  const adj = graph.adj;
  if (!adj.has(source)) return { A: new Map(), dw: new Map() };

  // Pre-compute log(q) and c per edge type.
  const lq = {};
  const cc = {};
  for (const t of Object.keys(edgeParams)) {
    const { q, c } = edgeParams[t];
    lq[t] = q > 0 ? Math.log(q) : -Infinity;
    cc[t] = c;
  }

  // labels: Map<nodeId, Array<{lq, cc}>>, the Pareto frontier.
  const labels = new Map();
  labels.set(source, [{ lq: 0, cc: 0 }]);
  // dw: weighted distance (min cost to reach from source)
  const dw = new Map();
  dw.set(source, 0);

  let frontier = new Set([source]);
  for (let depth = 0; depth < D; depth++) {
    const next = new Set();
    for (const v of frontier) {
      const vLabels = labels.get(v);
      if (!vLabels || vLabels.length === 0) continue;
      const neigh = adj.get(v);
      if (!neigh) continue;
      for (const [u, edge] of neigh) {
        const elq = lq[edge.type];
        const ecc = cc[edge.type];
        if (!Number.isFinite(elq)) continue; // quality 0, edge unusable
        // Extend each label through this edge.
        let updated = false;
        for (const lab of vLabels) {
          const newLq = lab.lq + elq;
          const newCc = lab.cc + ecc;
          if (insertPareto(labels, u, newLq, newCc, K)) updated = true;
        }
        if (updated) {
          next.add(u);
          // update dw
          const uLabels = labels.get(u);
          let minC = Infinity;
          for (const lab of uLabels) if (lab.cc < minC) minC = lab.cc;
          if (!(dw.get(u) <= minC)) dw.set(u, minC);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  // Extract A[v] = max over labels of exp(lq) / (1 + cc)
  const A = new Map();
  for (const [v, labs] of labels) {
    let best = 0;
    for (const l of labs) {
      const q = Math.exp(l.lq) / (1 + l.cc);
      if (q > best) best = q;
    }
    A.set(v, best);
  }
  A.set(source, 1); // A(v, v) := 1
  return { A, dw };
}

/**
 * Insert a new Pareto label (lq, cc) into labels[u]. Returns true iff the
 * insertion changed the frontier.
 * A label (lq1, cc1) dominates (lq2, cc2) iff lq1 >= lq2 AND cc1 <= cc2 (and
 * strictly on at least one).
 */
function insertPareto(labels, u, lq, cc, K) {
  let arr = labels.get(u);
  if (!arr) {
    labels.set(u, [{ lq, cc }]);
    return true;
  }
  // Dominated by any existing? skip.
  for (const e of arr) {
    if (e.lq >= lq && e.cc <= cc && (e.lq > lq || e.cc < cc)) return false;
    if (e.lq === lq && e.cc === cc) return false;
  }
  // Prune existing labels this one dominates.
  const kept = [];
  for (const e of arr) {
    if (!(lq >= e.lq && cc <= e.cc && (lq > e.lq || cc < e.cc))) kept.push(e);
  }
  kept.push({ lq, cc });
  // Cap at K by Q = exp(lq)/(1+cc); drop worst.
  if (kept.length > K) {
    kept.sort((a, b) => (Math.exp(b.lq) / (1 + b.cc)) - (Math.exp(a.lq) / (1 + a.cc)));
    kept.length = K;
  }
  labels.set(u, kept);
  return true;
}

/**
 * Build the source neighbourhood N_r(s) and the α weights.
 * @returns {{ nodes: number[], alpha: Map<number, number>, Asrc: Map<number, number> }}
 */
export function sourceNeighbourhood(graph, source, edgeParams, { r = 2, D = 3, K = 6, maxNeighbours = 50 } = {}) {
  const { A, dw } = accessibilityFromSource(graph, source, edgeParams, { D, K });
  const candidates = [];
  for (const [u, a] of A) {
    if (u === source) continue;
    const dist = dw.get(u);
    if (dist == null) continue;
    if (dist > r + 1e-9) continue;
    candidates.push([u, a]);
  }
  // Keep top-maxNeighbours by A for computational tractability.
  candidates.sort((x, y) => y[1] - x[1]);
  const top = candidates.slice(0, maxNeighbours);
  let sum = 0;
  for (const [, a] of top) sum += a;
  const alpha = new Map();
  if (sum > 0) for (const [u, a] of top) alpha.set(u, a / sum);
  else for (const [u] of top) alpha.set(u, 0);
  return { nodes: top.map(([u]) => u), alpha, Asrc: A, dw };
}

/**
 * Buscemi centrality for all reachable v, relative to source s.
 * Returns Map<id, {BC, A}>
 */
export function buscemiCentrality(graph, source, edgeParams, opts = {}) {
  const { lambda = 0.5, r = 2, D = 3, K = 6, maxNeighbours = 50, onProgress } = opts;
  const { nodes: neigh, alpha, Asrc } = sourceNeighbourhood(graph, source, edgeParams, { r, D, K, maxNeighbours });

  // Collect all candidate nodes v. Use ANY node ever reached from source or from a neighbour.
  // Start with the set of nodes reachable from source.
  const result = new Map();
  for (const [v, a] of Asrc) {
    result.set(v, { A: a, BC: lambda * a, _nsum: 0 });
  }

  // For each u in N_r(s), run another single-source A(·, u) and accumulate α(u)·A(v,u).
  for (let i = 0; i < neigh.length; i++) {
    const u = neigh[i];
    const { A: Au } = accessibilityFromSource(graph, u, edgeParams, { D, K });
    const w = alpha.get(u) ?? 0;
    for (const [v, a] of Au) {
      let row = result.get(v);
      if (!row) {
        row = { A: Asrc.get(v) ?? 0, BC: lambda * (Asrc.get(v) ?? 0), _nsum: 0 };
        result.set(v, row);
      }
      row._nsum += w * a;
    }
    onProgress?.({ done: i + 1, total: neigh.length });
  }

  // Finalise BC = λ A(v,s) + (1-λ) Σ α(u) A(v,u)
  for (const row of result.values()) {
    row.BC = lambda * row.A + (1 - lambda) * row._nsum;
    delete row._nsum;
  }
  // source itself: A(s,s)=1, BC(s;s) = λ + (1-λ) Σ α(u) A(s,u).
  const srcRow = result.get(source) || { A: 1, BC: 0, _nsum: 0 };
  srcRow.A = 1;
  // recompute from scratch using alpha and A(s, u) (= A(u, s) by symmetry here? no; only symmetric if edge
  // quality/cost is symmetric, which it is in this graph since we build an undirected adjacency).
  let srcNsum = 0;
  for (const u of neigh) srcNsum += (alpha.get(u) ?? 0) * (Asrc.get(u) ?? 0);
  srcRow.BC = lambda * 1 + (1 - lambda) * srcNsum;
  result.set(source, srcRow);

  return { rows: result, neighbourhood: neigh, alpha, Asrc };
}

/** Default edge parameters matching the paper's Goodman/Sandler examples. */
export function defaultEdgeParams() {
  return {
    coauthored_rfc: { c: 1, q: 0.9 },
    coauthored_id: { c: 1, q: 0.8 },
    repeated_coauthorship: { c: 1, q: 0.95 },
  };
}
