# Static containment release — v1.12.1

The v1.12.0 static handler served arbitrary readable project files and allowed
encoded traversal outside the project. The replacement permits only the game's
HTML, manifest, icons, vendored browser libraries, translation patch, client JS
under `src/` and the debugger's JSON captures/scenes. Dot paths, node_modules,
local notes, databases, server modules and other non-public files are denied.
Canonical-path validation rejects symlink aliases both inside and outside the
project. An allowlist is necessary because containment alone would still expose
private files inside the root.

`tools/check-static-exposure.mjs` loads the actual `server.js` and sends raw HTTP
request paths to its handler. API/presence dependencies and the listening port
are substituted; static routing and filesystem operations are real. Its fixtures
include dummy databases and private files in a disposable directory, never player
data. It also checks successful public assets, HTML substitution, cache headers,
malformed encodings and health.

## Revert proof

The original server was copied to `/tmp/ff3mmo-server-before-containment.bak`.
After the fixed handler passed, the original file was restored from that backup
without Git. The gate exited 1 with 22 failed refusals, including:

```
FAIL /ff3mmo.db: expected 403 or 404, got 200
FAIL /.git/config: expected 403 or 404, got 200
FAIL /%2e%2e%2foutside.js: expected 403 or 404, got 200
AssertionError [ERR_ASSERTION]: 22 private paths were not refused
```

The fixed file was restored byte-for-byte and passed again: 25 private/traversal
paths refused. Complete local evidence: `/tmp/ff3mmo-static-revert-proof.log`.

## Release pipeline

The original script has **89 executable `run_gate` calls** (count anchored to
`^run_gate `, excluding comments and its function definition). This release adds
18 omitted continent checks and the new static gate: **108 calls**. The two Mines
checks remain excluded until that separate working tree is restored. The script
remains ignored and untracked: the pre-push amendment removed it from the
public commit and restored its ignore rule. Gates run in a disposable copy
excluding databases; deployment
still uses the script's commit, push, OLD_SHA capture, restart and smoke rollback.

The earlier statement that v1.12.0 passed “105 deployment gates” was inaccurate:
those were separate checks, not 105 gates enforced by `deploy.sh`.

## Known and open — excluded from this release

- JWT fallback secret.
- Spoofable `X-Forwarded-For` handling.
- Unbounded `readBody`.

These findings remain unchanged by explicit scope instruction.

## Deployment handoff and Mines restoration

The shipped containment commit is `16acbd84`, amended from the local
`d8e98725` before push. External verification supplied by the deploying operator:
health v1.12.1, smoke OK, production HEAD 16acbd84; database, Git config, server
modules, package metadata, deployment script and local notes returned 403.
The encoded traversal probe returned 400. Index, client JS, vendored jsnes and
the translation patch returned 200.

The Mines stash was restored after release. All 39 non-changelog files match
the pre-stash SHA-256 manifest byte-for-byte. CHANGELOG matches after removing
only the preserved v1.12.1 section; its original Unreleased Mines block remains
above that section. The stash is retained as a backup. The two Mines gates are
now registered locally, bringing the runner to 110 executable calls. Mines
remains uncommitted and requires Joel's playtest before deployment.
