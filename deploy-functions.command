#!/bin/bash
#
# Deploy Supabase edge functions straight from this repository.
#
# Why this exists: the functions under supabase/functions are the source of
# truth, but they have been deployed by pasting their contents into a tool.
# That is how notion-sync came to be committed in a state that could not
# compile — the deployed copy was fine, the repository copy was not, and
# nothing compared the two. This uploads the files themselves, so the thing
# running is the thing committed.
#
# One-time setup:
#   npm i -g supabase     (or: brew install supabase/tap/supabase)
#   supabase login
#
# Usage:
#   ./deploy-functions.command                 deploy every function below
#   ./deploy-functions.command notion-sync     deploy just one

set -euo pipefail
cd "$(dirname "$0")"

PROJECT_REF="thtteysputwjiddqchcp"

# notion-sync and telegram-report are called by cron with a shared secret
# rather than a user's login, so they must be deployed with JWT checking off.
# Deploying them without this flag would make the cron start failing with 401.
NO_JWT="notion-sync notion-discover telegram-report"

ALL="notion-sync notion-discover telegram-report meta-data meta-platform"

TARGETS="${*:-$ALL}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "The supabase CLI is not installed. Install it, run 'supabase login', then try again." >&2
  exit 1
fi

for fn in $TARGETS; do
  if [ ! -f "supabase/functions/$fn/index.ts" ]; then
    echo "!! supabase/functions/$fn/index.ts does not exist — skipping" >&2
    continue
  fi

  # A literal backslash-n in the source is the fingerprint of a bad edit: it
  # does not compile, and it is what was committed once already. Refuse rather
  # than deploy something broken.
  if grep -q '\\n' "supabase/functions/$fn/index.ts"; then
    echo "!! supabase/functions/$fn/index.ts contains a literal \\n escape outside a string." >&2
    echo "   That file will not compile. Fix it before deploying." >&2
    exit 1
  fi

  args=(functions deploy "$fn" --project-ref "$PROJECT_REF")
  case " $NO_JWT " in
    *" $fn "*) args+=(--no-verify-jwt) ;;
  esac

  echo "→ deploying $fn ${args[*]: -1}"
  supabase "${args[@]}"
done

echo
echo "Done. Deployed: $TARGETS"
