# build.ps1
# Script to automate Docker build and push for nextjs-stream-media-processor

# Generate date-based version tag in format YYYY.MM.DD
$date = Get-Date -Format "yyyy.MM.dd"
$version = "membersolo/nextjs-stream-media-processor:$date"
$latest = "membersolo/nextjs-stream-media-processor:latest"

Write-Host "Building Docker image with tags: $version and $latest" -ForegroundColor Cyan

# Load environment variables from .env.local
Write-Host "Loading environment variables from .env.local..." -ForegroundColor Cyan
Get-Content .env.local | ForEach-Object { 
    if ($_ -notmatch '^#' -and $_ -match '=') { 
        $name, $value = $_ -split '=', 2
        Set-Item -Path "Env:$name" -Value ($value.Trim()) 
    } 
}

# Build the Docker image
Write-Host "Building Docker image..." -ForegroundColor Cyan
docker build --no-cache `
  --build-arg DEBUG=${env:DEBUG} `
  --build-arg TMDB_API_KEY=${env:TMDB_API_KEY} `
  --build-arg FILE_SERVER_NODE_URL=${env:FILE_SERVER_NODE_URL} `
  --build-arg FRONT_END_1=${env:FRONT_END_1} `
  --build-arg WEBHOOK_ID_1=${env:WEBHOOK_ID_1} `
  --build-arg MONGODB_URI=${env:MONGODB_URI} `
  --build-arg TZ=${env:TZ} `
  --build-arg BASE_PATH=${env:BASE_PATH} `
  --build-arg LOG_PATH=${env:LOG_PATH} `
  --build-arg FFMPEG_CONCURRENCY=${env:FFMPEG_CONCURRENCY} `
  --build-arg PREFIX_PATH=${env:PREFIX_PATH} `
  -t $version -t $latest .

# Check if build was successful
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker build failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

# Push the images to Docker Hub
Write-Host "Pushing images to Docker Hub..." -ForegroundColor Cyan
docker push $version
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to push $version to Docker Hub" -ForegroundColor Red
    exit $LASTEXITCODE
}

docker push $latest
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to push $latest to Docker Hub" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Successfully built and pushed Docker images:" -ForegroundColor Green
Write-Host "  - $version" -ForegroundColor Green
Write-Host "  - $latest" -ForegroundColor Green
