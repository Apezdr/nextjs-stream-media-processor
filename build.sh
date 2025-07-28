#!/bin/bash
# build.sh
# Script to automate Docker build and push for nextjs-stream-media-processor

# Generate date-based version tag in format YYYY.MM.DD
DATE=$(date +"%Y.%m.%d")
VERSION="membersolo/nextjs-stream-media-processor:$DATE"
LATEST="membersolo/nextjs-stream-media-processor:latest"

echo -e "\e[36mBuilding Docker image with tags: $VERSION and $LATEST\e[0m"

# Load environment variables from .env.local
echo -e "\e[36mLoading environment variables from .env.local...\e[0m"
export $(grep -v '^#' .env.local | xargs)

# Build the Docker image
echo -e "\e[36mBuilding Docker image...\e[0m"
docker build --no-cache \
  --build-arg DEBUG=${DEBUG} \
  --build-arg TMDB_API_KEY=${TMDB_API_KEY} \
  --build-arg FILE_SERVER_NODE_URL=${FILE_SERVER_NODE_URL} \
  --build-arg FRONT_END_1=${FRONT_END_1} \
  --build-arg WEBHOOK_ID_1=${WEBHOOK_ID_1} \
  --build-arg MONGODB_URI=${MONGODB_URI} \
  --build-arg TZ=${TZ} \
  --build-arg BASE_PATH=${BASE_PATH} \
  --build-arg LOG_PATH=${LOG_PATH} \
  --build-arg FFMPEG_CONCURRENCY=${FFMPEG_CONCURRENCY} \
  --build-arg PREFIX_PATH=${PREFIX_PATH} \
  -t $VERSION -t $LATEST .

# Check if build was successful
if [ $? -ne 0 ]; then
    echo -e "\e[31mDocker build failed\e[0m"
    exit 1
fi

# Push the images to Docker Hub
echo -e "\e[36mPushing images to Docker Hub...\e[0m"
docker push $VERSION
if [ $? -ne 0 ]; then
    echo -e "\e[31mFailed to push $VERSION to Docker Hub\e[0m"
    exit 1
fi

docker push $LATEST
if [ $? -ne 0 ]; then
    echo -e "\e[31mFailed to push $LATEST to Docker Hub\e[0m"
    exit 1
fi

echo -e "\e[32mSuccessfully built and pushed Docker images:\e[0m"
echo -e "\e[32m  - $VERSION\e[0m"
echo -e "\e[32m  - $LATEST\e[0m"
