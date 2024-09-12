#!/bin/bash

BASE_PATH="/var/www/html"

declare -A langMap
langMap["en"]="English"
langMap["eng"]="English"  # Adding 'eng' as another key for English
langMap["es"]="Spanish"
langMap["tl"]="Tagalog"
langMap["zh"]="Chinese"
langMap["cs"]="Czech"
langMap["da"]="Danish"
langMap["nl"]="Dutch"
langMap["fi"]="Finnish"
langMap["fr"]="French"
langMap["de"]="German"
langMap["el"]="Greek"
langMap["hu"]="Hungarian"
langMap["it"]="Italian"
langMap["ja"]="Japanese"
langMap["ko"]="Korean"
langMap["no"]="Norwegian"
langMap["pl"]="Polish"
langMap["pt"]="Portuguese"
langMap["ro"]="Romanian"
langMap["sk"]="Slovak"
langMap["sv"]="Swedish"
langMap["tr"]="Turkish"
langMap["chi"]="Chinese"
langMap["cze"]="Czech"
langMap["dan"]="Danish"
langMap["dut"]="Dutch"
langMap["fin"]="Finnish"
langMap["fre"]="French"
langMap["ger"]="German"
langMap["gre"]="Greek"
langMap["hun"]="Hungarian"
langMap["ita"]="Italian"
langMap["jpn"]="Japanese"
langMap["kor"]="Korean"
langMap["nor"]="Norwegian"
langMap["pol"]="Polish"
langMap["por"]="Portuguese"
langMap["rum"]="Romanian"
langMap["slo"]="Slovak"
langMap["swe"]="Swedish"
langMap["tur"]="Turkish"


declare -A langCodeMap
langCodeMap["eng"]="en"
langCodeMap["en"]="en"
langCodeMap["spa"]="es"
langCodeMap["tl"]="tl"
langCodeMap["chi"]="zh"
langCodeMap["cze"]="cs"
langCodeMap["dan"]="da"
langCodeMap["dut"]="nl"
langCodeMap["fin"]="fi"
langCodeMap["fre"]="fr"
langCodeMap["ger"]="de"
langCodeMap["gre"]="el"
langCodeMap["hun"]="hu"
langCodeMap["ita"]="it"
langCodeMap["jpn"]="ja"
langCodeMap["kor"]="ko"
langCodeMap["nor"]="no"
langCodeMap["pol"]="pl"
langCodeMap["por"]="pt"
langCodeMap["rum"]="ro"
langCodeMap["slo"]="sk"
langCodeMap["swe"]="sv"
langCodeMap["tur"]="tr"


urlencode() {
    local input=$1
    python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$input"
}

get_stored_blurhash() {
    local image_path="$1"
    local blurhash_file="${image_path}.blurhash"
    local encoded_path=""
    local path_component
    local IFS='/'

    # Split the path and encode each directory name
    read -ra ADDR <<< "$image_path"
    for path_component in "${ADDR[@]}"; do
        # Encode each component except the last one (filename)
        if [[ "$path_component" != "${ADDR[-1]}" ]]; then
            encoded_path+=$(urlencode "$path_component")"/"
        else
            # Do not encode the last component (file name)
            encoded_path+="$path_component"
        fi
    done

    # Add the BASE_PATH and .blurhash extension for the final relative path
    local relative_blurhash_path="${encoded_path}.blurhash"
    local relative_path="${relative_blurhash_path#$BASE_PATH}"

    if [[ -f "$blurhash_file" ]]; then
        echo "$relative_path"
    else
        # Generate a new blurhash using the full image path
        local blurhash_output=$(python3 /usr/src/app/blurhash_cli.py "$image_path" 2>&1)
        local exit_status=$?

        if [[ $exit_status -ne 0 ]]; then
            echo "Error generating blurhash: $blurhash_output" >&2
            return $exit_status
        fi

        # Write the generated blurhash to a file
        echo "$blurhash_output" > "$blurhash_file"
        echo "$relative_path"
    fi
}


