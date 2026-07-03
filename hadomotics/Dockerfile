ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.11-alpine3.18
FROM $BUILD_FROM

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY server.py .
COPY static/ static/

# Create data directory
RUN mkdir -p /data/images

EXPOSE 8099

# Use with-contenv wrapper so that SUPERVISOR_TOKEN and other
# Home Assistant addon environment variables are properly populated.
# This fixes service calls and state polling in the configuration panel.
CMD ["/usr/bin/with-contenv", "python", "-u", "server.py"]
