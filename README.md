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

⭐ **`search_corpus` matches the phrase first, then all terms.** An exact substring hit
always wins and ranks above everything else — which keeps `B-Heart` and `Re-Tip` precise,
since the tokeniser holds hyphenated marks together. If the phrase is absent, a document
matches when it contains **every** term somewhere (AND, never OR), ranked by how tightly
those terms cluster. Each hit reports `match: "phrase" | "terms"`, because a term match's
excerpt need not contain the words you typed.

⚠️ **This replaced a bare `indexOf`, and a real caller paid for it.** The first external
client to reach the hosted endpoint searched `"gratitude alignment human wellbeing kindness"`
and got **zero results** — while `gratitude` alone returns 109, `alignment` 50, `kindness` 50.
Nothing was missing from the corpus; the matcher demanded that exact five-word string appear
verbatim. **A zero result was recording the matcher's limits while being read as a gap.**

⭐ On a zero result the response now names **which terms appear in no document at all**
(`absent_terms`), so a dead end says something instead of nothing.
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

## Telling us what is missing, or broken

```sh
npx @333eco/corpus --report-gap "what you looked for and did not find"
npx @333eco/corpus --report-bug "what went wrong, and what you expected instead"
```

⭐⭐ **A command, not telemetry, and the difference is the whole point.** The most
useful thing a corpus server can learn is what someone went looking for and did
not find. The hosted endpoint learns that from its own callers as a property of
being the server they called. This package runs on *your* machine, so collecting
it here would be an outbound report about your private reading — and the guard
against that is not a consent prompt or an opt-out flag. **It is that the serving
path cannot reach the code that sends.** `server.mjs` loads `report.mjs` with
a dynamic import inside the argv branch, so a normal session never reads the file
off disk at all.

⭐ **Both flags share one module and one dynamic import**, so the second kind
added no second way into the network — which is why generalising was right and
copying the file would have been wrong.

The command prints the entire payload before sending it, and the payload is the
text you typed plus the version you have. ⚠️ **A bug report carries exactly the
same payload as a gap report, deliberately** — attaching a node version and
platform would be useful to whoever fixes it, but it would give the command two
different promises about what it sends, and the promise is the valuable part.
Anything about your environment that matters, put in the text; then you have
said it on purpose. No machine id, no username, no
hostname, no path. ⭐ The receiving end deliberately does not record the country
it could resolve for free: a voluntary note about a missing document has no use
for where the sender was standing, and collecting a thing because it is available
is how a narrow purpose widens.

⚠️ **The honest limit, because the claim changed shape when this was added.**
Before it, *"this package makes no network call"* was verifiable by
`grep -r fetch src/` returning nothing — the strongest kind of evidence, since it
needs no reasoning. The claim is now narrower: **there is exactly one `fetch` in
the package, it is in `src/report.mjs`, and that file is imported from exactly
one place — a branch requiring an explicit flag.** Still checkable in under a
minute, but it is a chain of two facts rather than one absence.

## What the remote server records

⛔ **The npm package records nothing and sends nothing.** `npx @333eco/corpus`
runs on your machine, reads a local file, and makes no outbound request of any
kind. Everything in this section is about `corpus.333.eco` and only about it.

The asymmetry is deliberate. The hosted endpoint already sees every request it
answers, so writing down what it was asked adds no reach it did not have. The
same lines inside the package would be an outbound report about a stranger's
private reading, which is a different artifact — and not one this is going to
become.

⭐⭐ **No per-caller identity is computed anywhere.** The client label is the
*software's* name, taken from the `clientInfo` it volunteers at handshake —
`claude-code`, `cursor` — never an IP, never a hash of one, never a cookie. Every
user of a given client is one label. That is not a promise to behave well: there
is no code path in `worker/src/telemetry.mjs` that derives a per-caller id, so
there is nothing to leak, sell, subpoena or regret later. The question the server
wants answered is *which clients reach it*, and that question needs no persons in
it.

⭐⭐ **The only search text ever stored is a search that found nothing.** The
reason to log queries at all is to learn what the corpus is missing; a query that
*succeeded* tells you only what a caller was reading, which is their business.
So the successful query has no storage path — an absent branch, not a redaction
step someone has to remember to keep. Remove the enforcer and nothing breaks,
because there is no enforcer.

| Channel | Carries | Why it exists |
| --- | --- | --- |
| Analytics Engine | one row per JSON-RPC call: method, tool, slug, client label, country, protocol, corpus version, result count, error flag, duration — plus the query text **when and only when it matched nothing** | counting; queried by SQL, stays at Cloudflare |
| `thonly.org/api/track` | `corpus_connect` (a handshake) and `corpus_error` (the corpus asset failed to load) | the two things worth interrupting someone about |

⛔ **Not one beacon per tool call.** An agent working through the corpus fires
dozens of calls in seconds, and a notification channel that reports each of them
is a channel nobody reads. The beacon fires on the *handshake*, and the receiving
function pushes only the **first sighting of a client label**, counting every one
after it in silence — so a notification means *a client we have never seen
appeared*. `corpus_error` is exempt and always pushes: it is rare by construction,
and silence is the wrong default for an outage.

⚠️ **A dead beacon must not look like a quiet one.** If the receiving allowlist
changes, the POST 403s and the pushes simply stop — indistinguishable from *no new
clients this week*, which is exactly the reading that would let it stay broken for
months. So the delivery status is written to Analytics Engine as its own row:
silence on the phone is then something you can go and check rather than infer.

⚠️ **`ANALYTICS` is unbound under `wrangler dev` without `--remote`.** The module
degrades to a no-op rather than throwing, so a local session looks entirely normal
and records nothing — expected, and worth knowing before reading an empty dataset
as a finding.

The endpoint discloses all of this in its own `GET /` response, under `records`.
A privacy policy is a page someone has to go and find; this is the endpoint
describing itself, in the one response a caller gets for free before doing
anything, so the disclosure travels with the thing it is about.

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
