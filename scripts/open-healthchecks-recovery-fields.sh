#!/usr/bin/env bash

set -euo pipefail

recovery_token="$(security find-generic-password \
  -s pragma-publications \
  -a recovery-token \
  -w)"

browser_user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

printf '%s\n' \
  "Authorization: Bearer ${recovery_token}" \
  "User-Agent: ${browser_user_agent}" \
  | code --new-window -
