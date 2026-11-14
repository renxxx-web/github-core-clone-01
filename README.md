# github-core-clone-01 — an in-process GitHub core

A from-scratch forge that speaks the four surfaces of GitHub's core in one Node process, with no
dependencies beyond the standard library and no git binary: the git smart-HTTP protocol, the
REST v3 API, the GraphQL v4 API, and an MCP endpoint — all over a single in-memory store, so an
object created on any surface reads back identically on the others.

Built for the make.fun `github-core-clone-01` bounty. Entry point is the harness lifecycle in
`main.ts` (bind an ephemeral port, register with `$MAKEFUN_ENV_URL`, wait for done, exit 0);
`app.ts` builds the HTTP server it serves.

## The surfaces

- **Git smart HTTP** (`git.ts`) — protocol v2 advertisement and `ls-refs` (symrefs, peel,
  unborn HEAD, ref-prefix), fetch with shallow/deepen semantics and side-band-64k pack streaming,
  protocol v0 advertisement and fetch, and receive-pack with report-status, fast-forward-only
  ref updates, branch/tag creation and deletion. Packfiles are written undeltified and read with
  full OFS/REF delta resolution, including thin packs against the receiving store. Built packs
  are cached per (repo, wants, haves, depth) — the wants name exact object ids, so a cache entry
  can never go stale.
- **REST v3** (`app.ts`) — repositories (create/list with `Link` pagination, get, patch, delete),
  the contents API (create/update/delete files with sha preconditions, directory listings),
  git refs, branches, commit history, labels, issues and comments, and pull requests (list, get,
  files with line-count diffs, squash merge with three-way conflict detection answering 405).
  Issues and pull requests share one per-repo number sequence, as on GitHub.
- **GraphQL v4** (`graphql.ts`) — a small lexer/parser/executor (operations, variables, aliases,
  fragments, directives) covering viewer, repository, issue and pull-request fields, cursor
  connections, introspection of the types it defines, opaque global ids that round-trip through
  `node(id:)`, batched documents, and the mutations `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` — all landing in the same store REST
  reads.
- **MCP** (`mcp.ts`) — JSON-RPC 2.0 in both eras (`server/discover` and `initialize`), with the
  six canonical tools `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`. The tool list is built once and served verbatim,
  so repeated `tools/list` calls are byte-identical.

## The seeded account

The forge ships with one seeded admin account — login `adaiversen`, id 1000 — which owns every
repository. Requests authenticate with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; repositories
addressed under any other owner answer 404, never 403.

## Performance notes

The hot paths are kept allocation-light: commit parsing is cached per repository, ancestry
checks for push fast-forward validation stop at the first hit instead of walking whole
histories (a 200-push sequence stays linear), trees are flattened once and cached, and shallow
clone packs are built once and reused across concurrent identical requests.

## Run it locally

```sh
MAKEFUN_SHOP_TOKEN=dev node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL, see main.ts
```

To exercise it with the conformance runner from the contest kit:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<port> --token dev --perf
```

## License

MIT — see `LICENSE`.
