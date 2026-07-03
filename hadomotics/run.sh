#!/usr/bin/with-contenv bashio

# This is the recommended startup script for Home Assistant Python addons.
# It ensures SUPERVISOR_TOKEN and other environment variables are correctly set.

exec python -u server.py
