# TASK 17 — Local Git Initialization & Initial Publication

Date: 2026-11-05 · Initial publication of the existing 180-file working tree to the verified canonical
repository. One commit, one push, no force, no rewrite.

**This file is written after the push and is deliberately NOT committed** — the task specifies exactly
one initial commit, so adding this report would require a second commit. It exists in the working tree
(unstaged) for the operator to commit if and when they want it.

---

## VERIFIED

### V1 — Preflight

```console
$ pwd
/home/ubuntu/projects/agenttrust
$ ls -d .git            → no .git (before init)
$ find . -path ./node_modules -prune -o -path ./dist -prune -o -type f -print | wc -l
180

$ HOME=… gh api user --jq .login
naninu123
$ HOME=… gh api /user/memberships/orgs/AgentTrustLabs --jq '{role,state}'
{"role":"admin","state":"active"}

$ git ls-remote https://github.com/AgentTrustLabs/agenttrust-gateway | wc -l
0
```

Identity `naninu123` (id 103092391), org role `admin`/`active`, remote exists and had **zero refs**.
No `.git` existed, so initialization started from a genuinely unversioned tree.

### V2 — Commit identity chosen from existing evidence, not invented

The host's global git identity is `Hermes Agent <agent@hermes.ai>` — an agent default, not the
authorized GitHub identity. Existing repositories on this host show the established convention for this
account:

```console
$ git -C /home/ubuntu/projects/4evergent log -1 --format='%an <%ae>'
sabo <103092391+naninu123@users.noreply.github.com>
```

`103092391` is `naninu123`'s GitHub user id, confirmed by `gh api user`. The local repo was configured to
the same identity, so the commit attributes to the authorized account:

```console
$ git config --local user.name  → naninu123
$ git config --local user.email → 103092391+naninu123@users.noreply.github.com
```

No other account was used; no email was fabricated (the noreply alias is GitHub's own, derived from the
verified id).

### V3 — Publication audit (before staging)

`.gitignore` reviewed and relied on: `node_modules/`, `dist/`, `*.tsbuildinfo`, `*.log`, `.env`, `.env.*`
(with `!.env.example`), `*.pem`, `*.key`, `*.p12`, `*.keystore`, editor/OS noise. Evidence directories are
deliberately **not** ignored.

180 candidate files enumerated to `/tmp/audit-files.txt`, then scanned:

| Scan | Result |
|---|---|
| `.env` / `.pem` / `.key` / `.p12` / `.keystore` / `id_rsa` / `id_ed25519` files | **none** |
| PEM / OpenSSH private-key blocks in any file | **none** |
| Provider token patterns (`ghp_`, `sk-`, `xox[baprs]-`, `AKIA`, `AIza`, `glpat-`) | 1 hit — see A1 |
| `password`/`secret`/`token`/`apikey` assigned a literal | **none** |
| SSH key material (`ssh-rsa AAAA`, `ssh-ed25519 AAAA`, `authorized_keys`) | **none** |
| Personal email addresses | **none** (only `@users.noreply.github.com`, `example.com`, npm scope names) |
| Phone numbers, home addresses | **none** |
| VPS public IP `168.110.220.227` | **absent** |
| IPv4 literals outside loopback | **none** |
| Binary blobs | 2, both intentional: `docs/evidence/task02/parameter-schema.bin` (301 B), `test/fixtures/cis8004-module-schema.bin` (11 208 B) |
| Extension outside `md|json|ts|mts|mjs|js|html|bin|jsonl|sha256|txt` | 1: `docs/evidence/task02/agent-card.sha256.v2` (a hash text file) |

**64-hex value classification.** 532 occurrences across 30+ files. Every one was classified by context:
transaction hashes (`5abc7f8b…`, `c93d7024…`, `cb0c2ef7…`), card metadata hashes (`3f614404…`,
`1f001ec9…`), CIS-8004/CIS-8 module refs, faucet `submissionId`, checkpoint `head_hash`/`prev_hash`, and
simulated mock settlement ids. A filtered scan for 64-hex **without** a hash-ish keyword on the same line
surfaced 27 lines, all accounted for: module refs, submission ids, transaction-hash lists in test fixtures
(`test/fixtures`, `test/helpers.mjs`), public-key hex, and `docs/evidence/task02/agent-card.sha256(.v2)`.

Two doc lines quote the deleted `privateKeyHex:` field:

- `docs/archive/TASK11-result.md:119` and `docs/archive/TASK09-READINESS-REVIEW.md:339` — both inside fenced code blocks
  showing **the code that was removed**, with no value. Not secrets; they are the finding itself.

**`sign/`, `evidence/`, `scripts/`, `docs/`, `signing-site/` reviewed individually:**

