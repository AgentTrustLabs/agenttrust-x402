# TASK 18 — Public Repository Security & Configuration

Date: 2026-11-05 · Repository-configuration only. No source, test, package, README, or evidence change.
No commit, no push, no branch protection, no alert dismissal.

**Repository:** `AgentTrustLabs/agenttrust-gateway` · public · `main` · head `4c8994db391d77796e06e49c843c42be1eae615b`

---

## VERIFIED

### V1 — Identity and repository baseline

```console
$ gh api user --jq '{login,id}'
{"id":103092391,"login":"naninu123"}
$ gh api /user/memberships/orgs/AgentTrustLabs --jq '{role,state}'
{"role":"admin","state":"active"}

$ gh api /repos/AgentTrustLabs/agenttrust-gateway
{"full_name":"AgentTrustLabs/agenttrust-gateway","owner":"AgentTrustLabs",
 "private":false,"visibility":"public","default_branch":"main"}
$ gh api /repos/…/commits/main --jq '{sha,author}'
{"author":"naninu123","sha":"4c8994db391d77796e06e49c843c42be1eae615b"}
```

Identity, org role, visibility, branch and head commit all match the verified context.

### V2 — Baseline security state (recorded before any change)

| Setting | Baseline |
|---|---|
| `secret_scanning` | **disabled** |
| `secret_scanning_push_protection` | **disabled** |
| `secret_scanning_validity_checks` | **disabled** |
| `secret_scanning_non_provider_patterns` | **disabled** |
| `dependabot_security_updates` | **disabled** |
| Branch protection (`main`) | **none** — `404 Branch not protected` |
| Rulesets | **0** (`[]`) |
| Actions | enabled, `allowed_actions: all`, `sha_pinning_required: false` |
| Workflow permissions | `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false` |
| Workflows present | **0** |
| `has_issues` | true · `has_discussions` false · `has_wiki` false · `has_projects` false |
| `allow_forking` | true · `archived` false · `disabled` false |
| Org plan | **free** (`private_repos: 10000`, `filled_seats: 1`) |

### V3 — Secret scanning and push protection enabled (repository-level)

```console
$ gh api -X PATCH /repos/AgentTrustLabs/agenttrust-gateway \
    -F 'security_and_analysis[secret_scanning][status]=enabled' \
    -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
HTTP 200

$ gh api /repos/AgentTrustLabs/agenttrust-gateway --jq '.security_and_analysis'
{"dependabot_security_updates":{"status":"enabled"},
 "secret_scanning":{"status":"enabled"},
 "secret_scanning_non_provider_patterns":{"status":"disabled"},
 "secret_scanning_push_protection":{"status":"enabled"},
 "secret_scanning_validity_checks":{"status":"disabled"}}
```

Re-read **after** the change, not inferred from the response body. The alerts endpoint now resolves
instead of 404-ing (`Secret scanning is disabled on this repository` → `[]`), which independently
confirms the feature is live.

### V4 — Dependabot alerts and security updates enabled

```console
$ gh api -X PUT /repos/…/vulnerability-alerts            → HTTP 204 (enabled)
$ gh api -X PATCH … -F 'security_and_analysis[dependabot_security_updates][status]=enabled'
{"status":"enabled"}
$ gh api "/repos/…/dependabot/alerts?state=open" --jq length
0
```

Dependabot vulnerability alerts are on, security updates are on, and there are currently **zero open
alerts**. The repository has five direct dependencies (`@concordium/web-sdk`, `@x402/concordium`,
`@x402/core`, plus dev `tsx`, `typescript`) and a committed `package-lock.json`, so the dependency graph
has something to work with.

### V5 — Validity checks: verified as unsupported, not silently skipped

Attempted three times, each returned HTTP 200 with `{"status":"disabled"}` on re-read:

```console
$ gh api -X PATCH … -F 'security_and_analysis[secret_scanning_validity_checks][status]=enabled'
→ 200, then gh api … --jq '.security_and_analysis.secret_scanning_validity_checks'
{"status":"disabled"}
```

