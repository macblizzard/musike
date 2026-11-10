#!/usr/bin/env bash
# Merge the newest upstream Musike release into the fork, prove the modded features survived, bump the version.
#
# Run by .github/workflows/upstream-sync.yml, and by hand on a scratch clone when a merge needs judgement:
#
#   bash .github/scripts/sync-upstream.sh --dry-run          # do everything except commit/push
#   bash .github/scripts/sync-upstream.sh --tag v1.6.0       # merge a specific release
#   bash .github/scripts/sync-upstream.sh --skip-typecheck   # when no node_modules are installed
#
# Exit codes: 0 = up to date or merged cleanly, 1 = needs a human (conflict or a dropped feature).
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/Ernani1234/musike.git}"
BASE_FILE=".upstream-base"
CONTRACT_FILE=".github/feature-contract.txt"
CONFLICT_FILE=".merge-conflicts"

DRY_RUN=0
FORCE_TAG=""
SKIP_TYPECHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tag) FORCE_TAG="${2:?--tag needs a value}"; shift ;;
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
note() { printf '::error::%s\n' "$*" >&2; }
output() { [ -n "${GITHUB_OUTPUT:-}" ] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT"; return 0; }

git rev-parse --git-dir >/dev/null 2>&1 || { note "not a git checkout"; exit 2; }
[ -z "$(git status --porcelain)" ] || { note "working tree is dirty; commit or stash first"; exit 2; }

git config user.name >/dev/null 2>&1 || git config user.name "musike-mod bot"
git config user.email >/dev/null 2>&1 || git config user.email "musike-mod@example.com"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
# Fetch branches only. Upstream re-uses tag names (v1.0.0, v1.1.0, v1.2.0) that this
# fork rewrote, so a plain `--tags` fetch aborts with "would clobber existing tag" and,
# under `set -e`, kills the sync silently. Tags are fetched one at a time below.
git fetch --quiet --prune upstream '+refs/heads/*:refs/remotes/upstream/*'
git fetch --quiet --prune origin '+refs/heads/*:refs/remotes/origin/*' || true

latest=$(git ls-remote --tags --refs upstream 'v*' \
  | awk '{print $2}' | sed 's|refs/tags/||' | grep -E '^v[0-9]+\.[0-9]+(\.[0-9]+)?$' | sort -V | tail -1)
[ -n "$latest" ] || { note "no upstream release tags found"; exit 1; }

base="v0.0.0"
[ -f "$BASE_FILE" ] && base=$(tr -d '[:space:]' < "$BASE_FILE")
tag="${FORCE_TAG:-$latest}"
# fetch only the tag we are about to merge (force: our rewritten copy may already exist)
git fetch --quiet --force upstream "refs/tags/${tag}:refs/tags/${tag}" \
  || { note "cannot fetch upstream tag $tag"; exit 1; }

say "upstream newest: $latest"
say "fork based on:   $base"
say "merging:         $tag"

if git merge-base --is-ancestor "$tag" HEAD 2>/dev/null; then
  say "already merged: $tag is in this branch's history"
  if [ "$tag" != "$base" ]; then
    printf '%s\n' "$tag" > "$BASE_FILE"
    say "recorded $tag in $BASE_FILE"
  fi
  [ "$DRY_RUN" = 1 ] || { git add "$BASE_FILE" && git commit -q -m "chore: upstream base $tag" || true; }
  output "changed=false"
  exit 0
fi

if [ -z "$FORCE_TAG" ] && [ "$(printf '%s\n%s\n' "$base" "$latest" | sort -V | tail -1)" = "$base" ] && [ "$base" != "v0.0.0" ]; then
  say "nothing newer upstream (fork is on $base)"
  output "changed=false"
  exit 0
fi

# ---- merge, without guessing on conflicts

set +e
merge_output=$(git merge --no-ff --no-edit -m "merge: upstream $tag into the modded fork" "$tag" 2>&1)
merge_rc=$?
set -e

if [ "$merge_rc" -ne 0 ]; then
  conflicts=$(git diff --name-only --diff-filter=U || true)
  git diff --name-only --diff-filter=U > "$CONFLICT_FILE" || true
  printf '%s\n' "$merge_output" | tail -25
  say ""
  say "The merge needs a human. Conflicted files:"
  printf '%s\n' "${conflicts:-  (none reported)}"
  say ""
  say "Resolve with the per-file strategies in the musike-fork-maintenance skill, then re-run this script."
  output "changed=false"
  output "conflict=true"
  exit 1
fi

say "merged cleanly: $(git log --oneline -1)"

# ---- did the modded features survive?

missing=0
while IFS='|' read -r name needle paths; do
  case "$name" in ''|'#'*) continue ;; esac
  found=0
  for p in $paths; do
    if [ -e "$p" ] && grep -rqF -- "$needle" "$p"; then found=1; break; fi
  done
  if [ "$found" = 0 ]; then
    note "modded feature missing after merge: $name (looked for '$needle' in: $paths)"
    missing=1
  else
    say "  ok: $name"
  fi
done < "$CONTRACT_FILE"

if [ "$missing" -ne 0 ]; then
  say ""
  say "Upstream refactored around a modded feature. Nothing was pushed and no IPA was built."
  output "changed=false"
  output "conflict=true"
  exit 1
fi

# ---- typecheck what the bundle will be built from

if [ "$SKIP_TYPECHECK" = 0 ]; then
  command -v pnpm >/dev/null 2>&1 || { note "pnpm is not installed"; exit 1; }
  say "installing workspaces"
  pnpm install --frozen-lockfile
  say "typecheck: web"
  pnpm --filter @musike/web exec tsc --noEmit
  say "typecheck: native"
  ( cd web && pnpm exec tsc --noEmit -p tsconfig.native.json )
  say "typecheck: server"
  ( cd server && pnpm exec tsc --noEmit )
else
  say "typecheck skipped"
fi

# ---- the app needs a version the store sees as newer than both upstream and the last modded build

version=$(node -e '
  const { version: current } = require("./mobile/package.json");
  const upstream = process.argv[1].replace(/^v/, "");
  const parse = (v) => v.split(".").map((n) => parseInt(n, 10) || 0).concat([0, 0]).slice(0, 3);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const up = parse(upstream);
  let next = cmp(up, parse(current)) > 0 ? up : parse(current);
  if (cmp(next, parse(current)) === 0) next = [next[0], next[1], next[2] + 1];
  console.log(next.join("."));
' "$tag")

say "version: $version (was $(node -p "require('./mobile/package.json').version"), upstream $tag)"

node -e '
  const fs = require("fs");
  const file = "./mobile/package.json";
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = process.argv[1];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$version"

printf '%s\n' "$tag" > "$BASE_FILE"

if [ "$DRY_RUN" = 1 ]; then
  say "dry run: leaving the merge and the version bump in the working tree"
  output "changed=true"
  output "version=$version"
  exit 0
fi

git add -A
git commit -q -m "chore(release): $version on upstream $tag"
say "committed $(git log --oneline -1)"

git push --quiet origin HEAD:main
say "pushed to main"

output "changed=true"
output "version=$version"