| Path | Content | Verdict |
|---|---|---|
| `sign/tx-manifest.json` | placeholder labelled `_status: PLACEHOLDER — UNUSED` (TASK 12), four `*_REPLACE` markers, no values | safe — public, inert |
| `evidence/` (10 files) | TASK 01 registry/network/indexer probes: `contract_info`, `healthz`, `openapi`, `tools/list`, block heights | safe — public chain/registry data, non-reproducible historical record |
| `signing-site/` (6 files) | static signing pages + `registration.json` / `repin.json` / `captured-tx.json` / `.well-known/agent-card.json` | safe — parameter hex, module schema (public on-chain), owner base58, tx hashes. No keystore, no `localStorage`, no wallet state (grep for `keystore|seedPhrase|mnemonic|accounts[|walletState|encrypted` → none) |
| `scripts/` (16 files) | task verification/demo scripts | safe — one public API URL (`api.sabokun.my.id`) repeated, public hashes, no keys |
| `docs/` (91 files) | TASK 01–15 reports + evidence | safe — includes absolute host paths (`/home/ubuntu/…`, `/etc/nginx/…`, `/var/www/…`) which are environment description, not credentials |

**Package metadata / README claims:** `private: true` intact, no `license` field, **no LICENSE file**
created, no `repository`/`author`/`homepage`. README says *"No license file is included … All rights
reserved by default"* and its Distribution-model section states the package is not published to npm. No
accidental publication claim and no unsupported license statement.

### V4 — Staging

```console
$ git init -b main
Initialized empty Git repository in /home/ubuntu/projects/agenttrust/.git/
$ git add -A
$ git diff --cached --name-only | wc -l
180
$ git diff --cached --name-only | grep -cE '^node_modules/|^dist/'
0
$ diff /tmp/audit-files.txt <(git diff --cached --name-only | sort)
IDENTICAL — no file appeared after the audit
$ git diff --cached --stat | tail -1
180 files changed, 28784 insertions(+)
```

The staged set is byte-identical to the audited set — nothing was added, removed, or appeared between
audit and staging.

### V5 — Final staged-content secret scan

```console
$ git grep --cached -nE 'BEGIN [A-Z ]*PRIVATE KEY'          → (none)
$ git grep --cached -nE 'gh[pousr]_…|sk-…|xox…|AKIA…'       → 1 hit (A1)
$ git diff --cached --name-only | grep -E '\.env|\.pem$|\.key$|\.p12$|\.keystore$'  → (none)
$ git grep --cached -nE 'ssh-rsa AAAA|ssh-ed25519 AAAA'     → (none)
```

### V6 — Initial commit

```console
$ git commit -m "chore: initial AgentTrust Gateway import"
sha       4c8994db391d77796e06e49c843c42be1eae615b
author    naninu123 <103092391+naninu123@users.noreply.github.com>
committer naninu123 <103092391+naninu123@users.noreply.github.com>
date      2026-11-05T08:46:00+00:00
subject   chore: initial AgentTrust Gateway import
branch    main
tracked   180
```

One commit. No amend, no rewrite.

### V7 — Remote and push

```console
$ git remote add origin https://github.com/AgentTrustLabs/agenttrust-gateway
$ git remote -v
origin  https://github.com/AgentTrustLabs/agenttrust-gateway (fetch)
origin  https://github.com/AgentTrustLabs/agenttrust-gateway (push)

$ git ls-remote origin | wc -l     → 0        # reconfirmed empty immediately before push
$ git push -u origin main
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
push_exit=0
```

No `--force`, no `--force-with-lease`, no history overwrite. Fast-forward into an empty remote.

### V8 — Remote verification

```console
$ git rev-parse HEAD
4c8994db391d77796e06e49c843c42be1eae615b
$ git ls-remote origin
4c8994db391d77796e06e49c843c42be1eae615b        HEAD
4c8994db391d77796e06e49c843c42be1eae615b        refs/heads/main
$ git status -sb
## main...origin/main            # nothing ahead, nothing behind
```

GitHub API:

```console
$ gh api /repos/AgentTrustLabs/agenttrust-gateway
{"full_name":"AgentTrustLabs/agenttrust-gateway","private":false,"visibility":"public",
 "default_branch":"main","size":0,"pushed_at":"2026-11-05T08:46:10Z"}

$ gh api /repos/AgentTrustLabs/agenttrust-gateway/commits/main
{"sha":"4c8994db391d77796e06e49c843c42be1eae615b",
 "author":"naninu123","commit_author":"naninu123",
 "email":"103092391+naninu123@users.noreply.github.com",
 "message":"chore: initial AgentTrust Gateway import"}

$ gh api /repos/.../git/trees/main?recursive=1 → 180 blobs
```

