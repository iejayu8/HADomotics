#!/usr/bin/with-contenv bashio

# This is the recommended startup script for Home Assistant Python addons.
# It ensures SUPERVISOR_TOKEN and other environment variables are correctly set.

# Direct host access is off unless the user opts in. Ingress does not need it.
if bashio::config.true 'allow_direct_access'; then
    export ALLOW_DIRECT_ACCESS=true
else
    export ALLOW_DIRECT_ACCESS=false
fi

if bashio::config.exists 'cors_origins'; then
    export CORS_ORIGINS="$(bashio::config 'cors_origins')"
else
    export CORS_ORIGINS=""
fi

exec python -u server.py
