# Read-only context integration API

> **Development API:** This interface is available only in builds that contain it. It is not an npm-release compatibility promise. An ACP consumer and producer using this interface must be deployed and validated together.

The API lets another Pi extension consult the ACP-transformed context for the current session without accessing ACP runtime state, session sidecar files, or the mutating ACP tools. It is intended for an extension host, not for a model-facing tool.

## Contract

The producer listens for acquisition requests on Pi's shared extension event bus under this event name:

```ts
"billion-context-pi:readonly-context:v1:acquire"
```

A trusted consumer emits an acquisition request for the current session. The request contains:

- `version: 1`
- `sessionId`: the current Pi session ID
- `signal`: an `AbortSignal` for acquisition cancellation
- `sanitize(record)`: a trusted host callback that returns replacement text or `null` to withhold a complete record
- `respond(result)`: a callback that receives either a lease or a structured acquisition error

The consumer must obtain the session ID from its own `ExtensionContext`. A model must never supply a session ID, signal, sanitizer, lease, or file destination. A model-facing retrieval tool may accept an opaque cursor previously returned by the same lease for the same target; the producer validates that binding.

A successful result contains a lease with:

- `snapshot`, whose `fidelity` is `"acp-text-projection"`
- `signal`, which aborts if the lease becomes invalid
- `context(request?)` for the captured ACP view
- `search(request)` for case-insensitive evidence snippets
- `decompress({ ref, ...request })` for an original evidence target
- `release()` for deterministic cleanup

All retrieval returns inline pages. A page has a snapshot ID, records, serialized byte count, and, for context or decompression, an opaque `nextCursor`. Search results are snippets; use the returned reference with `decompress` when complete evidence is needed. Cursors are lease- and target-bound.

The root module exports the event constant, version, limits, `AcpReadonlyError`, and the request, result, snapshot, record, page, and lease types. Consumers that cannot take a runtime dependency may use structurally compatible types, but must test compatibility against the producer build they deploy.

## Snapshot semantics

ACP captures the projection after its existing context transformation. Acquiring or retrieving data does not run compression again, write session data, rebuild a live ACP index, or read session storage.

The projection is immutable and session-bound. It retains ACP message and block references where available, and can use snapshot-local original references when needed. It is text only:

- Executor system instructions, thinking, and images are omitted.
- Tool calls are inert text, not executable tools.
- Records carry tool provenance and whether that provenance is complete.
- The projection is not guaranteed to match transformations performed later by another extension or provider.

A consumer must treat every record as untrusted evidence. It should apply disclosure and secret-redaction policy to the complete record in `sanitize` before any search, snippet generation, or page splitting. If a record has incomplete provenance or violates a disclosure rule, withhold it by returning `null`.

## Lifecycle and failure handling

A bridge answers only for its matching current session. A disabled ACP extension registers no bridge. A consumer must use its own acquisition deadline and fail clearly if no response arrives; it must not fall back to raw history.

The lease signal aborts when the lease is released, expires, is cancelled, or becomes stale after relevant session lifecycle changes. Consumers must compose this signal with their consultation lifetime, stop model work on abort, check it before accepting terminal advice, preserve already reported usage where applicable, and always release the lease in `finally`.

Acquisition reports errors such as `unavailable`, `unsupported_version`, `stale`, `aborted`, `budget_exceeded`, `busy`, `invalid_request`, `unknown_ref`, `sanitizer_failed`, and `timeout`. Retrieval methods reject with `AcpReadonlyError`. Treat these as failed retrieval or consultation states, not empty successful evidence.

## Producer limits

The producer enforces these hard limits:

| Limit | Value |
| --- | --- |
| Current projection and its initial sanitization | 8 MiB each |
| Retained immutable historical projection | 64 MiB per capture |
| Snapshot metadata | 8 MiB per capture |
| Individual projected or sanitized record | 8 MiB |
| Historical sanitized-record cache | 64 MiB per lease |
| Historical evidence scanned by one search | 64 MiB |
| Records in a capture | 32,768 |
| Metadata traversal | 262,144 nodes, depth 64 |
| Page size | 1–64 KiB |
| Returned bytes per lease | 512 KiB, including metadata |
| Requests per lease | 64 |
| Concurrent pending acquisitions and leases per bridge | 2 |
| Concurrent operations per lease | 1 |
| Lease lifetime from capture | 5 minutes |
| Acquisition and operation deadline | 5 seconds |
| Search query | nonempty, at most 256 characters |
| Search result limit | 1–20 |

The current ACP view and historical evidence have separate capacities. A small current view can be acquired even when the captured history is too large to retain in full. Captured records and metadata remain immutable after capture; the producer does not retain mutable session objects for later projection.

Historical records are sanitized lazily, as complete records, when a lease retrieves or searches them. The resulting disclosed record, a denial, or a sanitization error is cached only for that lease. An over-limit record, sanitization expansion, or exhausted historical cache fails the affected retrieval with `budget_exceeded`; a sanitizer failure uses `sanitizer_failed`. No unsanitized or partial record is substituted.

The producer preserves known references for historical evidence it could not retain, but it does not fabricate placeholders. Decompressing such a reference fails with `budget_exceeded`. A search that must inspect unavailable evidence before it reaches its requested result limit also fails with `budget_exceeded`, rather than returning an incomplete result as if it were complete. Because search may stop after its requested number of results, a successful limited search does not imply that all later evidence was scanned.

A consumer needs additional limits appropriate to its own model window, prompt construction, tool loop, response budget, and cancellation policy. Producer byte limits do not guarantee that every allowed page can fit in a particular model request.

## Test a paired build

Build the ACP checkout, then run the Advisor's opt-in SDK fixture with paths appropriate to the local checkouts and Pi SDK installation:

```bash
cd /path/to/billion-context-pi
npm run build

cd /path/to/pi-advisor
ADVISOR_TEST_ACP=/path/to/billion-context-pi \
ADVISOR_TEST_SDK=/path/to/node_modules/@earendil-works/pi-coding-agent \
bun test test/acp-sdk.test.ts
```

The fixture requires the ACP build output and runs the actual extension pair with an isolated temporary home, session storage, and offline scripted model transport. It checks the producer/consumer type contract and must cover both extension load orders, session isolation, lifecycle invalidation, disclosure and redaction, and model-issued retrieval. It does not replace reloaded-TUI visual validation of the consumer's call, streaming, response, error, and blocked states.

## Consumer checklist

Before exposing this integration to an Advisor-like model:

1. Acquire a lease only for the current session and only through the event contract.
2. Sanitize complete records before search or paging, and deny incomplete or disallowed provenance.
3. Bind model-visible `search_context` and `decompress` handlers to one lease. Do not expose compression, executor tools, filesystem access, or identity-bearing parameters.
4. Keep snapshot and session metadata out of model messages.
5. Enforce model-loop, prompt, response, timeout, and cancellation limits in addition to ACP's limits.
6. Release the lease on every completion, error, timeout, and late acquisition response.
7. Validate both extension load orders, session isolation, lifecycle invalidation, redaction, and model-tool round trips in an isolated Pi SDK fixture before enabling the pair.
