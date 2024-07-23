const { exec } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const _fs = require("fs");
const os = require("os");
const { findMp4File } = require("./utils");

async function handleVideoRequest(req, res, type) {
  const { movieName, showName, season, episode } = req.params;
  const audioTrackParam = req.query.audio || "stereo"; // Default to "stereo" if no audio track specified

  try {
    let videoPath;
    if (type === "movies") {
	  const directoryPath = path.join("/var/www/html/movies", movieName);
	  videoPath = await findMp4File(directoryPath);
	} else if (type === "tv") {
	  const showsDataRaw = _fs.readFileSync("/var/www/html/tv_list.json", "utf8");
	  const showsData = JSON.parse(showsDataRaw);
	  const showData = showsData[showName];

	  if (!showData) {
		throw new Error(`Show not found: ${showName}`);
	  }

	  const _season = showData.seasons[`Season ${season}`];
	  if (!_season) {
		throw new Error(`Season not found: ${showName} - Season ${season}`);
	  }

	  // Filter out transcoded audio channel files
	  const originalEpisodeFiles = _season.fileNames.filter(
		(fileName) => !fileName.includes("_") && !fileName.includes("ch.mp4")
	  );

	  const _episode = originalEpisodeFiles.find((e) =>
		e.includes(`S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`)
	  );

	  if (!_episode) {
		throw new Error(`Episode not found: ${showName} - Season ${season} Episode ${episode}`);
	  }

	  const directoryPath = path.join("/var/www/html/tv", showName, `Season ${season}`);
	  videoPath = await findMp4File(directoryPath, _episode);
	}

    // Get the available audio tracks
    const audioTracks = await getAudioTracks(videoPath);

    // Determine the selected audio track
    const selectedAudioTrack = audioTrackParam === "max" ? getHighestChannelTrack(audioTracks) : parseInt(audioTrackParam);

    // Get the channel count of the selected audio track
    const channelCount = audioTracks[selectedAudioTrack].channels;

    let modifiedVideoPath;

    if (audioTrackParam === "max" && channelCount === 2) {
      // Use the original video file if audio is set to "max" and channel count is 2
      modifiedVideoPath = videoPath;
      console.log("Using the original video file");
    } else {
      // Generate the modified MP4 file
      modifiedVideoPath = await generateModifiedMp4(videoPath, selectedAudioTrack, channelCount);
    }


    // Serve the video file (either modified or original) with support for range requests
    const stat = await fs.stat(modifiedVideoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      const fileStream = _fs.createReadStream(modifiedVideoPath, {start, end});

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
      });
      _fs.createReadStream(modifiedVideoPath).pipe(res);
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal server error");
  }
}

async function getAudioTracks(videoPath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v quiet -print_format json -show_streams "${videoPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error getting audio tracks: ${error.message}`);
        reject(error);
      } else {
        const output = JSON.parse(stdout);
        const videoStreams = output.streams.filter((stream) => stream.codec_type === "video");
        const audioStreams = output.streams.filter((stream) => stream.codec_type === "audio");

        const videoTrackCount = videoStreams.length;

        const audioTracks = audioStreams.map((stream) => ({
          index: stream.index - videoTrackCount,
          codec: stream.codec_name,
          channels: stream.channels,
        }));

        resolve(audioTracks);
      }
    });
  });
}

function getHighestChannelTrack(audioTracks) {
  let highestChannelTrack = audioTracks[0];
  for (const track of audioTracks) {
    if (track.channels > highestChannelTrack.channels) {
      highestChannelTrack = track;
    }
  }
  return highestChannelTrack.index;
}

async function generateModifiedMp4(videoPath, audioTrack, channelCount) {
  const fileExtension = path.extname(videoPath);
  const fileNameWithoutExtension = path.basename(videoPath, fileExtension);
  const outputFileName = `${fileNameWithoutExtension}_${channelCount}ch${fileExtension}`;
  const outputPath = path.join(path.dirname(videoPath), outputFileName);

  // Check if the output file already exists
  try {
    await fs.access(outputPath);
    console.log(`Modified MP4 file already exists: ${outputPath}`);
    return outputPath;
  } catch (error) {
    // File doesn't exist, proceed with generating it
  }

  return new Promise((resolve, reject) => {
    const ffmpegCommand = `ffmpeg -i "${videoPath}" -map 0:v -map 0:a:${audioTrack} -c copy "${outputPath}"`;

    const ffmpegProcess = exec(ffmpegCommand);

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        console.log(`Modified MP4 saved: ${outputPath}`);
        resolve(outputPath);
      } else {
        console.error(`FFmpeg process exited with code ${code}`);
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });

    ffmpegProcess.on("error", (error) => {
      console.error(`Error generating modified MP4: ${error.message}`);
      reject(error);
    });
  });
}


module.exports = {
  handleVideoRequest,
};
