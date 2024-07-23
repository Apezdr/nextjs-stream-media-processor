#!/bin/bash

base_directories=("/var/www/html/movies" "/var/www/html/tv")

generate_json_file() {
 local file_path="$1"
 local length_ms="$2"
 local base_name=$(basename "$file_path" .mp4) # Get the base name without .mp4 extension
 local json_path="${file_path%.*}.json" # Replace .mp4 with .json

 if [[ -f "$json_path" ]]; then
  return
 fi

 if [[ $length_ms -le 0 ]]; then
  echo "Invalid video length for $base_name"
  return
 fi

 local json_content="[\n"
  
 # Extract the path relative to the base directory (tv or movies)
 local relative_path=${file_path#*"/html/"}
 relative_path=${relative_path%/*} # Remove the filename, keep the path

 local content_type="movie" # Default content type

 # Special handling for TV shows to include show name, season number, and episode name
 if [[ $file_path == *"/tv/"* ]]; then
  content_type="tv"
  local tv_path=${file_path#*"/tv/"}
  local show_name=$(echo "$tv_path" | awk -F/ '{print $1}')
  local season_number=$(echo "$tv_path" | awk -F/ '{print $2}' | grep -oE '[0-9]+')
  local episode_name=$(echo "$tv_path" | awk -F/ '{print $3}' | sed 's/\.mp4$//')
  relative_path="$show_name/$season_number/$episode_name"
 else
  local movie_name=$(basename "$relative_path")
  relative_path="$movie_name"
 fi

 local url_encoded_path=$(urlencode "$relative_path") # URL encode the relative path
 url_encoded_path=${url_encoded_path//%2F/\/} # Replace '%2F' with '/' to maintain path structure in URL

 local base_url="${FILE_SERVER_NODE_URL}/frame/${content_type}/${url_encoded_path}/"
  
 # Set the time interval for frame capture in seconds
 local time_interval_sec=5
 local time_interval_ms=$((time_interval_sec * 1000))

 for ((ms=0; ms<length_ms; ms+=time_interval_ms)); do
  local start_time_sec=$((ms / 1000))
  local end_time_sec=$(((ms + time_interval_ms) / 1000))
  [[ $end_time_sec -gt $((length_ms / 1000)) ]] && end_time_sec=$((length_ms / 1000))

  local thumbnail_url="${base_url}$(printf "%02d:%02d:%02d" $((start_time_sec / 3600)) $(((start_time_sec % 3600) / 60)) $((start_time_sec % 60))).jpg"

  json_content+=" { \"startTime\": $start_time_sec, \"endTime\": $end_time_sec, \"text\": \"$thumbnail_url\" }"
  [[ $((ms + time_interval_ms)) -lt $length_ms ]] && json_content+=",\n" # Add a comma except for the last entry
 done

 json_content+="\n]"
 echo -e "$json_content" > "$json_path"
}

get_video_length() {
 local file_path="$1"
 local length_seconds=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$file_path")
 if ! [[ $length_seconds =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Error: Unable to get the length of the video for $file_path"
  return 0
 fi
 echo $(( $(echo "$length_seconds" | awk '{print int($1*1000)}') ))
}

urlencode() {
  local input=$1
  python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$input"
}

echo "Starting thumbnail generation"
for dir in "${base_directories[@]}"; do
 find "$dir" -type f -name "*.mp4" | while read -r file; do
	if [[ "$file" == *"-TdarrCacheFile-"* ]]; then
	 echo "Skipping cache file: $file"
	 continue # Skip this iteration for cache files
	fi
  json_file="${file%.*}.json" # Correctly replaces .mp4 with .json

  if [[ ! -f "$json_file" ]]; then
   video_length=$(get_video_length "$file")
   if [[ "$video_length" -gt 0 ]]; then
    generate_json_file "$file" "$video_length"
   else
    echo "Skipping $file due to zero or undetectable length."
   fi
  #else
   #echo "JSON file already exists for $file. Skipping..."
  fi
 done
done

echo "Finished thumbnail generation"