## Environment Variables

- TMDB_API_KEY=<your_tmdb_api_key>
- FILE_SERVER_NODE_URL=<your_file_server_url>
- FRONT_END=<your_frontend_url>
- WEBHOOK_ID=<your_webhook_id>
- MONGODB_URI=<mongodb_uri>
- TZ=America/New_York
# Node.js
- BASE_PATH=<your_base_path>
- LOG_PATH=<your_log_path>
- DEBUG=TRUE  # Set this to TRUE to enable debugging logs, or omit it/set to false to disable logging


### Example build command:

# Windows:
```
Get-Content .env.local | ForEach-Object { if ($_ -notmatch '^#' -and $_ -match '=') { $name, $value = $_ -split '=', 2; Set-Item -Path "Env:$name" -Value ($value.Trim()) } } ; docker build --build-arg DEBUG=${env:DEBUG} --build-arg TMDB_API_KEY=${env:TMDB_API_KEY} --build-arg FILE_SERVER_NODE_URL=${env:FILE_SERVER_NODE_URL} --build-arg FRONT_END=${env:FRONT_END} --build-arg WEBHOOK_ID=${env:WEBHOOK_ID} --build-arg MONGODB_URI=${env:MONGODB_URI} --build-arg TZ=${env:TZ} --build-arg BASE_PATH=${env:BASE_PATH} --build-arg LOG_PATH=${env:LOG_PATH} -t membersolo/nextjs-stream-media-processor:2024.11.12 -t membersolo/nextjs-stream-media-processor:latest . ; docker push membersolo/nextjs-stream-media-processor:2024.11.12 ; docker push membersolo/nextjs-stream-media-processor:latest
```

# Linux:
```
export $(grep -v '^#' .env.local | xargs) && \
docker build \
  --build-arg DEBUG="$DEBUG" \
  --build-arg TMDB_API_KEY="$TMDB_API_KEY" \
  --build-arg FILE_SERVER_NODE_URL="$FILE_SERVER_NODE_URL" \
  --build-arg FRONT_END="$FRONT_END" \
  --build-arg WEBHOOK_ID="$WEBHOOK_ID" \
  --build-arg MONGODB_URI="$MONGODB_URI" \
  --build-arg TZ="$TZ" \
  --build-arg BASE_PATH="$BASE_PATH" \
  --build-arg LOG_PATH="$LOG_PATH" \
  -t membersolo/nextjs-stream-media-processor:2024.11.12 \
  -t membersolo/nextjs-stream-media-processor:latest . && \
docker push membersolo/nextjs-stream-media-processor:2024.11.12 && \
docker push membersolo/nextjs-stream-media-processor:latest
```