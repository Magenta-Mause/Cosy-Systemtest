#!/usr/bin/env bash
#
# Resolve which ref of a SIBLING Cosy repository belongs to the pull request being
# gated.
#
# Cosy features are routinely cross-cutting: `feat/custom-webhook-format`,
# `feature/cosy-218-minecraft-router` and `feat/cosy-70-template-v3-host-mounts-
# annotations` each exist in BOTH Cosy-Frontend and cosy-backend. A frontend PR tested
# against a released backend would therefore go red for a reason the author cannot fix.
# This script decides which sibling ref (if any) to build alongside the PR.
#
# Resolution order, first match wins:
#
#   1. explicit-override — `<Key>: <ref>` on its own line in the PR body. The escape
#      hatch for pairs that share no branch name and no ticket id (a real example:
#      cosy-systemtest's `test/port-conflict` is the sibling of cosy-backend's
#      `feat/port-check`).
#   2. open-pr        — an OPEN pull request in the sibling repo whose head branch has
#                       the same name. Preferred over a bare branch match because it
#                       yields a fork-correct repository to check out, and because it
#                       stops matching once the sibling is merged and its branch is a
#                       stale leftover.
#   3. branch         — a branch of the same name on the upstream sibling. Covers a
#                       sibling that is pushed but has no PR open yet.
#   4. ticket-token   — a `cosy-<N>` id shared with exactly one sibling branch. This is
#                       what bridges the prefix variance already in the repos
#                       (`feat/cosy-70-...` vs `feature/cosy-218-...`).
#   5. default-branch — nothing matched; the sibling is used as released/`main`.
#
# AMBIGUITY IS A HARD ERROR, never a silent fall back to the default branch. Falling
# back would produce a green gate that tested a combination nobody asked for, which is
# the exact failure class this whole gate exists to prevent.
#
# Inputs are environment variables (see `main`); outputs are written to $GITHUB_OUTPUT.
# The file is sourceable — `main` only runs when it is executed directly — so the pure
# helpers below can be unit-tested without touching the network.

set -euo pipefail

# ── Pure helpers (unit-tested; no network) ───────────────────────────────────

# Extract the `cosy-<digits>` ticket token from a branch name, lowercased.
#
# The digit run is matched greedily, so `cosy-700` yields `cosy-700` and never the
# prefix `cosy-70`. A leading boundary stops `precosy-70` from matching.
extract_ticket() {
  local ref="$1"
  printf '%s' "$ref" \
    | grep -oiE '(^|[^0-9a-z])cosy-[0-9]+' \
    | head -n 1 \
    | grep -oiE 'cosy-[0-9]+' \
    | tr '[:upper:]' '[:lower:]' \
    || true
}

# Does a candidate branch carry exactly this ticket token?
#
# Both boundaries are asserted: without the trailing one, token `cosy-70` matches
# `feat/cosy-700-something`, and both of those branches exist in this project today.
branch_has_ticket() {
  local branch="$1" token="$2"
  printf '%s' "$branch" | grep -qiE "(^|[^0-9a-z])${token}([^0-9]|$)"
}

# Read `<Key>: <value>` from a PR body. Case-insensitive on the key, tolerant of
# surrounding whitespace and of CRLF (GitHub stores PR bodies with \r\n).
#
# Only the FIRST occurrence is honoured, so an edit that leaves an older line behind
# cannot silently change the answer depending on ordering.
read_override() {
  local body="$1" key="$2"
  printf '%s' "$body" \
    | tr -d '\r' \
    | grep -iE "^[[:space:]]*${key}[[:space:]]*:" \
    | head -n 1 \
    | sed -E 's/^[^:]*:[[:space:]]*//' \
    | sed -E 's/[[:space:]]+$//' \
    || true
}

# ── Network helpers ──────────────────────────────────────────────────────────

