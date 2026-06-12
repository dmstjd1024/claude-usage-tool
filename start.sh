#!/bin/bash
# Move to this script's directory so it works regardless of where the repo lives.
cd "$(dirname "$0")"

# Use the node version managed by nvm when available, otherwise fall back to the
# system node already on PATH. NVM_DIR defaults to ~/.nvm if not exported.
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  # Prefer .nvmrc if present, else the user's default alias.
  if [ -f .nvmrc ]; then
    nvm use
  else
    nvm use default
  fi
fi

npm run electron:dev
