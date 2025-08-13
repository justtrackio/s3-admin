#!/bin/sh

# Start the backend in the background
/app/main &

# Start a simple caddy server for the frontend
caddy file-server --listen :8080 --root /app/frontend/dist
