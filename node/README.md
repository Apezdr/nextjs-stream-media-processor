# nextjs-stream-media-processor

This application serves as a dynamic backend service for generating and serving video frames, sprite sheets, WebVTT (Video Text Tracks) files, and chapter information. It's designed to handle requests for individual frames from videos stored in specific directories, generate sprite sheets for efficient video preview, and encode short preview clips.

## Features

- **Frame Extraction:** Dynamically extracts frames from video files based on request parameters.
- **Sprite Sheet Generation:** Creates sprite sheets from video frames for efficient loading and previewing.
- **WebVTT File Creation:** Generates WebVTT files for video previews, allowing for timestamp-based navigation.
- **Cache Management:** Implements caching for generated frames and sprite sheets to enhance performance and reduce processing time.
- **Chapter Information:** Extracts and serves chapter information from video files.
- **Concurrent Processing:** Utilizes worker processes for efficient frame generation.

## Components

- **app.mjs:** Main application logic, route handling, and orchestration of various services.
- **chapter-generator.js:** Handles extraction of chapter information and generation of chapter WebVTT files.
- **videoHandler.mjs:** Serves `/videoClip` preview clips.
- **utils.js:** Utility functions for file operations, frame generation, and other common tasks.

## Prerequisites

- Docker
- Node.js
- FFmpeg: For processing video files, extracting frames, and encoding preview clips.
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

- The application uses FFmpeg for processing video files, extracting frames, and encoding preview clips.
- It implements robust error handling and retries for API requests.
- The caching mechanism improves performance for frequently requested content.
- Worker processes are utilized for concurrent frame generation to enhance efficiency.

## Video Clips

`/videoClip/...?start=<s>&end=<s>` makes a bounded preview clip (at most 10 minutes) and caches it. Unless the URL says otherwise a clip is H.264 + AAC stereo in a faststart MP4, at most 1280x720, which plays on practically any device, an iPhone included; HDR and Dolby Vision sources are tone-mapped to SDR. The clip starts exactly at `start`.

`&quality=` picks how much picture the clip carries. Each level is cached separately, and a value other than these three is a 400:

| `quality` | Picture | Video | Audio | A 50 s clip (dark film / clean digital / 2160p HDR) |
|---|---|---|---|---|
| `high` (default) | inside 1280x720 | CRF 23, at most 2 Mb/s | 128 kb/s | 2.1 / 7.8 / 8.9 MB |
| `medium` | inside 1280x720 | CRF 28, at most 1.2 Mb/s | 96 kb/s | 1.3 / 4.1 / 4.7 MB |
| `low` | inside 854x480 | CRF 30, at most 600 kb/s | 64 kb/s | 0.7 / 2.0 / 2.2 MB |

`&codec=av1` asks for the same clip as AV1 (still MP4, same audio, same quality levels). It is 20-40% smaller: the same three clips come to 1.3 / 6.1 / 6.3 MB at `high`, 0.9 / 2.9 / 2.7 MB at `medium` and 0.6 / 1.5 / 1.4 MB at `low`. Not every browser plays AV1, so a page should list the AV1 URL first and the plain URL second and let the browser choose:

```html
<video>
  <source src=".../videoClip/movie/A Film?start=3200&end=3250&codec=av1" type='video/mp4; codecs="av01.0.05M.08, mp4a.40.2"'>
  <source src=".../videoClip/movie/A Film?start=3200&end=3250">
</video>
```

`codec=h264` and `codec=auto` both mean the default. Any other value is a 400, and so is `codec=av1` on a server whose ffmpeg has no working AV1 encoder, which sends a browser on to the next source.

AV1 is encoded in software (SVT-AV1) unless the GPU is opted in to. An Intel GPU's AV1 encoder (Quick Sync) can do the work instead, either for one request with `&encoder=gpu`, or by default with `VIDEO_CLIP_AV1_ENCODER=gpu` (`&encoder=software` then opts a request back out). Where there is no such GPU, or its encode fails, the clip is made in software: asking for the GPU never costs a clip. The GPU has no bitrate ceiling on this driver, so its clips of very grainy film run larger than the software encoder's. `encoder` applies to `codec=av1` only; with anything else it is a 400. A URL that names an encoder gets that encoder's clip; one that does not takes whichever AV1 clip is already cached, so changing the default re-encodes nothing.

`&useOriginalVideo=true` asks for the source's own picture instead (at most 2 minutes): the video stream is copied into MP4 and the audio re-encoded to AAC stereo. A copy has to begin on a keyframe, so this clip starts at the last keyframe at or before `start`. Sources that cannot be copied this way (anything other than 8-bit H.264 or 8/10-bit HEVC, and Dolby Vision that needs its RPU) get the encoded clip, at the `quality` the URL asks for. A copy itself has no quality levels.

`VIDEO_CLIP_CONCURRENCY` sets how many clips are encoded at once (default: one per eight logical CPUs, between 2 and 4), GPU encodes included. Full-length playback and transcoding are not served from here: the JIT transcoder (`jit-transcoder` repo) owns them.

For more detailed information about the implementation, refer to the source code in the repository.
