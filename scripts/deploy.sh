echo "Pulling image $IMAGE:$TAG"
#!/usr/bin/env bash
set -euo pipefail

IMAGE=${1:-}
TAG=${2:-}
APP_DIR=${3:-/home/$(whoami)/app}

if [ -z "$IMAGE" ] || [ -z "$TAG" ]; then
  echo "Usage: deploy.sh IMAGE TAG [APP_DIR]"
  exit 2
fi

echo "Deploying $IMAGE:$TAG to $APP_DIR"
cd "$APP_DIR"

# Update .env IMAGE_TAG if present (or append) so server-side compose/template sees new tag
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  echo "Updating $ENV_FILE with IMAGE_TAG=$TAG"
  tmpfile=$(mktemp)
  awk -v tag="$TAG" 'BEGIN{FS=OFS="="} /^IMAGE_TAG=/{print "IMAGE_TAG",tag; next} {print}' "$ENV_FILE" > "$tmpfile" && mv "$tmpfile" "$ENV_FILE"
else
  echo "No .env found at $ENV_FILE, creating with IMAGE_TAG=$TAG"
  echo "IMAGE_TAG=$TAG" > "$ENV_FILE"
fi


# If image is private, ensure the server has already logged into the registry (docker login ghcr.io)
# Pull the specific image tag, then restart the compose stack
echo "Pulling image $IMAGE:$TAG"
docker pull "$IMAGE:$TAG"

# If your docker-compose.yml references the image without a tag, Docker Compose will use the pulled image.
# If docker-compose.yml pins a specific tag, consider templating it on the server.

# Restart services using the pulled image
echo "Bringing up compose stack"
docker compose up -d --remove-orphans

echo "Deployment complete. Containers running from $IMAGE:$TAG:"
docker ps --filter "ancestor=$IMAGE:$TAG" --format "{{.ID}} {{.Image}} {{.Names}}" || true
