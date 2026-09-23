#!/bin/bash
# Push to GitHub — double-click this file.
#
# Railway deploys from the main branch, so pushing is what puts a change live.
#
# This only pushes commits that have already been made. It deliberately does
# not create commits: the previous version of this script ran
#   git add dashboard.html && git commit -m "Fix agency settings..."
# which filed whatever happened to be edited under a message describing a
# change from months earlier.

cd "/Users/emanselim/Desktop/Blue Ad Dashboard Claude Code/blue-agency-platform" || {
  echo "Could not find the project folder."; sleep 6; exit 1;
}

# A crashed git leaves these behind and every later command fails on them.
rm -f .git/index.lock .git/HEAD.lock

echo "════════════════════════════════════════════"
echo "  Blue Ad — push to GitHub"
echo "════════════════════════════════════════════"
echo

git fetch origin main --quiet 2>/dev/null

AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")

if [ "$AHEAD" = "0" ]; then
  echo "Nothing to push — GitHub already has everything."
  echo
  # Uncommitted edits are not an error, but silence about them would be.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Note: you have unsaved edits that are not committed:"
    git status --short
    echo
    echo "Those need committing in GitHub Desktop before they can be pushed."
  fi
  echo "Closing in 8 seconds."
  sleep 8
  exit 0
fi

if [ "$BEHIND" != "0" ] && [ "$BEHIND" != "?" ]; then
  echo "Careful: GitHub has $BEHIND commit(s) you do not have locally."
  echo "Pull in GitHub Desktop first, or this push will be rejected."
  echo
fi

echo "$AHEAD commit(s) to push:"
echo
git log --oneline origin/main..HEAD | sed 's/^/   /'
echo

echo "Pushing…"
git push origin main
RESULT=$?
echo

if [ $RESULT -eq 0 ]; then
  echo "✓ Pushed. Railway redeploys in about a minute or two."
  echo
  echo "  Then hard-reload the dashboard:  Cmd + Shift + R"
  echo "  In the installed app: close it fully and reopen."
  echo
  echo "Closing in 10 seconds."
  sleep 10
else
  echo "✗ Push failed (exit $RESULT)."
  echo
  echo "Most likely the saved GitHub sign-in has expired."
  echo "Open GitHub Desktop and press Push there — it will prompt you to"
  echo "sign in again, and this script will work afterwards."
  echo
  echo "This window stays open so you can read the error above."
  read -r -p "Press Return to close."
fi
