ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.11-alpine3.18
FROM $BUILD_FROM

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY server.py .
COPY static/ static/
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# Create data directory
RUN mkdir -p /data/images

EXPOSE 8099

# Use the standard HA addon startup script.
# This ensures SUPERVISOR_TOKEN and other env vars are properly set via with-contenv + bashio.
CMD [ "/run.sh" ]
