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
# tiktok-oauth is a browser redirect target: TikTok sends the user back to it
# with no Authorization header, so JWT checking would reject the callback. It
# does its own auth instead -- every route verifies org membership before it
# touches anything.
NO_JWT="notion-sync notion-discover telegram-report tiktok-oauth notion-tasks-sync"

ALL="notion-sync notion-discover telegram-report meta-data meta-platform tiktok-ads-data tiktok-oauth notion-tasks-sync"

TARGETS="${*:-$ALL}"

# A global install is nicer, but npx works too, so not having run the install
# is not a reason to stop.
if command -v supabase >/dev/null 2>&1; then
  SUPABASE=(supabase)
elif command -v npx >/dev/null 2>&1; then
  echo "(supabase CLI not installed globally — using npx)"
  SUPABASE=(npx --yes supabase@latest)
else
  echo "Neither the supabase CLI nor npx is available." >&2
  echo "Install one (npm i -g supabase), run 'supabase login', then try again." >&2
  exit 1
fi

for fn in $TARGETS; do
  if [ ! -f "supabase/functions/$fn/index.ts" ]; then
    echo "!! supabase/functions/$fn/index.ts does not exist — skipping" >&2
    continue
  fi

  # Parse the file before uploading it. notion-sync was once committed with a
  # literal backslash-n where a newline belonged -- a syntax error that nothing
  # caught, because the deployed copy had been pasted in separately and was
  # fine. A grep for that escape is not the check to make: "\n" inside a string
  # is perfectly ordinary, and telegram-report has several. Parsing is.
  if command -v deno >/dev/null 2>&1; then
    if ! deno check --no-lock "supabase/functions/$fn/index.ts"; then
      echo "!! $fn does not type-check. Not deploying it." >&2
      exit 1
    fi
  elif command -v npx >/dev/null 2>&1; then
    # No Deno available, so check syntax only: tsc cannot resolve the https
    # imports or the Deno global, and those errors are expected here.
    errs=$(npx --yes tsc --noEmit --target es2022 --module esnext \
             --moduleResolution bundler --skipLibCheck --noResolve \
             "supabase/functions/$fn/index.ts" 2>&1 \
           | grep -v "Cannot find module" | grep -v "Cannot find name 'Deno'" || true)
    if [ -n "$errs" ]; then
      echo "!! $fn does not parse:" >&2
      echo "$errs" >&2
      exit 1
    fi
  else
    echo "   (no deno or npx found — skipping the parse check)"
  fi

  args=(functions deploy "$fn" --project-ref "$PROJECT_REF")
  case " $NO_JWT " in
    *" $fn "*) args+=(--no-verify-jwt) ;;
  esac

  echo "→ deploying $fn"
  "${SUPABASE[@]}" "${args[@]}"
done

echo
echo "Done. Deployed: $TARGETS"
