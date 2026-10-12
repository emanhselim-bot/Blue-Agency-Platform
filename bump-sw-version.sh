#!/usr/bin/env bash
# Bump the service worker version, and fail loudly if it cannot.
#
# This used to be a hand-written sed naming both the old and the new number.
# When another branch moved the version on ahead, the pattern stopped matching
# and the bump became a silent no-op -- three commits in a row claimed to have
# bumped it and had not. A deploy with an unchanged version is invisible: the
# ?b= redirect does not move and an open tab never learns there is new code.
set -euo pipefail
cd "$(dirname "$0")"
cur=$(grep -oE "VERSION *= *'v[0-9]+'" sw.js | grep -oE "v[0-9]+" | head -1)
[ -n "$cur" ] || { echo "could not read the current version from sw.js" >&2; exit 1; }
next="v$(( ${cur#v} + 1 ))"
perl -0pi -e "s/VERSION( *= *)'${cur}'/VERSION\$1'${next}'/" sw.js
got=$(grep -oE "VERSION *= *'v[0-9]+'" sw.js | grep -oE "v[0-9]+" | head -1)
[ "$got" = "$next" ] || { echo "bump failed: still $got" >&2; exit 1; }
echo "sw.js $cur -> $next"