**Reason (from GitHub's own plan matrix):** validity checks are `Not included` on the **Free** plan for
public repositories, while `Secret scanning` and `Push protection` are `included` for public repos on Free.
The org is on `free`, confirmed via `gh api /orgs/AgentTrustLabs --jq .plan`. So the 200-with-no-change is
GitHub accepting the request and enforcing its entitlement, not an API bug and not a credential problem.

This is reported as **BLOCKED-BY-PLAN**, not as enabled and not as a silent omission. It becomes available
on GitHub Team/Enterprise, or if the org adopts a paid security add-on — an authorization decision for the
operator, not this task.

`secret_scanning_non_provider_patterns` (generic patterns: HTTP auth headers, connection strings, private
keys) is also Free-plan `Not included`, so it stays disabled for the same reason.

### V6 — Fixture review: `test/task11-secret-hardening.test.mts:24`

Still intact, still labelled, **not modified, not deleted, not rewritten**.

```js
/** Obviously-fake secret material. Never a real credential. */
const FAKE_PRIVKEY = 'a'.repeat(64);
const FAKE_MNEMONIC = 'legal winner thank …';
const FAKE_TOKEN = 'ghp_…';            // value not reproduced here
```

Shape analysis (no value printed): prefix `ghp_`, body 40 alphanumeric characters, **44 total**. GitHub
classic PATs are **40 total** (`ghp_` + 36). So the literal does not match the provider pattern at all —
which is why enabling secret scanning produced **0 alerts**, including on this line, and why push
protection raised nothing on the original push.

Its literal text additionally self-describes as `…NotARealToken…FixtureText…` and ends in six zeros. It is
the *negative* operand in `notOk(out.includes(FAKE_TOKEN), 'api token gone')` — a redaction test, not a
credential.

**Alerts from GitHub on this fixture: none.** Nothing was dismissed; nothing needed dismissing.

### V7 — Branch protection assessment (not enabled, per instructions)

```console
$ gh api /repos/…/branches/main/protection   → 404 "Branch not protected"
$ gh api /repos/…/rulesets --jq length       → 0
```

The branch is fully unprotected. Recommended minimal configuration, with its cost stated honestly:

| Rule | Recommendation | Operational impact |
|---|---|---|
| Require pull request before merging | **Yes**, with `required_approving_review_count: 0` | Blocks direct `git push` to `main`. Every change goes through a PR branch. With 0 approvals required, a solo maintainer can still merge their own PR immediately — this is the key setting that keeps a one-person repo fast. |
| Required status checks | **Not yet** | The repository has **zero workflows**. Requiring a check that never reports would make `main` permanently unmergeable (`Expected — Waiting for status to be reported`). Add checks only after a CI workflow exists and has run at least once. |
| Require conversation resolution | Optional | Harmless, but pointless while there are no reviewers. |
| Restrict force pushes | **Yes** (`allow_force_pushes: false`) | Prevents history rewrite on `main`. The workflow in TASK 17/18 never force-pushes, so no cost. |
| Restrict deletions | **Yes** (`allow_deletions: false`) | Prevents accidental loss of the only branch. No cost. |
| Enforce for admins | **Yes** (`enforce_admins: true`) | Without this, the admin can bypass every rule above — including force-push protection — which defeats the purpose. Cost: the maintainer must also use PRs, no exceptions. |
| Require linear history | Optional | Clean log, but forbids merge commits. Fine for solo work. |
| Require signed commits | **Not yet** | No signing key is configured on this host and the TASK 17 commit is unsigned; enabling this would orphan the initial commit. |

**Bottom line:** the minimum that actually protects anything is
`require PR (0 approvals) + disallow force-push + disallow deletion + enforce for admins`. Status checks
must wait for CI. Enabling this now would make the maintainer's next task require a branch + PR instead of
a direct push — a workflow change the operator should approve deliberately.

### V8 — Repository security review (findings)

| Area | State | Assessment |
|---|---|---|
| Secret scanning | **enabled** (this task) | Free for public repos; covers git history, PRs, issues, wikis |
| Push protection | **enabled** (this task) | Blocks provider-pattern secrets at push |
| Validity checks | disabled | Free-plan entitlement gap (V5) |
| Non-provider patterns | disabled | Free-plan entitlement gap (V5) |
| Dependabot alerts | **enabled** (this task), 0 open | — |
| Dependabot security updates | **enabled** (this task) | — |
| Code scanning / CodeQL | not configured | Free for public repos, but needs a workflow — out of scope (no new workflows) |
| Actions permissions | `allowed_actions: all`, `sha_pinning_required: false` | Broad, but **0 workflows exist**, so nothing can run. Worth tightening to `local_only` or requiring SHA pinning **before** any third-party Action is added — flagged, not changed. |
| Workflow token permissions | `default_workflow_permissions: read` | **Good** — already least-privilege for `GITHUB_TOKEN`. |
| `can_approve_pull_request_reviews` | `false` | Good — prevents Actions from approving PRs. |
| Visibility | public | As intended |
| Issues | enabled | Appropriate for a public project |
| Discussions | disabled | Not needed yet; no action |
| Forking | allowed | Normal for public |
| Wiki / Projects | disabled | Fine |
| Org: `default_repository_permission` | `read` | Good default |
| Org: `two_factor_requirement_enabled` | **false** | Org-wide setting — **out of scope**, flagged only. A public org whose sole admin lacks enforced 2FA is the single highest-leverage remaining risk. |
| Org: `members_can_create_repositories` | true | Out of scope; fine for a one-person org |

---

## Before / After

| Setting | Before | After | Method |
|---|---|---|---|
| `secret_scanning` | disabled | **enabled** | `PATCH /repos/{owner}/{repo}` |
| `secret_scanning_push_protection` | disabled | **enabled** | `PATCH /repos/{owner}/{repo}` |
| `dependabot_security_updates` | disabled | **enabled** | same |
| Dependabot vulnerability alerts | off | **on** | `PUT /repos/{owner}/{repo}/vulnerability-alerts` → 204 |
| `secret_scanning_validity_checks` | disabled | **disabled** | attempted ×3, plan-gated (V5) |
| `secret_scanning_non_provider_patterns` | disabled | **disabled** | not attempted as "enable" — Free-plan `Not included` |
| Branch protection | none | **none** (not enabled, per instructions) | — |
| Rulesets | 0 | **0** | — |
| Actions permissions | `all` / no SHA pinning | **unchanged** | — |
| Workflow permissions | `read` | **unchanged** | — |
| Visibility | public | **unchanged** | — |

---

## Changes made and API evidence

Four repository-level writes, all within the authorized scope, each re-read afterwards:

```console
PATCH /repos/AgentTrustLabs/agenttrust-gateway
  security_and_analysis[secret_scanning][status]=enabled
  security_and_analysis[secret_scanning_push_protection][status]=enabled
  security_and_analysis[dependabot_security_updates][status]=enabled
→ HTTP 200

PUT /repos/AgentTrustLabs/agenttrust-gateway/vulnerability-alerts
→ HTTP 204

# verification (not the response body — a fresh GET)
GET /repos/AgentTrustLabs/agenttrust-gateway
  secret_scanning=enabled, push_protection=enabled,
  dependabot_security_updates=enabled, validity_checks=disabled
GET /repos/…/secret-scanning/alerts        → []   (endpoint now functional; was 404 before)
GET /repos/…/dependabot/alerts?state=open  → 0
```

Unchanged, verified: `main` head `4c8994db…`, `git ls-remote origin` → same SHA, branch protection absent,
0 rulesets, 0 workflows, visibility public. `git status --short` locally → only the pre-existing untracked
`docs/archive/TASK17-result.md`. **No commit, no push.**

---

## NOT TESTED

- **Push protection actually blocking a real secret.** Would require pushing a genuine-looking provider
  token; deliberately not attempted (it would also be a live credential or a fabrication that trips GitHub's
  provider notification). The feature reports `enabled`, which is the strongest claim available without
  that test.
- **Secret scanning's coverage of git history.** The initial commit was pushed while scanning was disabled,
  so GitHub only began scanning after enablement. Whether it retro-scans existing history on enablement was
  not observed — the alerts list is `[]`, but "no alerts yet" is not proof of "history fully scanned".
  `scan-history` returned `Advanced Security is disabled on this repository` (404), which suggests history
  scanning is not part of the Free public-repo tier.
- **Dependabot's first scan.** Alerts are `0`, but a fresh enablement may not have completed a scan cycle.
- **CodeQL / code scanning.** Not configured; adding it needs a workflow file, explicitly out of scope.
- **Org-level settings** (`2FA requirement`, `members_can_create_repositories`, security configurations) —
  read only, never modified.

## BLOCKED

Two settings cannot be enabled on this repository, and the reason is entitlement, not permission:

1. **Validity checks** — `Not included` on the GitHub **Free** plan; available on Team/Enterprise. The API
   accepted the request (HTTP 200) and left the value `disabled`, which is GitHub enforcing the plan.
2. **Non-provider patterns** (generic secrets: HTTP auth headers, connection strings, private keys) — same
   Free-plan gap.

Both would need a paid plan or security add-on: an operator/billing decision.

---

## FINAL VERDICT

**HARDENED, with two plan-gated gaps and one deliberate deferral.**

The repository went from "no secret protection at all" to secret scanning **and** push protection enabled,
plus Dependabot alerts and security updates on — all at repository scope, all re-verified through a fresh
API read rather than trusted from the write response.

Three things are deliberately **not** done and are stated as such:

- **Validity checks and non-provider patterns stay off** because the org is on the Free plan, where GitHub's
  own matrix marks them `Not included`. No amount of repository configuration changes that.
- **Branch protection is not enabled**, as instructed. The recommendation is spelled out with its real cost:
  require-PR with **zero required approvals** keeps a solo maintainer able to merge immediately while still
  forcing changes through a reviewable PR and blocking direct pushes, force-pushes, and deletion. Required
  status checks must wait for a CI workflow to exist — enabling them now would brick the branch.
- **Actions permissions are left broad** (`allowed_actions: all`, no SHA pinning) because zero workflows
  exist; the useful moment to tighten them is immediately before the first third-party Action is added.

The fixture at `test/task11-secret-hardening.test.mts:24` was reviewed, not touched: it is a 44-character
`ghp_`-prefixed fake whose length does not even match the 40-character provider pattern, it is explicitly
commented as fake, and it produced no alert. Nothing was dismissed.

The highest-leverage remaining risk is outside this task's boundaries: **the org does not require 2FA**
(`two_factor_requirement_enabled: false`) for a public org whose sole admin owns the only repository.
