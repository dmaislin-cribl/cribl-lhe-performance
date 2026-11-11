# Cribl Performance Testing

App id `cribl-lhe-performance` — kept on purpose; see "App id and
version" in `AGENTS.md` before renaming it. Measures Cribl Search
performance two ways: Lakehouse searches across engine sizes, and
federated searches over remote data (S3, Azure Blob, GCS, Cribl Lake …).

A Cribl Search App (Vite + React + TypeScript) that runs inside
Cribl Search as a sandboxed iframe. Ship target: Cribl Cloud.
Local dev via `npm run dev`; package for upload with
`npm run package`; deploy to staging with `npm run deploy`.

## Developing

**Read these before making changes:**

1. **`AGENTS.md`** — Cribl App Platform developer reference (host
   globals, fetch proxy, proxies.yml, KV store, React Router).
   This is the official platform API surface.
2. **Framework `docs/skill.md`** (in
   `cribl-search-app-framework/docs/skill.md` if you have it
   checked out, or read it on GitHub) — KQL caveats (crashes,
   unsupported functions), sandboxed iframe constraints (no
   downloads, no popups, CSP), scheduled search patterns,
   provisioning, and UI patterns.

When building a feature, check `AGENTS.md` for the API surface
and `docs/skill.md` for known pitfalls. If you have the Cribl
MCP server running (see below), use it to inspect live APIs and
run test queries before writing client code.

## Cribl MCP

`.mcp.json` at the repo root tells Claude Code how to reach the
Cribl MCP server. It launches the `mcp-remote` bridge against
`http://127.0.0.1:3030/mcp`. The server itself runs in Docker.

`scripts/cribl-mcp.sh` manages the container:

```bash
scripts/cribl-mcp.sh start    # pull image (if needed), run container
scripts/cribl-mcp.sh stop     # stop + remove container
scripts/cribl-mcp.sh status   # show running state
scripts/cribl-mcp.sh logs     # follow container logs
```

The container reads `CRIBL_BASE_URL`, `CRIBL_CLIENT_ID`, and
`CRIBL_CLIENT_SECRET` from `.env`. Optional `CRIBL_MCP_API_KEY`
gates access to the server itself. To replicate on a fresh
machine: install Docker, populate `.env`, run
`scripts/cribl-mcp.sh start`, open this repo in Claude Code, and
the `mcp__cribl__*` tools become available.

## Deploying to staging

`npm run deploy` uses the pinned framework tooling to verify, build,
inspect, upload, preinstall-check, and install/upgrade the exact pack
without force. If your app ships `scripts/provision.ts`, the shared
tool runs it automatically after install — same code path as
`npm run provision` standalone.

```bash
npm run deploy           # full pipeline (bumps the patch version)
VERSION=0.9.0 npm run deploy:version   # deploy as an exact version
npm run deploy:artifact -- --artifact build/<file>.tgz   # deploy a pack as-is (CI uses this)
npm run provision        # reconcile scheduled searches only
npm run provision -- --dry  # show plan without applying
```

**Why `deploy` is not plain `cribl-app-deploy`:** that tool reads the
version from `package.json`, *then* runs `npm run package` — and `apps
package` bumps the patch version on every run. It then inspects the
tarball for the version it read first, which no longer matches, and the
deploy always fails with `pack identity … does not match package.json`.
The scripts package first and pass the exact artifact with `--artifact`,
which also skips the tool's own `verify`, so the scripts run `verify`
themselves.

They also **set the version before packaging**. `apps package` builds
first and bumps afterwards, so a plain `apps package` bakes the
*previous* version into the bundle — the header and every clipboard
export then show one version behind the installed pack. The scripts
write the target version to `package.json` first and pass the same
value to `apps package --version`, so it does not bump again. The deploy target comes from `CRIBL_BASE_URL` in `.env` or
the environment.

**Strict mode is deliberately off.** `package.json` ships
`"cribl": { "appAuthMode": "legacy" }` — the *Open* setting of the
**Strict mode** toggle on the app's Permissions tab, where the app
inherits each user's own permissions plus `policies.yml`.
(`policiesOnly` is Strict: only `policies.yml`, admins included.) It is
shipped rather than left to the toggle because an upgrade applies the
package's value and only falls back to the previously stored mode when
the package has none — so without it, one flip of the toggle would stick
across every later deploy. Keep `policies.yml` complete anyway: it is
what a non-admin user shared the app is granted, and it is all the app
gets if the mode is ever switched to Strict.

The provisioner prints each action:

```
▶ Reconciling provisioned resources …
✓  + create yourapp__metric_catalog
✓  ~ update yourapp__service_summary
✓  · noop   yourapp__home_panel
```

## Cutting a release

Releases are triggered by pushing a `vX.Y.Z` tag — see
`.github/workflows/release.yml`. CI and release use the same pinned
framework action for source verification, supply-chain policy,
deterministic packaging, archive inspection, and release evidence.
The release workflow upgrades a validation workspace with that exact
candidate, attests it, and creates the GitHub Release.

**A lint failure on the tagged commit means no GitHub Release
gets published** and recovery requires either force-retagging or
bumping to a patch release. Catch failures locally before tagging.

**Required pre-tag checks** — run on the commit you're about to
tag, in a clean working tree:

```bash
npm run lint          # must pass — what the workflow gates on
npm test              # unit tests
npx tsc -b            # type-check (not --noEmit: the root tsconfig only references sub-projects, so that checks nothing)
npm pkg set version=X.Y.Z && npm run package -- --version X.Y.Z
```

Plain `npm run package` bumps the patch version, so after it
`package.json` no longer matches the tag you meant to push — and it
builds before bumping, so the bundle would show the old version. Set the
version first, then package at that same version.

If any step fails, do not tag. Fix on `master` first.

**Tagging steps**:

1. Confirm CI is green on the commit you intend to tag.
2. Bump `package.json` `version` to the target `X.Y.Z`.
3. Commit as `chore: release X.Y.Z` with a body that lists the
   PRs / threads in the release.
4. Annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
5. `git push origin master vX.Y.Z`.
6. Confirm the release workflow succeeded:
   `gh run list --workflow=Release --limit 1` and
   `gh release view vX.Y.Z`.

The workflow verifies the `vX.Y.Z` tag matches `package.json`
version on the first step — keep them in sync.

## Cribl KQL caveats

- **`(?i)` inline regex flag crashes** in complex pipelines
  (summarize + extend + nested negation). Use character-class
  alternation `[Cc]onsume[d]?` instead.
- **`foldkeys`** operator exists but the output `key`/`value`
  columns don't support type filtering. Use `_raw` regex parsing
  for field-name discovery instead.
- **Route conflicts**: avoid using `/settings` in pack routes —
  the Cribl host shell intercepts paths containing "settings".
- **`summarize → summarize max(iff(...))`** crashes on real data
  (works on synthetic rows, fails on rows from a prior
  summarize). Split into separate searches joined via lookups.

See the framework `docs/skill.md` for the full list.

## PR conventions

- One purpose per PR. Bundling docs with the minimal code change
  that motivates them is fine; bundling unrelated refactors is
  not.
- Commit messages explain the *why*, not just the *what*. See
  `git log --oneline` for the house style.
- Include a `Co-Authored-By:` trailer when Claude collaborated on
  the commit.