**Content integrity** — local blob hash vs remote blob SHA for four representative files:

```
README.md        local=9ae5a83fc3c8 remote=9ae5a83fc3c8 MATCH
package.json     local=2028a6968e25 remote=2028a6968e25 MATCH
.gitignore       local=fa323c61ec2f remote=fa323c61ec2f MATCH
src/mcp/tools.ts local=be87f16a196f remote=be87f16a196f MATCH
```

**Absent from the remote, as required:** `dist/`, `node_modules/`, `.env`, `LICENSE`.
**Present on the remote:** `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/audit/validate.ts`,
`docs/MCP-GUIDE.md`, `docs/archive/TASK15-result.md`, `evidence/healthz.json`, `sign/tx-manifest.json`,
`signing-site/index.html`, `test/task15-packaging.test.mts`, `scripts/task08-demo.mjs`,
`package-lock.json`.

---

## FINDINGS

### A1 — One provider-token-shaped literal in a test fixture · **reviewed, published, no action taken**

`test/task11-secret-hardening.test.mts:24`

```js
/** Obviously-fake secret material. Never a real credential. */
const FAKE_TOKEN = '…';
```

A `ghp_`-prefixed literal, 44 characters, whose literal text self-describes as
`thisIsNotARealTokenJustFixtureText` and ends in six zeros. It is a synthetic value created by TASK 11 to
prove redaction works, declared under a comment saying so, and never used as a credential — it is the
*negative* in an assertion (`notOk(out.includes(FAKE_TOKEN), 'api token gone')`).

It cannot be a live token: GitHub PATs are 40 random base36 characters after the prefix, and this one is
spelled out in English. Published as-is.

**Notable context:** repository secret scanning is **disabled** on this repository
(`gh api /repos/...` → `secret_scanning: disabled`, `secret_scanning_push_protection: disabled`), so this
value produced no alert. Enabling scanning is an org/repo setting change — explicitly out of scope here,
and flagged in §Remaining items.

### A2 — Absolute host paths in documentation · **published as-is**

`docs/MCP-GUIDE.md:40,62,297`, `docs/archive/TASK04-result.md:325`, `docs/archive/TASK12-result.md:6`,
`docs/archive/TASK13-result.md:13-17,190` and `docs/archive/TASK13-result.md` (nginx/vhost paths). These describe the
build/verification environment (`/home/ubuntu/projects/agenttrust`, `/etc/nginx/…`, `/var/www/…`). They
are not credentials and reveal no secret; several are quoted command output that would be dishonest to
edit. Historical evidence must not be rewritten, so they stayed.

### A3 — Public identifiers are heavily present · **intentional**

Owner account `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` appears 217 times, the faucet-funded
testnet account 17 times, plus token address `JyP9YLib1wYgFmztkcKJL`, token id `1004`, and three
transaction hashes. All are **public on-chain identifiers** — they are the evidence the project exists to
produce. Removing them would destroy the audit trail's meaning.

### A4 — `sign/tx-manifest.json` ships as a labelled placeholder

Four `*_REPLACE` markers, `_status: PLACEHOLDER — UNUSED`, superseded-by pointer to
`signing-site/registration.json`. No fabricated transaction data. Retained per TASK 12's disposition.

### Non-findings (checked)

- No `.env`, keystore, PEM, or SSH material anywhere in the 180 files.
- No personal email, phone, address, or VPS IP.
- No `node_modules/` or `dist/` staged (0 of 180).
- No license invented, no LICENSE added, `private: true` unchanged.
- No npm publish.

---

## Commands executed

