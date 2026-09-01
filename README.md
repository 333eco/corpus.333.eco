# corpus.333.eco

An **MCP server** for an open-licensed corpus — 132 documents across mechanism
papers, essays, institutional positions and white papers — served with
**verifiable provenance**.

```sh
npx @333eco/corpus
```

Every response carries the document's `sha256`, its DOI where one exists, and
whether an OpenTimestamps proof is anchored beside the source. **A retrieval
server normally asks to be believed. This one hands over the means to check it.**

## Why that matters

An agent that cites a passage is in a worse position than a human who does: it
cannot walk to the shelf. It takes whatever the transport delivered, and nothing
about a plausible-looking response distinguishes the canonical text from a
paraphrase, a truncation, or a substitution somewhere upstream.

So the check moves into the response:

```json
"provenance": {
  "sha256": "91a41c759b1e9fdac3c0da667fe32a906aef98e4edec4832c09ac27b2c7663c0",
  "doi": "10.5281/zenodo.22217516",
  "opentimestamps": true,
  "deposited_matches_current": true,
  "verify": {
    "sha256": "printf '%s' \"$(cat <file>)\" | shasum -a 256   # compare to provenance.sha256",
    "doi": "https://doi.org/10.5281/zenodo.22217516",
    "opentimestamps": "ots verify defensive-publications/zero-point-game.md.ots"
  }
}
```

The `verify` block is an instruction, not a promise — it tells you exactly what
to run, so you do not have to trust this sentence either.

⭐ **The demonstration is the contribution.** Anyone can propose provenance-carrying
retrieval. Serving it over a corpus where the anchors are already years deep in
the Bitcoin blockchain is a different claim, and it is not one that can be
manufactured on a schedule.

## Tools

| Tool | Returns |
| --- | --- |
| `search_corpus` | matching documents, provenance envelope, and an excerpt around each match |
| `get_document` | one document in full — canonical text, never a summary |
| `list_documents` | slugs, titles, genres, licences, provenance summaries |

**Text is returned verbatim and is never summarised.** Not a stylistic
preference — a summary cannot be hash-verified, so summarising at the server
would destroy the only property this server has.

## Licences, and the gate

| Licence | Documents |
| --- | --- |
| CC0-1.0 | 125 |
| CC-BY-4.0 | 7 |

CC-BY documents carry `attribute_to` inside their licence block, so an agent can
comply without parsing a licence identifier.

⛔ **The gate is a property, not a policy.** A document reaches the index if and
only if its own source declares a licence this corpus publishes under. There is
no glob and no directory allowlist, because the source repositories are **not**
uniformly licensed and never were:

- `TH/publications` — 96 CC0, **7 CC-BY author-voice essays**
- `TH/film` — rights-reserved, a separate repository *by licence*. Never served.
- `333.eco` — the namespace policy is commercial and explicitly unpublished.

A glob would have relicensed seven essays by publication. A file with **no**
declaration is excluded and reported, never assumed CC0 — the default-open
failure is the one nobody can undo after somebody builds on it.

⚠️ The gate lives in `scripts/build-index.mjs`, not in the request path. A gate a
refactor can route around is a rule; a gate in the artifact is a property. **The
server has no filesystem access to the corpus at all** — it can only serve what
the index contains.

## Two metadata conventions, kept visible

`TH/publications` uses YAML front matter. Sixteen `H3/publications` documents use
a leading markdown table. Both are parsed, and each document records which
convention it used in `metadata_convention` — because a divergence that gets
silently normalised is a divergence nobody fixes. H3 should converge on front
matter; until it does, this is the honest reading.

*The first build reported those sixteen as unlicensed. They were not — the gate
was right about what it could read and wrong about what was there.*

## Staleness

```sh
npm run build     # regenerate dist/corpus.json from the corpora
npm run check     # fail if the committed index is not what the corpora produce
```

⚠️ **A stale corpus server is worse than a stale website**, because the citing
agent cannot tell — it will quote superseded text under an authoritative version
number. `npm run check` runs in CI, and the published package is built from the
same commit that ships it.

## Architecture

```
scripts/build-index.mjs   the licence gate + provenance builder
dist/corpus.json          GENERATED, committed — the only thing the server reads
src/server.mjs            MCP over stdio. Zero dependencies, including no MCP SDK
```

No dependencies at all: MCP over stdio is newline-delimited JSON-RPC 2.0, which
is a few hundred lines to speak correctly, and this estate's standing rule is
node built-ins only. The cost is that protocol revisions are tracked by hand —
`PROTOCOL_VERSIONS` in `src/server.mjs` is where that lives.

## Remote server

The same corpus, the same tools, the same envelope — over HTTP instead of stdio.
`worker/` deploys to Cloudflare Workers.

⭐ **It consumes the published npm package, not the source repositories.** The
dependency is pinned to an **exact** version, and `npm run check` refuses a range:
a remote surface that re-read the corpora would be a *second opinion* about what
a document says, and two opinions about a canonical text is one too many. Local
and remote serve the same bytes because they come from the same tarball.

⚠️ **The corpus is a static asset, not a bundled import.** Gzipped it is 1.61 MB
against a 1 MB compressed script limit on the Workers free plan, so importing it
fails to deploy — and fails harder as the corpus grows. The worker fetches it once
per isolate and memoises it.

Transport is **Streamable HTTP**, not the superseded HTTP+SSE pair. The server is
stateless and read-only, so it never opens a stream: `POST /mcp` for JSON-RPC,
`GET /mcp` returns 405 rather than holding open a stream that would carry nothing.

```sh
cd worker
npm install
npm run check      # public/corpus.json matches the pinned package
npm run dev        # local, on :8787
npm run deploy     # sync + wrangler deploy
```

```json
{ "mcpServers": { "corpus": { "url": "https://corpus.333.eco/mcp" } } }
```

## Client configuration

```json
{
  "mcpServers": {
    "corpus": { "command": "npx", "args": ["-y", "@333eco/corpus"] }
  }
}
```

## Licence

This package is CC0-1.0. **The documents it serves carry their own licences** —
read `licence` in each response, not this heading.
