_Submission to SIGBOVIK 2026._

# Buscemi Centrality: Source-Relative Centrality in Heterogeneous Affiliation Graphs

Paper: [`main.pdf`](main.pdf) / [`main.tex`](main.tex).

## IETF Explorer

`docs/` is a static web tool that applies the paper's formulation to
the IETF co-authorship graph (RFCs + Internet-Drafts). Designed for
GitHub Pages. No build step.

### How it stays fresh without maintenance

`.github/workflows/refresh-snapshot.yml` runs every Monday at 05:17 UTC.
It executes `scripts/refresh-snapshot.py`, which paginates `documentauthor`
and `person` from `datatracker.ietf.org/api/v1/`, writes compact JSON to
`docs/data/`, and commits the diff back. The script also writes
`docs/data/.last-run` on every run so the commit always lands and GitHub's
60-day-inactivity timer for scheduled workflows never fires. GitHub Pages
auto-rebuilds when the commit hits the branch.

If the snapshot is missing (e.g. before the workflow has ever run), the
client silently falls back to paginating Datatracker live.

### Local assets you need to drop in

The site self-hosts everything (no third-party CDN). Three files must be
present:

| Path                                                  | Source |
| ----------------------------------------------------- | ------ |
| `docs/assets/buscemi.jpg`                             | Any portrait of Steve Buscemi. ~600x800 JPEG, used as header avatar, About-tab figure, OG / Twitter preview, Apple touch icon. |
| `docs/assets/fonts/InterVariable.woff2`               | `curl -L https://rsms.me/inter/font-files/InterVariable.woff2 -o docs/assets/fonts/InterVariable.woff2` |
| `docs/assets/fonts/JetBrainsMono-VariableFont_wght.woff2` | From the [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono/releases/latest) release zip; copy `fonts/webfonts/JetBrainsMono-VariableFont_wght.woff2`. |
| `docs/vendor/d3.min.js`                               | `curl -L https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js -o docs/vendor/d3.min.js` (UMD bundle, self-contained). |

Without the fonts the page falls back to system-ui sans / monospace; without
the Buscemi image the avatar shows a "SB" badge and the About figure hides;
without D3 the BC Explorer throws on load (Load and Leaderboards tabs still
work).

### Features

- Leaderboards over every author Datatracker has ever seen: RFC / I-D
  first-authored, co-authored, total, weighted, h-index. Sortable column
  headers (click to sort, again to reverse). Junk names ("-", `"juga"`,
  un-decoded MIME-words, bare emails, hex blobs) are filtered.
- BC Explorer: pick any author as source, see
  $BC(v;s) = \lambda A(v,s) + (1 - \lambda) \sum_{u \in N_r(s)} \alpha(u;s) A(v,u)$
  for every reachable v. Live-tunable $\lambda$, $r$, path-depth cap $D$,
  Pareto frontier width $K$, per-edge-type cost/quality. Force-directed
  subgraph of $N_r(s)$, click any node to re-root.

### Quality bar

- Mobile-first responsive (works to ~320px wide).
- WCAG 2.2 AA contrast; full keyboard navigation; skip link; ARIA
  `aria-live` regions; honours `prefers-reduced-motion`,
  `prefers-color-scheme` (full dark mode), and `prefers-contrast`.
- SEO: canonical, OpenGraph + Twitter cards, JSON-LD `WebApplication`,
  sitemap, robots.
- Self-hosted: no third-party network requests at runtime.

### Running locally

```
python3 -m http.server 8000 --directory docs
```

Then visit <http://127.0.0.1:8000/>.

### Tests

```
node tests/centrality.test.mjs
```

Verifies the paper's BC formula (Goodman example: 0.43) and the
accessibility / neighbourhood implementation against hand-computed
answers on small graphs.
