#!/bin/sh
# install: ln -s ../../tools/pre-push.sh .git/hooks/pre-push
# a secret scanner before every push: a new hit (not in .secrets.baseline) stops the push
cd "$(git rev-parse --show-toplevel)" || exit 1
git ls-files -z | xargs -0 uvx --quiet --from detect-secrets detect-secrets-hook --baseline .secrets.baseline || {
  echo "pre-push: detect-secrets found something new (above); fix it, or mark a false positive in .secrets.baseline"; exit 1; }