# Branch names of OPEN pull requests in $1 whose head ref is exactly $2.
# Emits `<head.repo.full_name>\t<number>` lines — full_name so a fork is checked out
# from the fork, not from a same-named upstream branch that may not exist.
open_prs_with_head() {
  local repo="$1" head="$2"
  gh api "repos/${repo}/pulls?state=open&per_page=100" --paginate \
    --jq ".[] | select(.head.ref == \"${head}\") | \"\(.head.repo.full_name)\t\(.number)\"" \
    2>/dev/null || true
}

# Candidate siblings for the ticket sweep, as `<branch>\t<repo>\t<pr-number>` lines.
#
# BOTH open PR heads and plain upstream branches, because step 3 accepts a bare branch
# and a ticket match must not be stricter than a name match — a sibling pushed without
# a PR yet would otherwise be silently missed and the gate would test it against the
# default branch. PR entries come first so the dedupe below keeps the fork-correct
# repository and the PR number when a branch is represented both ways.
sibling_candidates() {
  local repo="$1"
  gh api "repos/${repo}/pulls?state=open&per_page=100" --paginate \
    --jq '.[] | "\(.head.ref)\t\(.head.repo.full_name)\t\(.number)"' 2>/dev/null || true
  git ls-remote --heads "https://github.com/${repo}.git" 2>/dev/null \
    | sed -E "s#^[0-9a-f]+[[:space:]]+refs/heads/(.*)\$#\1\t${repo}\t#" || true
}

