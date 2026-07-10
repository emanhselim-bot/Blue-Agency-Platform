#!/bin/bash
cd "/Users/emanselim/Desktop/Claude Code/blue-agency-platform"

# Remove any stale git lock files
rm -f .git/index.lock .git/HEAD.lock

# Ask for GitHub Personal Access Token
TOKEN=$(osascript -e 'display dialog "Paste your GitHub Personal Access Token (ghp_...):" default answer "" with hidden answer buttons {"Cancel","Push"} default button "Push"' -e 'text returned of result' 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Cancelled."
  sleep 2
  exit 1
fi

# Embed token in remote URL for this push only
git remote set-url origin "https://emanhselim-bot:${TOKEN}@github.com/emanhselim-bot/Blue-Agency-Platform.git"

echo "Pushing to GitHub..."
git push origin main
RESULT=$?

# Reset URL (strip token from config)
git remote set-url origin "https://github.com/emanhselim-bot/Blue-Agency-Platform.git"

if [ $RESULT -eq 0 ]; then
  echo ""
  echo "Done! Railway will redeploy in ~1-2 minutes."
else
  echo ""
  echo "Push failed. Check your token and try again."
fi

echo "This window will close in 5 seconds."
sleep 5
