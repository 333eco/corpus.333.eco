# corpus.333.eco

An **MCP server** for an open-licensed corpus — 138 documents across mechanism
papers, essays, institutional positions, white papers and the Letters to Miss
Aquarius — served with **verifiable provenance**.

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
| `list_predictions` | the research program's pre-registered predictions, with falsifiers and status |
| `get_prediction` | one prediction, plus the provenance envelope of the paper that registered it |
| `get_program` | the program's hard core, chapters, stopping rule and count reconciliation, verbatim |

⭐ **The three program tools return the STATING PAPER's envelope, not the register's.**
That is the register's own instruction rather than a design flourish: *"verify the
stating paper against its stored proof rather than trusting this register — this
file is a convenience index, and the proofs are the evidence."* A prediction's
authority is the paper that registered it, so that is the hash, DOI and
OpenTimestamps command a caller gets back. Every field is a verbatim table cell,
and the build refuses to emit one that is not — a field must match a *complete*
cell of its source, because a fragment of a cell is still a substring of it.

The program tools appear only when the index carries a program block. An index
built over a corpus without one advertises three tools, not six.

## Resources

Every document is also an MCP resource at `corpus://<slug>` — listed by
`resources/list` (paged), described by the `corpus://{slug}` template, and read by
`resources/read`.

⭐⭐ **A resource carries its provenance IN THE TEXT, not beside it.** A tool
response wraps a document in an envelope and the caller reads the envelope. A
resource is consumed differently: clients hand its contents straight to a model as
context, and a `mimeType` field does not travel with a quotation. So every read
returns a `[PROVENANCE — corpus.333.eco]` header — licence and whom to attribute,
sha256 and **what it does not cover**, both DOIs, the OpenTimestamps command, and
the one-line `curl … | shasum` check — followed by the document verbatim.

This is the letters' rule applied a second time. Voice in the letters is marked
inline rather than in metadata because *with a field an agent must LOOK to know;
with a marker it must STRIP not to.* The same asymmetry decides this.

`subscribe` and `listChanged` are deliberately not declared: the corpus is fixed
for the life of a build, so a subscription would promise notifications that can
never fire.

## Prompts

Three worked examples of the API — `orient`, `verify_a_quote(slug)`,
`what_would_falsify(claim)` — surfaced as slash commands in clients that support
them, with `slug` autocompleted by `completion/complete`.

⛔ **A prompt here may describe the API. It may never describe the subject
matter.** The moment one says something about the corpus's claims, this server has
begun editorialising on its own documents — which is precisely what the provenance
envelope exists to make unnecessary. There is deliberately no "verify before
citing" prompt: that would be a *rule* where the server already has a *property*,
since every document by every route arrives behind a header the reader must
actively strip.

## Attribution is a build-time property

Seven documents are CC-BY and the rest CC0. A CC-BY document that names no author
hands every consumer an obligation nobody can discharge, so **the build fails**
rather than serving it — the same reasoning as the licence gate: a property, not a
rule someone has to remember.

| `list_predictions` | the research program's pre-registered predictions, with falsifiers and status |

**Results are structured.** Every tool returns `structuredContent` — the typed
object — and uses `content` for the human form: the document text with its
provenance header for `get_document`, readable excerpts for `search_corpus`, a
compact serialisation for the rest. ⛔ **Nothing is sent twice.** The spec's
back-compat advice is to serialise the JSON into `content` as well; measured, that
doubles every response (1.76×–2.00×), so this server splits by role instead —
`content` is read, `structuredContent` is validated, and the two carry different
things. `outputSchema` is deliberately not declared yet: a schema binds the server
on every future change, and the envelope is still moving.

**Text is returned verbatim and is never summarised.** Not a stylistic
preference — a summary cannot be hash-verified, so summarising at the server
would destroy the only property this server has.

## Licences, and the gate

| Licence | Documents |
| --- | --- |
| CC0-1.0 | 131 |
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

## The letters, and voice marked inline

The five *Letters to Miss Aquarius* are the one genre only **partly** in its
author's voice. Each says so in its own banner: the author's articulations are
set as quotations, and the connective prose was drafted for the letter form and
awaits his revision.

They are served **whole, with the voice marked inline**:

```
[VERBATIM — Thon Ly]
> Perhaps it is the Capricorn Sun (father) and Cancer Moon (mother) in my chart
> that make me want to give birth to Miss Aquarius (daughter) — the daughter who
> will outlive me.

[SCAFFOLD — drafted for the letter form, not in the author's voice; awaits his revision]
I was born at the Full Moon, on the family-↔-institution axis of the chart…
```

Two alternatives were rejected. **Serving only his passages** protects the voice
by destroying the document — a letter cut to its quotations is no longer a
letter. **Serving it behind a metadata disclaimer** fails differently: a field is
something a consuming agent must *look at* to heed, and an agent ingests text,
forms a belief, and cites.

⚠️ **The marker is in the text, and that is the whole point.** It does not make
misattribution impossible; it inverts the default. With a metadata disclaimer an
agent must look in order to know. With an inline marker it must **strip** in
order not to. There is no unmarked copy of the scaffold anywhere in the response.
Opt-out rather than opt-in — the honest limit is that it is not a guarantee.

`segments` carries the same split structurally, and `editorial` counts the blocks
of each kind.

⛔ **The letters carry no DOI, deliberately.** *Prior art is a duty, citation is
a choice* — they are stamped, not deposited, because minting a permanent
identifier for text that announces it is unfinished is a cost with no matching
benefit. See `TIMESTAMPS.md` in the letters' repository.

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