```bash
# Phase 1 — preflight
cd /home/ubuntu/projects/agenttrust && pwd
find . -path ./node_modules -prune -o -path ./dist -prune -o -type f -print | wc -l
gh api user --jq .login
gh api /user/memberships/orgs/AgentTrustLabs --jq '{role,state}'
git ls-remote https://github.com/AgentTrustLabs/agenttrust-gateway | wc -l
git config --global --get user.name; git config --global --get user.email
git -C /home/ubuntu/projects/4evergent log -1 --format='%an <%ae>'

# Phase 2 — audit (read-only)
cat .gitignore
find … -type f | sort > /tmp/audit-files.txt
grep -E '\.env|\.pem|\.key|…' /tmp/audit-files.txt
grep -rln 'BEGIN … PRIVATE KEY' .
grep -rnE 'gh[pousr]_…|sk-…|xox…|AKIA…|AIza…|glpat-…' .
grep -rnE '(password|secret|token|apikey)\s*[:=]\s*["'\''].{6,}' .
grep -rnE 'al7795927|@gmail|168\.110\.220\.227|/home/ubuntu' .
grep -rn 'ssh-rsa\|ssh-ed25519\|authorized_keys' .
ls -la sign/ signing-site/ signing-site/.well-known/
python3 -c '…json.load(signing-site/registration.json)…'
gh api /repos/AgentTrustLabs/agenttrust-gateway --jq .security_and_analysis

# Phase 3 — init and stage
git init -b main
git config user.name "naninu123"
git config user.email "103092391+naninu123@users.noreply.github.com"
git add -A
git diff --cached --name-only | wc -l
diff /tmp/audit-files.txt <(git diff --cached --name-only | sort)
git diff --cached --stat
git grep --cached -nE 'BEGIN … PRIVATE KEY'
git grep --cached -nE 'gh[pousr]_…|sk-…'
git diff --cached --name-only | grep -E '\.env|\.pem$|\.key$'

# Phase 4 — commit
git commit -m "chore: initial AgentTrust Gateway import"
git log -1 --format='sha=%H%nauthor=%an <%ae>%n…'
git ls-files | wc -l

# Phase 5 — remote + push
git remote add origin https://github.com/AgentTrustLabs/agenttrust-gateway
git remote -v
git ls-remote origin | wc -l
gh auth setup-git
git push -u origin main
git rev-parse HEAD; git ls-remote origin; git status -sb
gh api /repos/AgentTrustLabs/agenttrust-gateway
gh api /repos/AgentTrustLabs/agenttrust-gateway/commits/main
gh api /repos/AgentTrustLabs/agenttrust-gateway/git/trees/main?recursive=1 --jq '[.tree[]|select(.type=="blob")]|length'
git hash-object <file>  vs  gh api …/contents/<file> --jq .sha
```

---

## Summary

| Item | Value |
|---|---|
| Repository | https://github.com/AgentTrustLabs/agenttrust-gateway |
| Visibility | **public** |
| Default branch | `main` |
| Commit SHA | `4c8994db391d77796e06e49c843c42be1eae615b` |
| Commit subject | `chore: initial AgentTrust Gateway import` |
| Author / committer | `naninu123 <103092391+naninu123@users.noreply.github.com>` |
| Tracked files | **180** |
| Insertions | 28 784 |
| Remote refs before push | 0 |
| Push | fast-forward, `-u origin main`, exit 0 |
| Force used | **no** |
| Local vs remote | identical SHA, 0 ahead / 0 behind |
| Excluded | `node_modules/`, `dist/`, `.env*`, keys, no LICENSE |

## NOT TESTED

- **Post-push CI.** The repository has no workflows and none were added; nothing runs on push.
- **Clone-and-build from the remote.** Content was verified by comparing git blob hashes for four files
  and by counting 180 remote blobs, not by cloning into a fresh directory and building.
- **Secret scanning.** Disabled on the repository, so the push was not independently scanned by GitHub.
- **Branch protection / rulesets.** None configured; not touched.

## BLOCKED

Nothing. No unexpected identity, no pre-existing remote history, no rejected push, no secret requiring
operator review before publication.

---

## Remaining items for operator (not started)

1. **Enable secret scanning + push protection** on the repository — currently all disabled. One of the
   strongest cheap safety nets for a public repo, and outside this task's boundaries.
2. **This report is uncommitted.** It sits in the working tree unstaged. Committing it is a second commit
   the operator may want to make deliberately (with its own message).
3. **Licence** — still absent by design; the repository is public without a licence, which means
   "all rights reserved" despite public visibility. That tension is now visible to the world and worth a
   decision.
4. **README first-run experience** — the README explains a checkout workflow, but GitHub's landing page
   for a repo with no releases, no topics, and no description-of-status may under-sell it. Description is
   set; topics and release/tag are not.
5. **TASK 13 §V7 deployment artifacts** (`/etc/nginx/sites-enabled/agenttrust-vhost`, `/var/www/agenttrust`)
   remain outside the repository and are still unrecorded anywhere public.

## FINAL VERDICT

**PUBLISHED AND VERIFIED.**

The 180-file working tree is now the initial commit of `AgentTrustLabs/agenttrust-gateway` on `main`,
authored by `naninu123`, at `4c8994db`. The remote had zero refs before the push and no force was used.
Local HEAD and `refs/heads/main` agree exactly, the working tree is clean and in sync, and remote blob
hashes match local for every file spot-checked.

The publication audit found no private keys, seed phrases, keystores, credentials, `.env` files, SSH
material, or personal contact data. One provider-token-shaped literal exists in a test fixture, is
self-describing as fake, and is a negative assertion rather than a credential. All 64-hex values are
public on-chain identifiers, and all historical evidence was preserved unmodified.
