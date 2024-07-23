# nextjs-stream-media-processor

This application serves as a dynamic backend service for generating and serving video frames, sprite sheets, WebVTT (Video Text Tracks) files, and chapter information. It's designed to handle requests for individual frames from videos stored in specific directories, generate sprite sheets for efficient video preview, and provide audio track selection for video playback.

## Features

- **Frame Extraction:** Dynamically extracts frames from video files based on request parameters.
- **Sprite Sheet Generation:** Creates sprite sheets from video frames for efficient loading and previewing.
- **WebVTT File Creation:** Generates WebVTT files for video previews, allowing for timestamp-based navigation.
- **Cache Management:** Implements caching for generated frames and sprite sheets to enhance performance and reduce processing time.
- **Audio Track Handling:** Supports requests for video files with specific audio tracks, optimizing for different playback scenarios.
- **Chapter Information:** Extracts and serves chapter information from video files.
- **Concurrent Processing:** Utilizes worker processes for efficient frame generation.

## Components

- **app.js:** Main application logic, route handling, and orchestration of various services.
- **chapter-generator.js:** Handles extraction of chapter information and generation of chapter WebVTT files.
- **videoHandler.js:** Manages video serving with custom audio track selection.
- **snapshotWorker.js:** Worker process for concurrent frame generation to improve performance.
- **utils.js:** Utility functions for file operations, frame generation, and other common tasks.

## Prerequisites

- Docker
- Node.js
- FFmpeg: For processing video files, extracting frames, and handling audio tracks.
- PM2: Recommended for process management.

## Installation and Usage

1. Clone the repository:

   ```bash
   git clone https://github.com/your-username/nextjs-stream-media-processor.git
   ```

2. Navigate to the project directory:

   ```bash
   cd nextjs-stream-media-processor
   ```

3. Install the required Node.js packages:

   ```bash
   npm install
   ```

4. Build and run the Docker container:

   ```bash
   docker build -t nextjs-stream-media-processor .
   docker run -d -p 3000:3000 nextjs-stream-media-processor
   ```

   Note: Ensure that port 3000 is allowed on your host machine for proper functionality.

5. Start the application with PM2 for better process management:

   ```bash
   pm2 start
   ```

## API Endpoints

The application exposes the following API endpoints:

- **Frame Request:**
  - Movie: `GET /frame/movie/:movieName/:timestamp.:ext?`
  - TV: `GET /frame/tv/:showName/:season/:episode/:timestamp.:ext?`
- **Sprite Sheet Request:**
  - Movie: `GET /spritesheet/movie/:movieName`
  - TV: `GET /spritesheet/tv/:showName/:season/:episode`
- **WebVTT Request:**
  - Movie: `GET /vtt/movie/:movieName`
  - TV: `GET /vtt/tv/:showName/:season/:episode`
- **Chapter Information Request:**
  - Movie: `GET /chapters/movie/:movieName`
  - TV: `GET /chapters/tv/:showName/:season/:episode`
- **Video Request with Audio Track Selection:**
  - Movie: `GET /video/movie/:movieName?audio=<track>`
  - TV: `GET /video/tv/:showName/:season/:episode?audio=<track>`

## API Endpoint Placeholders

When using the API endpoints, replace the placeholders with actual values:

- `:movieName`: The name of the movie (e.g., "The Matrix" or "The%20Matrix")
- `:showName`: The name of the TV series (e.g., "Breaking Bad")
- `:season`: The season number of the TV show with no padded 0 at the beginning (e.g., "1" for Season 1)
- `:episode`: The two-digit episode number within a season (e.g., "01" or "1" for first episode)
- `:timestamp`: Time in the video for frame extraction (format: "HH:MM:SS" or "HH:MM:SS.mmm")
- `:ext`: Optional file extension for frame images (default is JPG if not specified)
- `<track>`: Use "stereo" for stereo audio or "max" for the track with the most channels

## Configuration

The application uses the following directory structure:

- Movies: `/var/www/html/movies`
- TV Shows: `/var/www/html/tv`

Ensure that your media files are organized accordingly within the Docker container. Modify the `cacheDir` variable in the script `utils.js` to change the directory where generated frames and sprite sheets are stored. The default location is set to a directory within the project (`./cache`).

## Cache Management

The application periodically clears old cache files to free up disk space. Adjust the `CACHE_MAX_AGE` constant to change the maximum age for cache files. This is found inside the `app.js` file.

## Implementation Details

- The application uses FFmpeg for processing video files, extracting frames, and handling audio tracks.
- It implements robust error handling and retries for API requests.
- The caching mechanism improves performance for frequently requested content.
- Worker processes are utilized for concurrent frame generation to enhance efficiency.

## Video Handling

The `handleVideoRequest` function in the Node application dynamically serves video content with the ability to adjust audio tracks based on user requests. It supports serving both movie and TV show video files, optionally modifying them for audio track preferences.

### Key Features

- **Dynamic Video Path Resolution:** Locates video files based on parameters such as movie name, show name, season, and episode.
- **Audio Track Selection:** Allows clients to request specific audio tracks (e.g., stereo or maximum available channels) for a personalized viewing experience.
- **Efficient Content Delivery:** Supports HTTP range requests for efficient video streaming, enabling functionalities like seeking within the video.
- **Error Handling:** Implements robust error handling to gracefully manage cases where video files or audio tracks are unavailable.

### Implementation Details

1. **Video and Audio Track Processing:**
   - Utilizes `ffprobe` to list available audio tracks within the video file, selecting either a specified track or the track with the maximum number of channels.
   - Generates a modified version of the video file with the selected audio track when necessary.

2. **Serving Video Content:**
   - Determines if a request specifies a range for partial content delivery, facilitating efficient video streaming.
   - Serves video content directly from the filesystem, leveraging Node's asynchronous file handling capabilities.

3. **Caching and Performance:**
   - Optionally integrates with server-side caching mechanisms to improve performance for frequently requested content.

### Setup and Configuration

Ensure FFmpeg is installed on your server for audio track manipulation and video file processing. Modify the `directoryPath` variables within the script to match the locations where your video content is stored.

### Integration

This script can be integrated into your existing Node.js web server application or used as a standalone service. Ensure the necessary routes are configured in your Express app to handle requests directed at video content.

### Usage Example

Requesting a video with a specific audio track:

```http
GET /video/movie/TheMatrix?audio=max
```

For more detailed information about the implementation, refer to the source code in the repository.
