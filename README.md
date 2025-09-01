## Environment Variables

- TMDB_API_KEY=<your_tmdb_api_key>
- FILE_SERVER_NODE_URL=<your_file_server_url>
- FRONT_END_1=<your_frontend_url>
- WEBHOOK_ID_1=<your_webhook_id>
- MONGODB_URI=<mongodb_uri>
- TZ=America/New_York
# Node.js
- BASE_PATH=<your_base_path>
- LOG_PATH=<your_log_path>
- DEBUG=TRUE  # Set this to TRUE to enable debugging logs, or omit it/set to false to disable logging

### AVIF Configuration (for low-resource servers)

- ENABLE_AVIF_CONVERSION=false  # Disable AVIF conversion to prevent server stalls on low-resource servers
- AVIF_CONCURRENCY=1  # Limit concurrent AVIF conversions (default: 1, recommended for most servers)

**Note for low-resource servers:** Set `ENABLE_AVIF_CONVERSION=false` to disable resource-intensive AVIF conversion. The system will automatically fall back to optimized PNG sprite sheets, which provide excellent quality with significantly lower CPU and memory usage. But higher frontend/browser memory requirements for spritesheets.

### Multi-Frontend Support

For setups with multiple frontends, you can use numbered environment variables:

```
FRONT_END_1=https://subdomain.your-domain.com
WEBHOOK_ID_1=321f131x45912w4d9b8c1q1bbd76c9k
FRONT_END_2=http://localhost:3232
WEBHOOK_ID_2=o4jsi82ksjLowQ910PXosEas5S0eopqS
```

See [.env.example](.env.example) for a complete configuration example.


## Features

- **Media Processing**: Generate sprite sheets, extract frames, and handle video transcoding
- **Metadata Management**: Extract and manage detailed metadata about media files
- **System Status Monitoring**: Track resource usage and notify frontends about system load issues
- **Webhook Authentication**: Secure communication between backend and frontends

### System Status Monitoring

This server includes a system status monitoring module that:
- Tracks CPU, memory, and disk usage
- Classifies system health (normal, elevated, heavy, critical)
- Sends push notifications when system load is high
- Provides a REST API for checking system status

For details, see [System Status Documentation](docs/SYSTEM_STATUS.md).

### Example build command:

# Windows:
```
Get-Content .env.local | ForEach-Object { if ($_ -notmatch '^#' -and $_ -match '=') { $name, $value = $_ -split '=', 2; Set-Item -Path "Env:$name" -Value ($value.Trim()) } } ; docker build --build-arg DEBUG=${env:DEBUG} --build-arg TMDB_API_KEY=${env:TMDB_API_KEY} --build-arg FILE_SERVER_NODE_URL=${env:FILE_SERVER_NODE_URL} --build-arg FRONT_END_1=${env:FRONT_END_1} --build-arg WEBHOOK_ID_1=${env:WEBHOOK_ID_1} --build-arg MONGODB_URI=${env:MONGODB_URI} --build-arg TZ=${env:TZ} --build-arg BASE_PATH=${env:BASE_PATH} --build-arg LOG_PATH=${env:LOG_PATH} -t membersolo/nextjs-stream-media-processor:2024.11.12 -t membersolo/nextjs-stream-media-processor:latest . ; docker push membersolo/nextjs-stream-media-processor:2024.11.12 ; docker push membersolo/nextjs-stream-media-processor:latest
```

# Linux:
```
export $(grep -v '^#' .env.local | xargs) && \
docker build \
  --build-arg DEBUG="$DEBUG" \
  --build-arg TMDB_API_KEY="$TMDB_API_KEY" \
  --build-arg FILE_SERVER_NODE_URL="$FILE_SERVER_NODE_URL" \
  --build-arg FRONT_END_1="$FRONT_END_1" \
  --build-arg WEBHOOK_ID_1="$WEBHOOK_ID_1" \
  --build-arg MONGODB_URI="$MONGODB_URI" \
  --build-arg TZ="$TZ" \
  --build-arg BASE_PATH="$BASE_PATH" \
  --build-arg LOG_PATH="$LOG_PATH" \
  -t membersolo/nextjs-stream-media-processor:2024.11.12 \
  -t membersolo/nextjs-stream-media-processor:latest . && \
docker push membersolo/nextjs-stream-media-processor:2024.11.12 && \
docker push membersolo/nextjs-stream-media-processor:latest
```
