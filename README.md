# git-forge

A GitHub-compatible git forge in one Node 22 process, with no dependencies:
git smart HTTP, REST v3, GraphQL v4 and MCP, all over a single in-memory
store. Written for the make.fun bounty `github-core-clone-01`.

## Run

```sh
node --experimental-strip-types main.ts
```

The process reads `MAKEFUN_SHOP_TOKEN` (the bearer token every API call
must carry) and `MAKEFUN_ENV_URL` (the env to register with and poll for
`done`). It binds an ephemeral port, POSTs `{"port": <port>}` to
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
trial ends and exits 0. With no `MAKEFUN_ENV_URL` it just serves until
killed, which is handy for a local smoke test.

## Layout

- `main.ts` — lifecycle: bind, register, poll done, exit.
- `app.ts` — the HTTP router over the shared store.
- `git.ts` — git's object model, pkt-line framing, packfiles (plain objects
  plus OFS/REF delta reads), fetch selection, three-way merge and diff.
- `git-http.ts` — smart HTTP: info/refs advertisements, upload-pack v2/v0
  (ls-refs, fetch, shallow deepen), receive-pack v0 with fast-forward-only
  per-ref report-status.
- `store.ts` — the whole state: repos, objects, refs, issues, pull requests,
  labels and comments, plus the contents and merge operations.
- `rest.ts` — GitHub REST v3: repos, branches, commits, refs, contents,
  labels, issues, pulls.
- `graphql.ts` — a small GraphQL executor for the documents gh and
  github-mcp-server send, including Relay node ids and `__type` probes.
- `mcp.ts` — MCP over streamable HTTP: `server/discover`, `initialize`,
  `tools/list`, `tools/call` with six tools.
- `scenario.ts` — the viewer login, derived from the harness's fixed
  scenario seed (the bearer token is opaque, so the login is recomputed).
- `http-util.ts` — body reading, JSON replies, bearer auth, request ids.

## Design notes

- One store, four surfaces: a repo created through MCP reads back through
  REST, GraphQL and git as the same object, with the same ids.
- Deterministic: ids and sequences come from counters, commit epochs from a
  fixed base plus a counter. No wall clock, no randomness, no port or date
  in any exported state — two runs on one instance agree.
- Fast-forward only: a push whose new tip is not a descendant of the old
  tip is refused per-ref with `ng <ref> non-fast-forward` and the ref does
  not move; other refs in the same push still apply.
- Merges are squash merges: one commit on the base branch whose tree is the
  three-way merge against the merge-base. A path changed differently on
  both sides is a conflict (HTTP 405, GraphQL `CONFLICTING`).
- Packs are plain objects (no deltas); the reader resolves OFS/REF deltas
  when a client sends them.

## License

MIT — see `LICENSE`.
