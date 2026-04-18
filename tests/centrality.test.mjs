// Smoke tests for centrality.js.
// Run with: node tests/centrality.test.mjs

import { buscemiCentrality, accessibilityFromSource, sourceNeighbourhood } from "../docs/js/centrality.js";

function near(a, b, eps = 1e-4) { return Math.abs(a - b) <= eps; }
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✅ " + msg); }
  else { failed++; console.log("  ❌ " + msg); }
}

// -----------------------------------------------------------------------------
// TEST 1. Paper's abstract BC formula (Goodman example): pure arithmetic.
//   BC = λ·A(v,s) + (1−λ)·Σ α(u)·A(v,u)
//   with λ=0.5, A(v,s)=0.45, α(Goodman)=0.30, α(u1)=0.40, α(u2)=0.30,
//   A(v,Goodman)=1, A(v,u1)=0.20, A(v,u2)=0.10.
// -----------------------------------------------------------------------------
console.log("\n[1] Paper's BC formula (pure arithmetic)");
{
  const lambda = 0.5;
  const Avs = 0.45;
  const alpha = { goodman: 0.30, u1: 0.40, u2: 0.30 };
  const Avu = { goodman: 1.0, u1: 0.20, u2: 0.10 };
  let sum = 0;
  for (const k of ["goodman", "u1", "u2"]) sum += alpha[k] * Avu[k];
  const BC = lambda * Avs + (1 - lambda) * sum;
  ok(near(BC, 0.43), `BC(Goodman) = ${BC.toFixed(4)} == 0.4300`);
}

// -----------------------------------------------------------------------------
// TEST 2. Accessibility A(v, s) is computed correctly on a small graph.
//   Buscemi - u1 via edge q=0.9, c=0.5 -> A(u1, Buscemi) = 0.9/(1+0.5) = 0.60
//   Buscemi - u2 via edge q=0.9, c=1   -> A(u2, Buscemi) = 0.9/(1+1)   = 0.45
// -----------------------------------------------------------------------------
console.log("\n[2] Accessibility on a tiny graph");
{
  const persons = new Map([
    [0, stub(0, "Buscemi")], [1, stub(1, "u1")], [2, stub(2, "u2")],
  ]);
  const adj = new Map([[0, new Map()], [1, new Map()], [2, new Map()]]);
  link(adj, 0, 1, "t1");
  link(adj, 0, 2, "t2");
  const g = { persons, adj, edges: new Map(), docs: new Map(), repeatedThreshold: 3 };
  const params = { t1: { q: 0.9, c: 0.5 }, t2: { q: 0.9, c: 1 } };
  const { A } = accessibilityFromSource(g, 0, params, { D: 3, K: 6 });
  ok(near(A.get(0), 1), `A(Buscemi, Buscemi) = ${A.get(0)} == 1.0`);
  ok(near(A.get(1), 0.60), `A(u1, Buscemi) = ${A.get(1).toFixed(4)} == 0.6000`);
  ok(near(A.get(2), 0.45), `A(u2, Buscemi) = ${A.get(2).toFixed(4)} == 0.4500`);
}

// -----------------------------------------------------------------------------
// TEST 3. A takes the MAX over paths (direct vs. 2-hop).
//   a - b: q=0.5, c=0.1 -> Q direct = 0.5/1.1 ~ 0.4545
//   a - c - b: a-c q=0.9 c=0.1; c-b q=0.9 c=0.1 -> Q = 0.81/(1+0.2) = 0.675
//   So A(a, b) = 0.675 via the 2-hop path.
// -----------------------------------------------------------------------------
console.log("\n[3] A takes max over paths (2-hop beats direct)");
{
  const persons = new Map([[0, stub(0, "a")], [1, stub(1, "b")], [2, stub(2, "c")]]);
  const adj = new Map([[0, new Map()], [1, new Map()], [2, new Map()]]);
  link(adj, 0, 1, "weak");
  link(adj, 0, 2, "strong");
  link(adj, 1, 2, "strong");
  const g = { persons, adj, edges: new Map(), docs: new Map(), repeatedThreshold: 3 };
  const params = { weak: { q: 0.5, c: 0.1 }, strong: { q: 0.9, c: 0.1 } };
  const { A } = accessibilityFromSource(g, 1, params, { D: 3, K: 6 });
  const expected = 0.81 / (1 + 0.2); // 0.675
  ok(near(A.get(0), expected), `A(a, b) = ${A.get(0).toFixed(4)} == ${expected.toFixed(4)} (2-hop path wins)`);
}

