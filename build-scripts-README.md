# Docker Build Scripts

This directory contains scripts to automate the Docker build and push process for the nextjs-stream-media-processor project.

## Available Scripts

### PowerShell Script (Windows)

`build.ps1` - For Windows environments using PowerShell.

To use:
```powershell
.\build.ps1
```

### Bash Script (Linux/macOS)

`build.sh` - For Linux/macOS environments.

To use:
```bash
# Make the script executable first (one-time setup)
chmod +x build.sh

# Run the script
./build.sh
```

## What These Scripts Do

Both scripts perform the same operations:

1. Generate a date-based version tag in the format YYYY.MM.DD
2. Load environment variables from `.env.local`
3. Build the Docker image with necessary build arguments
4. Tag the image with both the date-based version and 'latest'
5. Push both tags to Docker Hub

## Benefits

- Eliminates the need to manually type the long Docker build command
- Automatically generates the date-based version tag
- Provides consistent build process across different environments
- Includes error checking to ensure each step completes successfully

## Notes

- These scripts assume you're already logged in to Docker Hub (`docker login`)
- The scripts use the environment variables defined in your `.env.local` file
- Both scripts use the `--no-cache` flag to ensure a clean build each time
