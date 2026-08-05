# The systemtest PR gate

The nightly run finds regressions the morning *after* they merge. The PR gate runs the
same suite *before* the merge, against images built from the pull request itself.

Three repositories carry the gate, all calling the same composite action here:

| Repository | Workflow | Builds |
|---|---|---|
| `Magenta-Mause/Cosy-Frontend` | `.github/workflows/systemtest.yml` | its own image, plus a matching backend branch |
| `magenta-mause/cosy-backend` | `.github/workflows/systemtest.yml` | its own image, plus a matching frontend branch |
| `magenta-mause/cosy-systemtest` | `.github/workflows/systemtest-pr.yml` | nothing by default — released images, plus any matching sibling |

The required check is **`systemtest-gate`**, not `systemtest`. See
[Why a separate gate job](#why-a-separate-gate-job).

## Why PR images are never pushed to a registry

`config/docker/docker-compose.yml` in `Magenta-Mause/Cosy` references
`ghcr.io/magenta-mause/cosy-{backend,frontend}:${*_IMAGE_TAG}` and sets **no
`pull_policy`**, and `install_cosy.sh` runs a plain `docker compose up -d`. Compose's
default policy is `missing`: an image already present in the local image store under the
requested tag is used as-is, and no registry is contacted.

So a gate run builds `ghcr.io/magenta-mause/cosy-frontend:pr-42-abc1234` **locally**,
passes `--frontend-tag pr-42-abc1234` to the installer, and the stack comes up on the
PR's code. Consequences worth knowing:

- no `packages: write` permission anywhere in the gate,
- nothing is left behind in ghcr,
- fork pull requests work, because nothing needs a secret.

**This rests on a file in another repository that we do not control.** If Cosy's compose
file ever gains `pull_policy: always`, every gate would silently start testing the last
*published* image while reporting a confident green. That is why the run action asserts
it instead of trusting it — see [The three image guards](#the-three-image-guards).

## Which sibling branch gets built

Cosy features are routinely cross-cutting: `feat/custom-webhook-format` exists in both
product repos as this is written. A frontend PR tested against a released backend goes
red for a reason its author cannot fix, so the gate looks for the other half.

`.github/actions/resolve-sibling-ref` decides, first match wins:

| # | Reason | How |
|---|---|---|
| 1 | `explicit-override` | `<Key>: <ref>` on its own line in the PR body |
| 2 | `open-pr` | an **open** PR in the sibling repo with the same head branch name |
| 3 | `branch` | a branch of that name on the upstream sibling |
| 4 | `ticket-token` | a `cosy-<N>` id shared with exactly one sibling branch |
| 5 | `default-branch` | nothing matched — the released/`main` sibling is used |

The resolved ref, its reason and any sibling PR number are written to the job summary,
which is visible on fork PRs too (a PR comment would not be — forks get no
`pull-requests: write`).

Notes on the corners, each of which is deliberate:

- **`open-pr` outranks `branch`** because it yields a fork-correct repository to check
  out, and because it stops matching a branch that has already been merged and left
  behind. A stale branch match would pin the sibling to code that is no longer going
  anywhere.
- **The ticket sweep looks at branches too**, not only open PRs, so it is never
  *stricter* than rule 3. A sibling pushed without a PR yet is still found.
- **The `cosy-<N>` match is anchored** at both ends: `cosy-70` does not match
  `cosy-700`, and both of those have existed here. It is what bridges the prefix
  variance already in the repos (`feat/cosy-70-…` vs `feature/cosy-218-…`).
- **Two branches sharing a ticket is a hard error, never a fallback.** Guessing, or
  quietly reverting to `main`, would produce a green result for a combination nobody
  chose — the exact failure this gate exists to prevent. The error names the override.
- **Some pairs share nothing.** This repo's `test/port-conflict` was the sibling of the
  backend's `feat/port-check`: no common name, no common ticket. That is what the
  override is for.

### Overriding

```
Backend-Ref: feat/some-branch
Frontend-Ref: fix/other-branch
Systemtest-Ref: test/new-specs
```

An override naming a branch that does not exist **fails the gate**; it is a typo, not an
instruction to fall back.

> **Editing the PR body fires no workflow event.** After adding or changing an override
> line, push a commit (an empty one is fine) or re-run the workflow. Nothing will tell
> you otherwise — the run simply keeps using the old resolution.

## Scope, and the two labels

Default scope is **`@core`**: `install`, `auth`, `console`, `files`, `server-create`,
`server-lifecycle`, plus the workflow-appended `uninstall` row. The full suite roughly
doubles the wall clock and pulls in specs that depend on hosted third-party services
(`templates`, `games-search`), which a merge should not block on.

| Label | Effect |
|---|---|
| `systemtest:full` | run the whole suite instead of `@core` |
| `systemtest-skip` | skip the gate; `systemtest-gate` still reports green, loudly, with a warning |

Both labels re-trigger the workflow when added or removed (`types:` includes
`labeled`/`unlabeled`).

## How a gate run differs from the nightly

Same action, different settings — and every difference is a deliberate inversion.

| | Nightly | PR gate |
|---|---|---|
| Scope | whole suite | `@core` (label opts into full) |
| Images | pinned/published | built from the PR, locally |
| `--config-ref` | installer default (the pinned **release** tag) | `main` |
| Retries | 2 | 1 |
| Red features | **exit 0** — metrics are truth | **exit 1** — `--fail-on-failure` |
| SigNoz push | yes | **no** |
| Hosted report | yes (MinIO) | **no** — GitHub artifact only |
| Concurrency | never cancels | newer push cancels the older run |

**Why no telemetry from PR runs.** A `channel=pr` value would fork the metrics'
`deployment.environment`, the report bucket prefix, and the trace root-span name, none of
which `docs/signoz-dashboard.json` or the four alert rules know about. It would also give
every PR run its own series, which is precisely the per-run-label failure convention 11
exists to prevent. The MinIO publish and the OTLP push therefore stay in the nightly
*workflow*, outside the shared action — which additionally keeps the action provably
secret-free, worth having when it runs fork-authored Dockerfiles.

**Why `--config-ref main`.** `install_cosy.sh` defaults `CONFIG_REF` to `COSY_TAG`, the
last *release* tag — so without this the gate would test a PR against the released
compose file, and a backend change needing a new compose variable would be structurally
untestable. The nightly keeps the pinned default, because it is verifying the published
product.

## The three image guards

Every one of these failure modes is **green** without the guard: the run looks entirely
healthy while testing code that is not the pull request's. That is worse than no gate.

1. **Before install — the tagged image exists locally.**
   Catches a skipped or mis-tagged build, and the buildx trap:
   `docker/setup-buildx-action` defaults to the `docker-container` driver, where a
   build's output goes to the build cache and **never reaches the daemon's image store
   unless `load: true` is set**. GHA layer caching (`type=gha`) only works on that same
   driver, so the two things a fast gate wants are exactly the two that conflict. With
   no local image, compose's `missing` policy pulls the published image instead.
2. **After install — the installed `.env` names the tag we asked for.**
   Guard 1 cannot see this. If `--backend-tag` never reached the argument list, the
   installer silently installs its pinned default — and that image is legitimately
   present locally too (the pre-pull put it there), so guard 1 still passes.
3. **After install — the running container's image id is the one we built.**
   Catches a future `pull_policy: always` in the compose file.

## Why a separate gate job

The required status check is **`systemtest-gate`**, a tiny job with `if: always()` that
depends on `systemtest`.

A required check that never *reports* leaves a pull request permanently unmergeable, and
a skipped job reports nothing. So any skip path — the `systemtest-skip` label, a future
`paths-ignore` — would deadlock the repository if `systemtest` itself were the required
check. The gate job translates:

- `success` → green
- `skipped` **with the `systemtest-skip` label** → green, plus a `::warning::` saying the
  PR was not verified
- `skipped` for any other reason → **red**
- anything else (`failure`, `cancelled`) → red

That allowlist is the point. Green-on-any-skip is how a repository silently loses its
gate: someone adds a `paths-ignore` "to save CI minutes" and filtered PRs merge
unverified. For the same reason the workflows carry **no `paths` filter at all**.

## Why the allowlist assertion lives in the caller

Each caller workflow ends with a `jq` assertion over `results/summary.json` requiring
every expected feature by name to be present **and** `passed`.

It duplicates `--fail-on-failure` on purpose, because it answers a question that flag
structurally cannot: *did every feature actually run?* All six `@core` specs skip
themselves via `runsOnlyWithInstall()` when `INSTALL_LOG` is unset — so an install that
dies before that variable is written produces six skips, a green Playwright, a green
runner, and a green job. This is verified behaviour, not a hypothetical.

Keeping it in the **caller** rather than the shared action means it survives a mistyped
`grep`, a flipped `fail-on-failure`, and anyone later "simplifying" the action. A gate
should not have a single point of failure that one typo can switch off.

## Known gaps

- **A flaky pass counts as a pass.** With `retries: 1`, a spec that fails and then
  passes is Playwright `flaky`, which `parseReport` records as `passed`. Zero retries
  would close this, at the price of a 30-minute gate that reds on any transient blip —
  which is how required checks get switched off. The tolerance is one retry, by choice.
- **A frontend PR's result depends on a backend branch its author cannot fix**, and can
  change with no frontend commit when that branch merges and is deleted. Mitigated only
  by making the resolution loud in the job summary.
- **Cross-repo checkout works because every Cosy repo is public.** Making one private
  breaks all three gates with an opaque 404.
- **Docker Hub rate limits** are a shared-IP risk that grows with PR volume. The action
  pre-pulls the whole compose base-image set before installing so a 429 is one labelled
  infrastructure error instead of a stack that mysteriously never becomes healthy.

## Testing the resolver

`resolve.sh` is sourceable — `main` only runs when the file is executed directly — so
the pure helpers can be exercised without touching the network:

```bash
source .github/actions/resolve-sibling-ref/resolve.sh
extract_ticket 'feat/cosy-70-template-v3'      # -> cosy-70
extract_ticket 'feat/cosy-700-other'           # -> cosy-700  (never cosy-70)
branch_has_ticket 'feat/cosy-700-x' 'cosy-70'  # -> non-zero  (anchored)
read_override 'Backend-Ref: feat/x' 'Backend-Ref'
```

The network helpers (`open_prs_with_head`, `sibling_candidates`,
`upstream_branch_exists`, `default_branch_of`) can be redefined after sourcing to drive
`main` through the ambiguity and override paths offline.
