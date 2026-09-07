#!/bin/sh
set -eu
label=com.smokingmouse.agent-server
launchctl bootout "gui/$(id -u)/$label"
# Keep configuration, database, token and logs for recovery. Remove only our plist.
file="$HOME/Library/LaunchAgents/$label.plist"
if [ -f "$file" ]; then mv "$file" "$file.disabled-$(date +%s)"; fi