upstream_branch_exists() {
  local repo="$1" branch="$2"
  # `git ls-remote` over HTTPS needs no auth for a public repo and no clone.
  [ -n "$(git ls-remote --heads "https://github.com/${repo}.git" "refs/heads/${branch}" 2>/dev/null)" ]
}

default_branch_of() {
  local repo="$1"
  gh api "repos/${repo}" --jq '.default_branch' 2>/dev/null || echo "main"
}

# ── Output ───────────────────────────────────────────────────────────────────

emit() {
  local ref="$1" repo="$2" reason="$3" matched="$4" pr="${5:-}"
  {
    echo "ref=${ref}"
    echo "repository=${repo}"
    echo "reason=${reason}"
    echo "matched=${matched}"
    echo "pr-number=${pr}"
  } >> "${GITHUB_OUTPUT:-/dev/stdout}"

  echo "Resolved ${repo}@${ref} (${reason})${pr:+ via PR #${pr}}"

  # The step summary is the only place a human sees this, and it must be visible on
  # fork PRs too — which is exactly why this is $GITHUB_STEP_SUMMARY and not a PR
  # comment: a fork's token has no `pull-requests: write`.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    # shellcheck disable=SC2016  # the backticks are markdown for the summary table and
    # the %s are printf placeholders — nothing here is meant to expand.
    printf '| `%s` | `%s` | %s | %s |\n' \
      "$SIBLING_REPO" "$ref" "$reason" "${pr:+#$pr}" >> "$GITHUB_STEP_SUMMARY"
  fi
}

fail_ambiguous() {
  local token="$1" repo="$2"
  shift 2
  echo "::error::Ambiguous sibling for ticket ${token} in ${repo}: $* — refusing to guess." >&2
  echo "" >&2
  echo "Two or more branches carry the same ticket id, so this gate cannot tell which one" >&2
  echo "belongs to this PR. Picking one silently, or falling back to the default branch," >&2
  echo "would produce a green result for a combination nobody chose." >&2
  echo "" >&2
  echo "Fix: add a line like this to the PR description, then push an empty commit" >&2
  echo "(editing the body alone fires no workflow event):" >&2
  echo "" >&2
  echo "    ${OVERRIDE_KEY}: <exact-branch-name>" >&2
  exit 1
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  : "${SIBLING_REPO:?SIBLING_REPO is required (e.g. magenta-mause/cosy-backend)}"
  : "${HEAD_REF:?HEAD_REF is required (the PR head branch name)}"
  : "${OVERRIDE_KEY:?OVERRIDE_KEY is required (e.g. Backend-Ref)}"
  local body="${PR_BODY:-}"

  echo "Resolving a sibling ref in ${SIBLING_REPO} for head branch '${HEAD_REF}'."

  # 1. Explicit override.
  local override
  override="$(read_override "$body" "$OVERRIDE_KEY")"
  if [ -n "$override" ]; then
    echo "PR body carries '${OVERRIDE_KEY}: ${override}'."
    if ! upstream_branch_exists "$SIBLING_REPO" "$override"; then
      echo "::error::${OVERRIDE_KEY} names '${override}', but ${SIBLING_REPO} has no such branch." >&2
      echo "An override that does not resolve is a typo, not an instruction to fall back." >&2
      exit 1
    fi
    emit "$override" "$SIBLING_REPO" "explicit-override" "true"
    return
  fi

  # 2. Open PR with the same head branch.
  local pr_matches count
  pr_matches="$(open_prs_with_head "$SIBLING_REPO" "$HEAD_REF")"
  count="$(printf '%s' "$pr_matches" | grep -c . || true)"
  if [ "$count" -gt 1 ]; then
    echo "::error::${SIBLING_REPO} has ${count} open PRs whose head branch is '${HEAD_REF}'." >&2
    echo "Use '${OVERRIDE_KEY}: <branch>' in the PR body to disambiguate." >&2
    exit 1
  fi
  if [ "$count" -eq 1 ]; then
    emit "$HEAD_REF" "$(printf '%s' "$pr_matches" | cut -f1)" "open-pr" "true" \
      "$(printf '%s' "$pr_matches" | cut -f2)"
    return
  fi

  # 3. Bare branch on the upstream sibling (pushed, no PR yet).
  if upstream_branch_exists "$SIBLING_REPO" "$HEAD_REF"; then
    emit "$HEAD_REF" "$SIBLING_REPO" "branch" "true"
    return
  fi

  # 4. Shared cosy-<N> ticket id.
  local token
  token="$(extract_ticket "$HEAD_REF")"
  if [ -n "$token" ]; then
    echo "No same-name sibling; sweeping ${SIBLING_REPO} for ticket '${token}'."

    # Dedupe on the BRANCH NAME. A branch that has an open PR appears twice (once from
    # the PR list, once from ls-remote); that is one candidate, not an ambiguity. Two
    # DIFFERENT branches carrying the same ticket is the real ambiguity, and must fail.
    local seen=() hits=() branch repo num name
    while IFS=$'\t' read -r branch repo num; do
      [ -n "${branch:-}" ] || continue
      branch_has_ticket "$branch" "$token" || continue
      # An `if`, not `[ ... ] && continue`: a false AND-list is a failing statement and
      # `set -e` would abort the whole loop on the first non-duplicate.
      local dup=0
      for name in ${seen[@]+"${seen[@]}"}; do
        if [ "$name" = "$branch" ]; then dup=1; break; fi
      done
      if [ "$dup" -eq 1 ]; then
        continue
      fi
      seen+=("$branch")
      hits+=("${branch}"$'\t'"${repo}"$'\t'"${num}")
    done < <(sibling_candidates "$SIBLING_REPO")

    if [ "${#hits[@]}" -gt 1 ]; then
      fail_ambiguous "$token" "$SIBLING_REPO" "$(printf '%s' "${seen[*]}")"
    fi
    if [ "${#hits[@]}" -eq 1 ]; then
      emit "$(printf '%s' "${hits[0]}" | cut -f1)" "$(printf '%s' "${hits[0]}" | cut -f2)" \
        "ticket-token" "true" "$(printf '%s' "${hits[0]}" | cut -f3)"
      return
    fi
  fi

  # 5. Nothing matched — the sibling is whatever is on its default branch.
  local default
  default="$(default_branch_of "$SIBLING_REPO")"
  emit "$default" "$SIBLING_REPO" "default-branch" "false"
}

# Only run when executed, so the helpers above can be sourced by tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
