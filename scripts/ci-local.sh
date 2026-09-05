#!/bin/bash
# Stage 9에서 반복해서 깨지던 검사와 같은 게이트.
# pre-push 와 CI 의 "Existing build and transform checks" 가 이걸 그대로 부른다.
set -euo pipefail

REPO="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
cd "$REPO"

say() { printf '== %s ==\n' "$1"; }

say "required executables"
node scripts/check-executables.mjs

say "license and notice policy"
node scripts/license-policy.mjs
node scripts/check-third-party-notices.mjs
node --test \
  scripts/check-executables.test.mjs \
  scripts/check-third-party-notices.test.mjs \
  scripts/license-policy.test.mjs \
  scripts/pre-push-isolation.test.mjs

say "engine build and prompt synthesis"
node harness/scripts/build-engine.mjs --force
node harness/scripts/build-engine.mjs --check
bash harness/prompts/build.sh
mkdir -p "$HOME/.agents"
ln -sfn "$REPO/harness/prompts" "$HOME/.agents/rubato"

say "rubato-pi unit tests"
export NODE_OPTIONS="--import=file://$REPO/harness/rubato-pi/src/no-changelog-register.mjs"
npm --prefix harness/rubato-pi test
