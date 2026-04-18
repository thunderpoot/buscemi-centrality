// Force-directed subgraph viz of the source neighbourhood.
// Dependencies: d3 v7 UMD, self-hosted at docs/vendor/d3.min.js, loaded via
// a classic <script> tag in index.html. We read it off the global rather than
// importing, because the UMD bundle is self-contained and has no ES-module
// entrypoint (the jsDelivr +esm "ESM" file is just a shim that re-exports
// from other CDN URLs, so it doesn't self-host).

const d3 = globalThis.d3;
if (!d3 || typeof d3.select !== "function") {
  throw new Error("d3 failed to load: docs/vendor/d3.min.js is missing or did not register window.d3.");
}

// Pull edge colours from the CSS custom properties so the viz tracks light/dark mode.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function edgeColours() {
  return {
    coauthored_rfc: cssVar("--edge-rfc", "#1d4ed8"),
    coauthored_id: cssVar("--edge-id", "#525252"),
    repeated_coauthorship: cssVar("--edge-rep", "#b91c1c"),
  };
}
function sourceColour() { return cssVar("--source-ring", "#b45309"); }

export function renderSubgraph({ svg, graph, source, neighbourhood, bcResult, alpha, onNodeClick, reducedMotion = false }) {
  const EDGE_COLOURS = edgeColours();
  const el = svg instanceof SVGElement ? svg : document.querySelector(svg);
  const rect = el.getBoundingClientRect();
  // Use the actual container size. Fallbacks for the pre-layout case.
  const width = Math.max(320, rect.width || 640);
  const height = Math.max(280, rect.height || 400);

  // Build subgraph: source + neighbourhood nodes, edges induced between them.
  const nodeIds = new Set([source, ...neighbourhood]);
  const nodes = [];
  for (const id of nodeIds) {
    const p = graph.persons.get(id);
    if (!p) continue;
    const bc = bcResult?.rows?.get(id)?.BC ?? 0;
    const a = bcResult?.rows?.get(id)?.A ?? 0;
    nodes.push({
      id,
      name: p.name,
      bc,
      a,
      alpha: alpha?.get(id) ?? (id === source ? 1 : 0),
      isSource: id === source,
    });
  }
  const links = [];
  const seen = new Set();
  for (const id of nodeIds) {
    const neigh = graph.adj.get(id);
    if (!neigh) continue;
    for (const [other, edge] of neigh) {
      if (!nodeIds.has(other)) continue;
      const k = id < other ? `${id}-${other}` : `${other}-${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ source: id, target: other, type: edge.type });
    }
  }

  // Clear previous render.
  const d3svg = d3.select(el);
  d3svg.selectAll("*").remove();
  d3svg.attr("viewBox", `0 0 ${width} ${height}`);

  const g = d3svg.append("g");

  // Zoom/pan.
  d3svg.call(
    d3.zoom()
      .scaleExtent([0.25, 4])
      .on("zoom", (ev) => g.attr("transform", ev.transform))
  );

  // Scales.
  const bcVals = nodes.map((n) => n.bc).filter((v) => Number.isFinite(v));
  const bcMax = Math.max(0.01, d3.max(bcVals) ?? 0.01);
  const rScale = d3.scaleSqrt().domain([0, bcMax]).range([4, 22]);

  // Links.
  const link = g.append("g")
    .attr("stroke-opacity", 0.45)
    .attr("stroke-linecap", "round")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("stroke", (d) => EDGE_COLOURS[d.type] || "#aaa")
    .attr("stroke-width", (d) => d.type === "repeated_coauthorship" ? 2.2 : 1.4);

  // Nodes.
  const node = g.append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "node")
    .style("cursor", "pointer")
    .call(drag());

  const accent = sourceColour();
  const nodeFill = cssVar("--color-link", "#1d4ed8");
  node.append("circle")
    .attr("r", (d) => d.isSource ? Math.max(14, rScale(d.bc)) : rScale(d.bc))
    .attr("fill", (d) => d.isSource ? accent : nodeFill)
    .attr("fill-opacity", 0.85)
    .attr("stroke", (d) => d.isSource ? accent : nodeFill)
    .attr("stroke-opacity", 0.85)
    .attr("stroke-width", 1.2);

  const textColour = cssVar("--color-text", "#1a1a1a");
  const haloColour = cssVar("--color-surface", "#ffffff");
  node.append("text")
    .attr("dy", (d) => -(rScale(d.bc) + 3))
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", textColour)
    .attr("paint-order", "stroke")
    .attr("stroke", haloColour)
    .attr("stroke-width", 3)
    .attr("stroke-linejoin", "round")
    .text((d) => truncate(d.name, 26));

  node.append("title")
    .text((d) => `${d.name}\nA(v,s)=${d.a.toFixed(3)}\nBC(v;s)=${d.bc.toFixed(3)}\nα(u;s)=${d.alpha.toFixed(3)}`);

  node.on("click", (ev, d) => onNodeClick?.(d.id));

  // Simulation.
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance((l) => l.type === "repeated_coauthorship" ? 55 : 90).strength(0.6))
    .force("charge", d3.forceManyBody().strength(-240))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius((d) => rScale(d.bc) + 6));

  // Clamp node centres so circles + labels stay inside the viewBox. Labels
  // sit above each circle (dy = -(radius + 3)), so we budget a bit of top
  // margin to keep text from being clipped at the top edge.
  function clampNode(d) {
    const r = (d.isSource ? Math.max(14, rScale(d.bc)) : rScale(d.bc)) + 2;
    d.x = Math.max(r, Math.min(width - r, d.x));
    d.y = Math.max(r + 14, Math.min(height - r, d.y));
  }

  sim.on("tick", () => {
    nodes.forEach(clampNode);
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  if (reducedMotion) {
    // Pre-settle the layout and stop immediately.
    for (let i = 0; i < 200; i++) sim.tick();
    sim.stop();
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  } else {
    setTimeout(() => sim.alphaTarget(0).stop(), 4000);
  }

  function drag() {
    return d3.drag()
      .on("start", (ev, d) => {
        if (!ev.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => {
        if (!ev.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
