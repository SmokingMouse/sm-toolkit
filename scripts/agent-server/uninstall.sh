#!/bin/sh
set -eu
label=com.smokingmouse.agent-server
service="gui/$(id -u)/$label"
if ! launchctl bootout "$service"; then
  # An absent service is already uninstalled. A still-loaded service is an error.
  if launchctl print "$service" >/dev/null 2>&1; then exit 1; fi
fi
# Keep configuration, database, token and logs for recovery. Remove only our plist.
file="$HOME/Library/LaunchAgents/$label.plist"
if [ -f "$file" ]; then mv "$file" "$file.disabled-$(date +%s)"; fi