// -----------------------------------------------------------------------------
// TEST 4. α sums to 1 when N_r is non-empty.
// -----------------------------------------------------------------------------
console.log("\n[4] α weights sum to 1");
{
  const persons = new Map();
  const adj = new Map();
  for (let i = 0; i < 6; i++) { persons.set(i, stub(i, `n${i}`)); adj.set(i, new Map()); }
  // star from 0
  for (let i = 1; i < 6; i++) link(adj, 0, i, "rfc");
  const g = { persons, adj, edges: new Map(), docs: new Map(), repeatedThreshold: 3 };
  const params = {
    rfc: { q: 0.9, c: 1 }, id: { q: 0.8, c: 1 }, rep: { q: 0.95, c: 1 },
    coauthored_rfc: { q: 0.9, c: 1 }, coauthored_id: { q: 0.8, c: 1 }, repeated_coauthorship: { q: 0.95, c: 1 },
  };
  const { alpha } = sourceNeighbourhood(g, 0, params, { r: 2, D: 3, K: 6 });
  const total = [...alpha.values()].reduce((s, x) => s + x, 0);
  ok(near(total, 1.0, 1e-9), `Σ α(u) = ${total.toFixed(6)} == 1.0 (over ${alpha.size} neighbours)`);
}

// -----------------------------------------------------------------------------
// TEST 5. End-to-end BC on a clean graph with known answer.
//   Source s. Neighbours a, b (edges q=0.9, c=1). Target v: only via a (q=0.9, c=1).
//   With r=1, N_r(s) = {a, b} (v is at dw=2, excluded).
//     A(a, s) = A(b, s) = 0.45,  A(v, s) via a = 0.81/(1+2) = 0.27.
//     α(a) = α(b) = 0.5.
//     A(v, a) = 0.45 (direct); A(v, b) via a,s,b = 0.9³/(1+3) = 0.18225.
//   BC(v; s) = 0.5·0.27 + 0.5·(0.5·0.45 + 0.5·0.18225)
//            = 0.135 + 0.5·(0.225 + 0.091125)
//            = 0.135 + 0.1580625 = 0.2930625
// -----------------------------------------------------------------------------
console.log("\n[5] End-to-end BC on a clean graph");
{
  const persons = new Map([[0,stub(0,"s")], [1,stub(1,"a")], [2,stub(2,"b")], [3,stub(3,"v")]]);
  const adj = new Map([[0,new Map()],[1,new Map()],[2,new Map()],[3,new Map()]]);
  link(adj, 0, 1, "e");   // s - a
  link(adj, 0, 2, "e");   // s - b
  link(adj, 1, 3, "e");   // a - v
  const g = { persons, adj, edges: new Map(), docs: new Map(), repeatedThreshold: 3 };
  const params = { e: { q: 0.9, c: 1 } };
  const r = buscemiCentrality(g, 0, params, { lambda: 0.5, r: 1, D: 4, K: 6, maxNeighbours: 50 });
  const bcV = r.rows.get(3).BC;
  const aV = r.rows.get(3).A;
  ok(near(aV, 0.27, 1e-4), `A(v, s) = ${aV.toFixed(4)} == 0.2700`);
  ok(near(bcV, 0.2930625, 1e-4), `BC(v; s) = ${bcV.toFixed(6)} == 0.293063`);
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

// ----------------- helpers -----------------
function stub(id, name) {
  return { id, name, ascii: name, rfcFirst:0, rfcCo:0, idFirst:0, idCo:0, totalDocs:0, weighted:0, hindex:0, docs:1 };
}
function link(adj, a, b, type) {
  adj.get(a).set(b, { type, rfcShared: 1, idShared: 0 });
  adj.get(b).set(a, { type, rfcShared: 1, idShared: 0 });
}