generate_list_movies() {
    local dir_path="$1"
    local output_file="$2"
    local temp_file=$(mktemp)
    echo "{" > "$temp_file"
    local IFS=$'\n'
    local dirs=($(find "$dir_path" -mindepth 1 -type d -not -path "*/chapters*" | sort))
    local last_dir_index=$((${#dirs[@]} - 1))

    for i in "${!dirs[@]}"; do
        local dir="${dirs[$i]}"
        local dir_name="$(basename "$dir")"
		local urlEncoded_dir_name=$(urlencode "$dir_name")
        echo "\"$dir_name\": {" >> "$temp_file"
        local files=($(find "$dir" -mindepth 1 -maxdepth 2 -type f | sort))
        local last_file_index=$((${#files[@]} - 1))

        # File names
        echo "  \"fileNames\": [" >> "$temp_file"
        for j in "${!files[@]}"; do
            local file="${files[$j]}"
            local filename=$(basename "$file")
            echo -n "    \"$filename\"" >> "$temp_file"
            if [[ $j -ne $last_file_index ]]; then
                echo "," >> "$temp_file"
            else
                echo "" >> "$temp_file"
            fi
        done
        echo "  ]," >> "$temp_file"

        # Lengths and dimensions
        local fileLengths=()
        local fileDimensions=()
        for file in "${files[@]}"; do
            local filename=$(basename "$file")
            if [[ $filename == *".mp4" && $filename != *"-TdarrCacheFile-"* ]]; then
                local info_file="${file}.info"
                if [[ -f "$info_file" ]]; then
                    local file_info=$(cat "$info_file")
                    local file_length=$(echo "$file_info" | cut -d ' ' -f 1)
                    local file_dimensions=$(echo "$file_info" | cut -d ' ' -f 2)
                else
                    local length=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$file" | awk '{print int($1 * 1000)}')
                    local dimensions=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$file")
                    if [[ -n "$length" && -n "$dimensions" ]]; then
                        file_length=$length
                        file_dimensions=$dimensions
                        echo "$length $dimensions" > "$info_file"
                    else
						# Defaults, probably should skip the file if it can't
						# determine the length/dimensions
                        file_length=120000
                        file_dimensions="1920x1080"
                    fi
                fi
                fileLengths+=("\"$filename\": $file_length")
                fileDimensions+=("\"$filename\": \"$file_dimensions\"")
            fi
        done
        echo "  \"length\": { $(IFS=, ; echo "${fileLengths[*]}") }," >> "$temp_file"
        echo "  \"dimensions\": { $(IFS=, ; echo "${fileDimensions[*]}") }," >> "$temp_file"

        # URLs
        echo "  \"urls\": {" >> "$temp_file"
        local url_entries=()

        for j in "${!files[@]}"; do
            local file="${files[$j]}"
			local mediaFile_last_modified_date=$(date -r "$file" +"%Y-%m-%dT%H:%M:%S.%3NZ")
            local filename=$(basename "$file")
            local fileurl="/movies/$urlEncoded_dir_name/$(urlencode "$filename")"
            fileurl=${fileurl// /%20}
            local base_filename="${filename%.*}"

            if [[ $filename == *".mp4" && $filename != *"-TdarrCacheFile-"* ]]; then
                local entry="\"mp4\": \"$fileurl\","
				local entry+="\"mediaLastModified\": \"$mediaFile_last_modified_date\""
                local found_thumbnail=0
                for k in "${files[@]}"; do
                    local thumb_filename=$(basename "$k")
                    local thumb_base="${thumb_filename%.*}"
                    if [[ $thumb_filename == *".json" && $thumb_base == $base_filename ]]; then
                        local thumb_url="/movies/$urlEncoded_dir_name/$(urlencode "$thumb_filename")"
                        thumb_url=${thumb_url// /%20}
                        entry+=", \"thumbnails\": \"$thumb_url\""
                        found_thumbnail=1
                        break
                    fi
                done
                if [[ $found_thumbnail -eq 0 ]]; then
                    entry+=", \"thumbnails\": null"
                fi
				# Chapter handling
				local chapter_file="$dir_path/$dir_name/chapters/${base_filename}_chapters.vtt"
				if [[ -f "$chapter_file" ]]; then
					local urlencoded_chapter_filename=$(urlencode "$(basename "$chapter_file")")
					local chapter_url="/movies/$urlEncoded_dir_name/chapters/$urlencoded_chapter_filename"
					chapter_url=${chapter_url// /%20}
					entry+=", \"chapters\": \"$chapter_url\""
				fi

				url_entries+=("$entry")
            fi
			if [[ $filename == "poster.jpg" ]]; then
				local poster_path="$dir_path/$dir_name/$filename"
				local encoded_poster_path="/movies/$urlEncoded_dir_name/$filename"
				local poster_blurhash=""
				if [[ -f "$poster_path" ]]; then
					poster_blurhash=$(get_stored_blurhash "$poster_path")
				fi
				url_entries+=("\"poster\": \"$encoded_poster_path\", \"posterBlurhash\": \"$poster_blurhash\"")
			fi
			local backdrop_path=""
			local urlEncoded_backdrop_path=""
			local backdrop_blurhash=""
			if [[ $base_filename == "backdrop" ]]; then
				for ext in jpg png gif; do
					if [[ -f "$dir_path/$dir_name/backdrop.$ext" ]]; then
						backdrop_path="$dir_path/$dir_name/$filename"
						urlEncoded_backdrop_path="/movies/$urlEncoded_dir_name/backdrop.$ext"
						backdrop_blurhash=$(get_stored_blurhash "$backdrop_path")
						break
					fi
				done
			fi
			# Include backdrop if exists and the blurhash exist
			if [[ -n "$backdrop_blurhash" ]]; then
				url_entries+=("\"backdrop\": \"$urlEncoded_backdrop_path\", \"backdropBlurhash\": \"$backdrop_blurhash\"")
			fi
        done

        # Populate the subtitle_files array for the current movie
        local subtitle_files=($(find "$dir" -type f -name "*.srt"))
        local subtitles_json="\"subtitles\": {"
        local subtitle_count=0

        local english_subtitles=()
		local spanish_subtitles=()
		local tagalog_subtitles=()
		local other_subtitles=()

		for subtitle_file in "${subtitle_files[@]}"; do
			local subtitle_filename=$(basename "$subtitle_file")
			local urlencoded_subtitle=$(urlencode "$subtitle_filename")
			local subtitle_lang_code=$(echo "$subtitle_filename" | grep -oE '\.[a-zA-Z]+(\.[a-zA-Z]+)?\.srt$' | cut -d '.' -f 2)
			local subtitle_type=$(echo "$subtitle_filename" | grep -oE '\.[a-zA-Z]+(\.[a-zA-Z]+)?\.srt$' | cut -d '.' -f 3)

			if [[ -z "$subtitle_lang_code" ]]; then
				echo "Warning: No language code found for subtitle file $subtitle_filename. Skipping."
				continue
			fi

			local two_letter_code="${langCodeMap[$subtitle_lang_code]}"
			if [[ -n "$two_letter_code" ]]; then
				subtitle_lang_code="$two_letter_code"
			fi

			local subtitle_lang_name="${langMap[$subtitle_lang_code]}"

			if [[ -z "$subtitle_lang_name" ]]; then
				echo "Warning: Language code '$subtitle_lang_code' not found in langMap. Using code as name."
				subtitle_lang_name="${subtitle_lang_code:-Unknown Language}"
			fi

			if [[ -n "$subtitle_type" ]]; then
				case "$subtitle_type" in
					"hi")
						subtitle_lang_name+=" Hearing Impaired"
						;;
				esac
			fi

			# Get the last modified date of the subtitle file
			local last_modified_date=$(date -r "$subtitle_file" +"%Y-%m-%dT%H:%M:%S.%3NZ")

			# Append the subtitle entry to the corresponding language array
			case "$subtitle_lang_code" in
				"en")
					english_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/movies/$urlEncoded_dir_name/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
					;;
				"es")
					spanish_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/movies/$urlEncoded_dir_name/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
					;;
				"tl")
					tagalog_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/movies/$urlEncoded_dir_name/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
					;;
				*)
					other_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/movies/$urlEncoded_dir_name/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
					;;
			esac
		done

		local subtitle_entries=("${english_subtitles[@]}" "${spanish_subtitles[@]}" "${tagalog_subtitles[@]}" "${other_subtitles[@]}")

		subtitles_json="\"subtitles\": {"
		subtitles_json+="$(IFS=","; echo "${subtitle_entries[*]}")"
		subtitles_json+=" }"

		if [[ ${#subtitle_entries[@]} -gt 0 ]]; then
			url_entries+=("$subtitles_json")
		fi


		# Metadata
        local metadata_url="/movies/$urlEncoded_dir_name/metadata.json"
        metadata_url=${metadata_url// /%20}
        url_entries+=("\"metadata\": \"$metadata_url\"")

        for logo_file in "${files[@]}"; do
            if [[ $logo_file == *"movie_logo."* ]]; then
                local logo_filename=$(basename "$logo_file")
                local logo_url="/movies/$urlEncoded_dir_name/$(urlencode "$logo_filename")"
                logo_url=${logo_url// /%20}
                url_entries+=("\"logo\": \"$logo_url\"")
                break
            fi
        done

        echo "    $(IFS=, ; echo "${url_entries[*]}")" >> "$temp_file"
        echo "  }" >> "$temp_file"
        echo "}" >> "$temp_file"
        if [[ $i -ne $last_dir_index ]]; then
            echo "," >> "$temp_file"
        fi
    done
    echo "}" >> "$temp_file"

    # Format the JSON file and move the temporary file to the final location
    jq . "$temp_file" > "$output_file" && rm "$temp_file"
}

generate_list_tv() {
    local dir_path="$1"
    local output_file="$2"
    local temp_file=$(mktemp)
    echo "{" > "$temp_file"
    local IFS=$'\n'
    local shows=($(find "$dir_path" -mindepth 1 -maxdepth 1 -type d -not -path "*/chapters*" | sort))
    local last_show_index=$((${#shows[@]} - 1))

    for show_index in "${!shows[@]}"; do
        local show="${shows[$show_index]}"
        local showname=$(basename "$show")

        # Handle show poster
        local poster_path="$dir_path/$showname/show_poster.jpg"
        local poster_blurhash=""
        if [[ -f "$poster_path" ]]; then
            poster_blurhash=$(get_stored_blurhash "$poster_path")
        fi

        # Attempt to handle show logo with various extensions
        local logo_path=""
        local logo_blurhash=""
        for ext in svg jpg png gif; do
            if [[ -f "$dir_path/$showname/show_logo.$ext" ]]; then
                logo_path="$dir_path/$showname/show_logo.$ext"
                # Generate blurhash for non-svg images
                if [[ "$ext" != "svg" ]]; then
                    logo_blurhash=$(get_stored_blurhash "$logo_path")
                fi
                break
            fi
        done

        # Attempt to handle show backdrop with various extensions
        local backdrop_path=""
        local backdrop_blurhash=""
        for ext in jpg png gif; do
            if [[ -f "$dir_path/$showname/show_backdrop.$ext" ]]; then
                backdrop_path="$dir_path/$showname/show_backdrop.$ext"
                backdrop_blurhash=$(get_stored_blurhash "$backdrop_path")
                break
            fi
        done

        # Start JSON entry for the show
        echo "\"$showname\": {" >> "$temp_file"
        echo "  \"metadata\": \"/tv/$showname/metadata.json\"," >> "$temp_file"

        # Include poster if exists
        if [[ -n "$poster_blurhash" ]]; then
            echo "  \"poster\": \"/tv/$showname/show_poster.jpg\"," >> "$temp_file"
            echo "  \"posterBlurhash\": \"$poster_blurhash\"," >> "$temp_file"
        fi

        # Include logo
        if [[ -n "$logo_path" ]]; then
            echo "  \"logo\": \"/tv/$showname/${logo_path##*/}\"," >> "$temp_file"
            # Include blurhash only for non-svg images
            if [[ -n "$logo_blurhash" ]]; then
                echo "  \"logoBlurhash\": \"$logo_blurhash\"," >> "$temp_file"
            fi
        fi
		 # Include backdrop if exists
		if [[ -n "$backdrop_blurhash" ]]; then
			echo "  \"backdrop\": \"/tv/$showname/${backdrop_path##*/}\"," >> "$temp_file"
			echo "  \"backdropBlurhash\": \"$backdrop_blurhash\"," >> "$temp_file"
		fi
		
		echo "\"seasons\": {" >> "$temp_file"
        local seasons=($(find "$show" -mindepth 1 -maxdepth 1 -type d -not -path "*/chapters*" | sort -V))
        local last_season_index=$((${#seasons[@]} - 1))

        for season_index in "${!seasons[@]}"; do
            local season="${seasons[$season_index]}"
            local seasonname=$(basename "$season")
            local season_poster_path="$dir_path/$showname/$seasonname/season_poster.jpg"
            local season_poster_blurhash=""

            if [[ -f "$season_poster_path" ]]; then
                season_poster_blurhash=$(get_stored_blurhash "$season_poster_path")
            fi

            echo "  \"$seasonname\": {" >> "$temp_file"
            echo "    \"season_poster\": \"/tv/$showname/$seasonname/season_poster.jpg\"," >> "$temp_file"
            echo "    \"seasonPosterBlurhash\": \"$season_poster_blurhash\"," >> "$temp_file"
            echo "    \"fileNames\": [" >> "$temp_file"
            local files=($(find "$season" -mindepth 1 -maxdepth 1 -type f -name "*.mp4" | grep -v -- "-TdarrCacheFile-" | sort))
			local base_files=()
			for file in "${files[@]}"; do
				if [[ $file != *"_6ch.mp4" ]]; then
					base_files+=("$file")
				fi
			done
			files=("${base_files[@]}")

            local last_file_index=$((${#files[@]} - 1))

            for file_index in "${!base_files[@]}"; do
				local file="${base_files[$file_index]}"
				local filename=$(basename "$file")
				echo -n "      \"$filename\"" >> "$temp_file"
				if [[ $file_index -ne $last_file_index ]]; then
					echo "," >> "$temp_file"
				fi
			done
            echo "    ]," >> "$temp_file"  # Close the array
            echo "    \"urls\": {" >> "$temp_file"

			local lengthData=""
            local dimensionsData=""
            for file_index in "${!files[@]}"; do
				local file="${files[$file_index]}"
				local mediaFile_last_modified_date=$(date -r "$file" +"%Y-%m-%dT%H:%M:%S.%3NZ")
				local filename=$(basename "$file")
				local urlencoded_filename=$(urlencode "$filename")
				local fileurl="/tv/$showname/$seasonname/$urlencoded_filename"
				fileurl=${fileurl// /%20}

				# Attempt to extract episode number using Sonarr-style pattern
				local episode_pattern="S[0-9]+E([0-9]+)"
				local episode_number=""
				if [[ $filename =~ $episode_pattern ]]; then
					episode_number=${BASH_REMATCH[1]}
				else
					# Fallback: extract the first number in the filename
					episode_number=$(echo "$filename" | grep -o -E '[0-9]+' | head -1 | tr -d '\n' | tr -d '\r')
				fi
				if [[ $filename == *".mp4" && $filename != *"-TdarrCacheFile-"* ]]; then
					local info_file="${file}.info"
					if [[ -f "$info_file" ]]; then
						# Read length and dimensions from the .info file
						local file_info=$(cat "$info_file")
						local file_length=$(echo "$file_info" | cut -d ' ' -f 1)
						local file_dimensions=$(echo "$file_info" | cut -d ' ' -f 2)
						lengthData+="\"$filename\": $file_length"
						dimensionsData+="\"$filename\": \"$file_dimensions\""
					else
						# Fallback to ffprobe if .info file is not found
						local length=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$file" | awk '{print int($1 * 1000)}')
						local dimensions=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$file")
						# Check if length or dimensions are empty and skip the whole episode if they are
						# it'll be picked up on another pass when the file is ready to be probed
						if [[ -z "$length" || -z "$dimensions" ]]; then
							continue
						fi
						lengthData+="\"$filename\": $length"
						dimensionsData+="\"$filename\": \"$dimensions\""
						echo "$length $dimensions" > "$info_file"
					fi

					if [[ $file_index -ne $last_file_index ]]; then
						lengthData+=", "
						dimensionsData+=", "
					fi
				fi
				# Thumbnail
				# Initialize thumbnail related variables
				local thumbnail=""
				local thumbnail_blurhash=""
				local thumbnail_entry=""

				# Check if thumbnail file exists
				if [[ -f "$dir_path/$showname/$seasonname/${episode_number} - Thumbnail.jpg" ]]; then
					thumbnail="/tv/$showname/$seasonname/${episode_number} - Thumbnail.jpg"
					thumbnail_blurhash=$(get_stored_blurhash "$dir_path/$showname/$seasonname/${episode_number} - Thumbnail.jpg")
					thumbnail_entry="\"thumbnail\": \"$thumbnail\", \"thumbnailBlurhash\": \"$thumbnail_blurhash\","
				fi
				# Populate the subtitle_files array for the current TV episode
				local subtitle_files=($(find "$dir_path/$showname/$seasonname" -type f -name "${filename%.*}.*.srt"))
				local subtitles_json="\"subtitles\": {"
				local subtitle_count=0

				local english_subtitles=()
				local spanish_subtitles=()
				local tagalog_subtitles=()
				local other_subtitles=()

				for subtitle_file in "${subtitle_files[@]}"; do
					local subtitle_filename=$(basename "$subtitle_file")
					local urlencoded_subtitle=$(urlencode "$subtitle_filename")
					local subtitle_lang_code=$(echo "$subtitle_filename" | grep -oE '\.[a-zA-Z]+(\.[a-zA-Z]+)?\.srt$' | cut -d '.' -f 2)
					local subtitle_type=$(echo "$subtitle_filename" | grep -oE '\.[a-zA-Z]+(\.[a-zA-Z]+)?\.srt$' | cut -d '.' -f 3)

					# Check if the language code is empty and handle it
					if [[ -z "$subtitle_lang_code" ]]; then
						echo "Warning: No language code found for subtitle file $subtitle_filename. Skipping."
						continue  # Skip this subtitle file
					fi

					# Convert to two-letter language code if mapping exists
					local two_letter_code="${langCodeMap[$subtitle_lang_code]}"
					if [[ -n "$two_letter_code" ]]; then
						subtitle_lang_code="$two_letter_code"
					fi

					local subtitle_lang_name="${langMap[$subtitle_lang_code]}"

					if [[ -z "$subtitle_lang_name" ]]; then
						echo "Warning: Language code '$subtitle_lang_code' not found in langMap. Using code as name."
						subtitle_lang_name="${subtitle_lang_code:-Unknown Language}"
					fi

					# Append subtitle type to the language name if present
					if [[ -n "$subtitle_type" ]]; then
						case "$subtitle_type" in
							"hi")
								subtitle_lang_name+=" Hearing Impaired"
								;;
							# Add more cases for other subtitle types if needed
						esac
					fi

					# Get the last modified date of the subtitle file
					local last_modified_date=$(date -r "$subtitle_file" +"%Y-%m-%dT%H:%M:%S.%3NZ")

					# Append the subtitle entry to the corresponding language array
					case "$subtitle_lang_code" in
						"en")
							english_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/tv/$showname/$seasonname/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
							;;
						"es")
							spanish_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/tv/$showname/$seasonname/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
							;;
						"tl")
							tagalog_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/tv/$showname/$seasonname/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
							;;
						*)
							other_subtitles+=("\"$subtitle_lang_name\": { \"url\": \"/tv/$showname/$seasonname/$urlencoded_subtitle\", \"srcLang\": \"$subtitle_lang_code\", \"lastModified\": \"$last_modified_date\" }")
							;;
					esac
				done

				local subtitle_entries=("${english_subtitles[@]}" "${spanish_subtitles[@]}" "${tagalog_subtitles[@]}" "${other_subtitles[@]}")

				subtitles_json+="$(IFS=","; echo "${subtitle_entries[*]}")"
				subtitles_json+=" }"

				# Include subtitles in the JSON entry only if there are subtitle files
				local subtitles_entry=""
				if [[ ${#subtitle_entries[@]} -gt 0 ]]; then
					subtitles_entry=", $subtitles_json"
				fi
				
				# Extract season number and pad with leading zeros
				local season_number=$(echo "$seasonname" | grep -o '[0-9]\+')
				local padded_season_number=$(printf "%02d" "$season_number")
				
				local padded_episode_number="$episode_number"
				
				# Chapter handling
				local chapter_entry=""
				local chapter_file="$dir_path/$showname/$seasonname/chapters/$showname - S${padded_season_number}E${padded_episode_number}_chapters.vtt"
				if [[ -f "$chapter_file" ]]; then
					local urlencoded_chapter_filename=$(urlencode "$(basename "$chapter_file")")
					local chapter_url="/tv/$showname/$seasonname/chapters/$urlencoded_chapter_filename"
					chapter_url=${chapter_url// /%20}
					chapter_entry=", \"chapters\": \"$chapter_url\""
				fi

				# Create the JSON entry with chapters (if available)
				echo -n "      \"$filename\": { \"videourl\": \"$fileurl\", \"mediaLastModified\": \"$mediaFile_last_modified_date\", $thumbnail_entry \"metadata\": \"/tv/$showname/$seasonname/${padded_episode_number}_metadata.json\"$subtitles_entry$chapter_entry" >> "$temp_file"
				if [[ $file_index -eq $last_file_index ]]; then
					echo -n " }" >> "$temp_file"
				else
					echo -n " }," >> "$temp_file"
				fi
				echo "" >> "$temp_file"  # Add a newline after each episode entry
			done
			
            echo "    }," >> "$temp_file"
            echo "    \"lengths\": {" >> "$temp_file"
            echo -e "      $lengthData" >> "$temp_file"
            echo "    }," >> "$temp_file"
            echo "    \"dimensions\": {" >> "$temp_file"
            echo -e "      $dimensionsData" >> "$temp_file"
            echo "    }" >> "$temp_file"
            if [[ $season_index -ne $last_season_index ]]; then
                echo "  }," >> "$temp_file"
            else
                echo "  }" >> "$temp_file"
            fi
        done

        echo "}" >> "$temp_file"  # Close the "seasons" object

        if [[ $show_index -ne $last_show_index ]]; then
            echo "}," >> "$temp_file"
        else
            echo "}" >> "$temp_file"
        fi
    done
    echo "}" >> "$temp_file"
	
	#temporary debug
	cat "$temp_file" > "/var/www/html/debug_output_tv.json"

    # Format the JSON file and move the temporary file to the final location
    jq . "$temp_file" > "$output_file" && rm "$temp_file"
}

# Paths and Output Files
MOVIES_DIR="${MOVIES_DIR:-/var/www/html/movies}"
TV_DIR="${TV_DIR:-/var/www/html/tv}"
MOVIES_OUTPUT="${MOVIES_OUTPUT:-/var/www/html/movies_list.json}"
TV_OUTPUT="${TV_OUTPUT:-/var/www/html/tv_list.json}"
python3 /usr/src/app/scripts/download_tmdb_images.py
bash /usr/src/app/scripts/generate_thumbnail_json.sh

# Generate Lists
echo "Starting movie list generation..."
generate_list_movies "$MOVIES_DIR" "$MOVIES_OUTPUT"
if [ $? -ne 0 ]; then
    echo "Error in generate_list_movies, but continuing..."
fi
echo "Movie list generation completed."

echo "Starting TV list generation..."
generate_list_tv "$TV_DIR" "$TV_OUTPUT"
if [ $? -ne 0 ]; then
    echo "Error in generate_list_tv, but continuing..."
fi
echo "TV list generation completed."


echo "Checking autoSync Settings.."
# Call the Node.js script to check the app autoSync setting
autoSyncEnabled=$(node -e 'require("/usr/src/app/node/database.js").checkAutoSync()' 2>&1)
if [ "$autoSyncEnabled" = "true" ]; then
  echo "Auto Sync is enabled. Proceeding with sync..."
  
  # Update front-end DB with new data
  response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${FRONT_END}/api/authenticated/admin/sync" \
   -H "X-Webhook-ID: ${WEBHOOK_ID}" \
   -H "Content-Type: application/json" \
   -d '{}')

  if [ "$response" -ge 200 ] && [ "$response" -lt 300 ]; then
    echo "Sync request completed successfully."
    # Update the last sync time
    node -e 'require("/usr/src/app/node/database.js").updateLastSyncTime()'
  else
    echo "Sync request failed with status code: $response"
  fi
else
  echo "Auto Sync is disabled. Skipping sync..."
fi
