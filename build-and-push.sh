#!/bin/sh

# Set your Docker Hub username and access token here
# or as environment variables
: "${DOCKERHUB_USERNAME?Please set DOCKERHUB_USERNAME}"
: "${DOCKERHUB_ACCESS_TOKEN?Please set DOCKERHUB_ACCESS_TOKEN}"

IMAGE_NAME="s3-admin"
TAG="latest"

# Login to Docker Hub
echo "${DOCKERHUB_ACCESS_TOKEN}" | docker login -u "${DOCKERHUB_USERNAME}" --password-stdin

# Build and push the image
docker buildx build --platform linux/amd64 -t "${DOCKERHUB_USERNAME}/${IMAGE_NAME}:${TAG}" --push .

echo "Image pushed to ${DOCKERHUB_USERNAME}/${IMAGE_NAME}:${TAG}"
