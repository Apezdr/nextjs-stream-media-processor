import json
import argparse
import os
import requests
import json
import time
import threading
from urllib.parse import urlparse
from datetime import datetime, timedelta
import re
# Import the generate_blurhash function
from utils.blurhash_cli import process_image

# Set UID and GID to the current user
os.setgid(os.getgid())  # Set GID
os.setuid(os.getuid())  # Set UID

parser = argparse.ArgumentParser(description='Download TMDB images for TV shows and movies.')
parser.add_argument('--show', type=str, help='Specific TV show to scan')
parser.add_argument('--movie', type=str, help='Specific movie to scan')
args = parser.parse_args()

# Pull the TMDB API key from the environment variable
TMDB_API_KEY = os.getenv('TMDB_API_KEY')
if not TMDB_API_KEY:
    raise ValueError("No TMDB API key found in the environment variables")

SHOWS_DIR = '/var/www/html/tv'
MOVIES_DIR = '/var/www/html/movies'

def read_tmdb_config(config_path):
    if os.path.exists(config_path):
        with open(config_path, 'r') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError as e:
                print(f"Error decoding JSON from {config_path}: {e}")
                return {}  # Return an empty dict in case of error
    return {}

def should_update_metadata(tmdb_config):
    # Check if the 'update_metadata' key exists and is explicitly set to false
    return tmdb_config.get('update_metadata', True)

def get_tmdb_data(name, tmdb_id=None, type='tv'):
    """Fetch data from TMDB for both TV shows and movies, including trailers, logos, and cast."""
    base_url = 'https://api.themoviedb.org/3'
    if tmdb_id:
        details_url = f'{base_url}/{type}/{tmdb_id}?api_key={TMDB_API_KEY}'
    else:
        search_url = f'{base_url}/search/{type}?api_key={TMDB_API_KEY}&query={requests.utils.quote(name)}'
        search_resp = requests.get(search_url)
        search_results = search_resp.json().get('results', [])
        if not search_results:
            # If no results found, try searching with only the show name (without the year)
            show_name = re.sub(r'\s*\(\d{4}\)', '', name)
            search_url = f'{base_url}/search/{type}?api_key={TMDB_API_KEY}&query={requests.utils.quote(show_name)}'
            search_resp = requests.get(search_url)
            search_results = search_resp.json().get('results', [])
            if search_results:
                # Filter the results based on the year extracted from the folder name
                year_match = re.search(r'\((\d{4})\)', name)
                if year_match:
                    year = int(year_match.group(1))
                    search_results = [result for result in search_results if 'first_air_date' in result and result['first_air_date'][:4] == str(year)]
                    if search_results:
                        tmdb_id = search_results[0]['id']
                    else:
                        return None
                else:
                    tmdb_id = search_results[0]['id']
            else:
                return None
        else:
            tmdb_id = search_results[0]['id']

    details_url = f'{base_url}/{type}/{tmdb_id}?api_key={TMDB_API_KEY}'

    details_resp = requests.get(details_url)
    media_details = details_resp.json()

    # Fetch and integrate the cast data only if available
    cast_details = get_media_cast(tmdb_id, type)
    if cast_details:  # Only add 'cast' to metadata if there is cast information
        media_details['cast'] = cast_details

    # Reintegrate fetching trailer URL and logo file path using separate functions
    trailer_url = get_media_trailer_url(tmdb_id, type)
    if trailer_url:
        media_details['trailer_url'] = trailer_url

    logo_path = get_media_logo_path(tmdb_id, type)
    if logo_path:
        media_details['logo_path'] = logo_path
    
    media_details['last_updated'] = datetime.now().isoformat()

    return media_details

def generate_and_save_blurhash(file_path, blurhash_file_path):
    """
    Generate the blurhash for the given image file and save it to the blurhash file.
    
    :param file_path: The local file path of the image.
    :param blurhash_file_path: The local file path where the blurhash will be saved.
    """
    try:
        blurhash_string = process_image(file_path)
        if blurhash_string:  # Check if the blurhash_string is valid (not None or empty)
            with open(blurhash_file_path, 'w') as blurhash_file:
                blurhash_file.write(blurhash_string)
            print(f"Blurhash saved to {blurhash_file_path}")
        else:
            print("No valid blurhash generated for the image.")
    except Exception as e:
        print(f"Error generating blurhash: {e}")

def download_image(image_url, file_path, force_download=False):
    """
    Download an image from the given URL to the specified file path.
    
    :param image_url: The URL of the image to download.
    :param file_path: The local file path where the image will be saved.
    :param force_download: If True, download the image even if the file already exists.
    """
    # Check if the file exists and download only if needed
    if os.path.exists(file_path) and not force_download:
        return  # Skip download if the file exists and force_download is not set
    
    # Delete any accompanying blurhash file before downloading the new image
    blurhash_file_path = file_path + '.blurhash'
    if os.path.exists(blurhash_file_path):
        try:
            os.remove(blurhash_file_path)
            print(f"Deleted accompanying blurhash file: {blurhash_file_path}")
        except FileNotFoundError:
            print(f"Blurhash file not found: {blurhash_file_path}")

    # Attempt to download the image
    response = requests.get(image_url, stream=True)
    if response.status_code == 200:
        with open(file_path, 'wb') as file:
            for chunk in response.iter_content(1024):
                file.write(chunk)
        print(f"Image downloaded and saved to {file_path}")

        # Start the blurhash generation in a separate thread
        blurhash_thread = threading.Thread(target=generate_and_save_blurhash, args=(file_path, blurhash_file_path))
        blurhash_thread.start()

    else:
        print(f"Failed to download image from {image_url}. Status code: {response.status_code}")

def get_tmdb_episode_data(show_id, season_number, episode_number, max_retries=3, retry_delay=2):
    """Fetch episode data from TMDB with error handling."""
    episode_url = f'https://api.themoviedb.org/3/tv/{show_id}/season/{season_number}/episode/{episode_number}?api_key={TMDB_API_KEY}'
    
    retry_count = 0
    while retry_count < max_retries:
        try:
            response = requests.get(episode_url)
            if response.status_code == 200:
                responseJSON = response.json()
                responseJSON['last_updated'] = datetime.now().isoformat()
                return responseJSON
            elif response.status_code == 429:
                print("Rate limit exceeded. Waiting for 10 seconds before retrying...")
                time.sleep(10)  # Wait for 10 seconds before retrying
                continue
            else:
                print(f"Error response status code: {response.status_code}")
                return None
        except requests.exceptions.RequestException as e:
            retry_count += 1
            if retry_count < max_retries:
                print(f"Error occurred while fetching episode data: {episode_url}")
                print(f"Error details: {e}")
                print(f"Retrying in {retry_delay} seconds... (Attempt {retry_count}/{max_retries})")
                time.sleep(retry_delay)
            else:
                print(f"Max retries reached. Skipping episode data: {episode_url}")
                return None
    
    return None

def get_episode_thumbnail_url(show_id, season_number, episode_number, retry_count=0):
    """Fetch episode thumbnail URL from TMDB."""
    if retry_count > 5:
        print("Maximum retries exceeded.")
        return None

    # Delay the request by sleeping for a defined period (e.g., 1 second)
    #time.sleep(1)  # Adjust this value based on the API's rate limit
    url = f'https://api.themoviedb.org/3/tv/{show_id}/season/{season_number}/episode/{episode_number}/images?api_key={TMDB_API_KEY}'
    #print(f"Requesting URL: {url}")  # Print the requested URL
    
    if retry_count > 0:
        print(f"Retrying request for {show_id} {url}")
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    }
    
    try:
        response = requests.get(url, headers=headers)
        #print(f"Response Status Code: {response.status_code}")  # Print the response status code
        #print(f"Response Content: {response.text}")  # Print the raw response content
        
        if response.status_code == 429:
            print("Rate limit exceeded. Waiting for 10 seconds before retrying...")
            time.sleep(8)  # Wait for 8 seconds before retrying
            return get_episode_thumbnail_url(show_id, season_number, episode_number, retry_count + 1)  # Retry the request
        elif response.status_code == 200:
            data = response.json()
            stills = data.get('stills', [])
            if stills:
                return f'https://image.tmdb.org/t/p/original{stills[0]["file_path"]}'
            else:
                print("No 'stills' found in the response.")
        else:
            print(f"Error: {response.status_code} - {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"Error occurred while fetching episode thumbnail URL: {url}")
        print(f"Error show_id: {show_id}")
        print(f"Error details: {e}")
        time.sleep(2)  # Short delay before retrying
        return get_episode_thumbnail_url(show_id, season_number, episode_number, retry_count + 1)

    return None


def get_media_trailer_url(tmdb_id, type):
    """Fetch the trailer URL for a show or movie from TMDB."""
    videos_url = f'https://api.themoviedb.org/3/{type}/{tmdb_id}/videos?api_key={TMDB_API_KEY}'
    videos_resp = requests.get(videos_url)
    videos_data = videos_resp.json().get('results', [])
    for video in videos_data:
        if video['type'] == 'Trailer' and video['site'] == 'YouTube':
            return f'https://www.youtube.com/watch?v={video["key"]}'
    return None
    
def get_media_logo_path(tmdb_id, type):
    """Fetch the logo file path for a show or movie from TMDB."""
    images_url = f'https://api.themoviedb.org/3/{type}/{tmdb_id}/images?api_key={TMDB_API_KEY}&include_image_language=en,null'
    images_resp = requests.get(images_url)
    images_data = images_resp.json()

    # For TV shows, use 'logos'; for movies, 'logos' might also be available
    if type == 'tv' or type == 'movie':
        logos = images_data.get('logos', [])
        for image in logos:
            if image['iso_639_1'] == 'en':
                return f"https://image.tmdb.org/t/p/original{image['file_path']}"
    return None

def get_media_cast(tmdb_id, type):
    """Fetch the cast for a show or movie from TMDB."""
    credits_url = f'https://api.themoviedb.org/3/{type}/{tmdb_id}/credits?api_key={TMDB_API_KEY}'
    credits_resp = requests.get(credits_url)
    credits_data = credits_resp.json().get('cast', [])

    cast_details = []
    for member in credits_data:
        # Only include essential information to keep the metadata compact
        cast_details.append({
            'id': member['id'],
            'name': member['name'],
            'character': member.get('character', ''),
            'profile_path': f'https://image.tmdb.org/t/p/original{member["profile_path"]}' if member.get('profile_path') else None
        })

    return cast_details

def get_file_extension(url):
    """Extracts and returns the file extension from a URL."""
    parsed_url = urlparse(url)
    return os.path.splitext(parsed_url.path)[1]

def process_shows(specific_show=None):
    shows = (
        show_name for show_name in os.listdir(SHOWS_DIR)
        if os.path.isdir(os.path.join(SHOWS_DIR, show_name)) and 
        (not specific_show or show_name == specific_show)
    )
    for show_name in shows:
        show_dir = os.path.join(SHOWS_DIR, show_name)
        tmdb_config_path = os.path.join(show_dir, 'tmdb.config')
        metadata_file = os.path.join(show_dir, 'metadata.json')
        
        print('TV: ' + show_name)

        # Read TMDB config
        tmdb_config = read_tmdb_config(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Check if metadata updates are allowed based on the config
        if not should_update_metadata(tmdb_config):
            print(f"Updates are disabled for {show_name}. Skipping periodic metadata refresh.")
            if not os.path.exists(metadata_file):
                # Perform initial metadata retrieval if metadata file doesn't exist
                print(f"Initial metadata retrieval for {show_name}.")
                show_data = get_tmdb_data(show_name, tmdb_id=tmdb_id, type='tv')
                if show_data:
                    if 'metadata' in tmdb_config:
                        show_data.update(tmdb_config['metadata'])
                    with open(metadata_file, 'w') as f:
                        json.dump(show_data, f, indent=4, sort_keys=True)
            else:
                continue  # Skip further processing

        # Determine need for metadata refresh
        need_refresh = True
        if os.path.exists(metadata_file):
            metadata_last_modified = datetime.fromtimestamp(os.path.getmtime(metadata_file))
            config_last_modified = datetime.fromtimestamp(os.path.getmtime(tmdb_config_path)) if tmdb_config else None
            
            # Check if the metadata file is older than 1 day or if the config file was updated more recently
            need_refresh = (datetime.now() - metadata_last_modified >= timedelta(days=1)) or (config_last_modified and config_last_modified > metadata_last_modified)

        # Refresh or load metadata as necessary
        if need_refresh:
            show_data = get_tmdb_data(show_name, tmdb_id=tmdb_id, type='tv')
            if show_data:
                # Apply hard-coded replacements from tmdb.config
                if 'metadata' in tmdb_config:
                    show_data.update(tmdb_config['metadata'])
                with open(metadata_file, 'w') as f:
                    json.dump(show_data, f, indent=4, sort_keys=True)
        else:
            with open(metadata_file, 'r') as f:
                show_data = json.load(f)

        # Iterate over specified image types to check and download necessary images
        for image_type in ['backdrop_path', 'poster_path', 'logo_path']:
            if image_type in show_data:
                override_key = f'override_{image_type.split("_")[0]}'
                if override_key in tmdb_config:
                    # Use the override image
                    override_image = tmdb_config[override_key]
                    image_url = f'https://image.tmdb.org/t/p/original{override_image}'
                else:
                    # Use the TMDB image
                    image_url = f'https://image.tmdb.org/t/p/original{show_data[image_type]}'

                file_extension = get_file_extension(image_url)
                image_path = os.path.join(show_dir, f'show_{image_type.split("_")[0]}{file_extension}')

                # Check if the image file does not exist or if the metadata was recently refreshed
                if need_refresh or not os.path.exists(image_path):
                    # If the image doesn't exist or needs to be refreshed, download the image from the URL
                    download_image(image_url, image_path, True)

        # Update season and episode metadata with a condition based on last modification
        for season in show_data.get('seasons', []):
            season_number = season['season_number']
            season_dir = os.path.join(show_dir, f'Season {season_number}')
            
            # Check if the season directory already exists before processing episodes
            if os.path.exists(season_dir):
                season_poster_path = os.path.join(season_dir, 'season_poster.jpg')
                # Check if the season poster needs to be updated
                refresh_season_poster = not os.path.exists(season_poster_path) or datetime.now() - datetime.fromtimestamp(os.path.getmtime(season_poster_path)) > timedelta(days=1)
                if refresh_season_poster:
                    season_poster_url = f'https://image.tmdb.org/t/p/original{season["poster_path"]}'
                    download_image(season_poster_url, season_poster_path)

                # Process each episode with a condition based on last modification
                for episode_number in range(1, season['episode_count'] + 1):
                    episode_metadata_file = os.path.join(season_dir, f'{episode_number:02d}_metadata.json')
                    # Determine if episode metadata needs refreshing
                    refresh_episode_metadata = not os.path.exists(episode_metadata_file) or datetime.now() - datetime.fromtimestamp(os.path.getmtime(episode_metadata_file)) > timedelta(days=1)
                    
                    if refresh_episode_metadata:
                        episode_data = get_tmdb_episode_data(show_data["id"], season_number, episode_number)
                        if episode_data:
                            with open(episode_metadata_file, 'w') as ep_file:
                                json.dump(episode_data, ep_file, indent=4, sort_keys=True)

                    # Check for episode thumbnail update
                    episode_thumbnail_path = os.path.join(season_dir, f'{episode_number:02d} - Thumbnail.jpg')
                    
                    # Check if the episode thumbnail file exists before getting its modification time
                    if os.path.exists(episode_thumbnail_path):
                        print(f"{episode_thumbnail_path} date:{datetime.fromtimestamp(os.path.getmtime(episode_thumbnail_path))}")
                        refresh_episode_thumbnail = datetime.now() - datetime.fromtimestamp(os.path.getmtime(episode_thumbnail_path)) > timedelta(days=3)
                    else:
                        refresh_episode_thumbnail = True
                    
                    if refresh_episode_thumbnail:
                        print(f"{episode_thumbnail_path} does not exist. Downloading thumbnail. Processing show {show_name}")
                        episode_thumbnail_url = get_episode_thumbnail_url(show_data["id"], season_number, episode_number)
                        if episode_thumbnail_url:
                            download_image(episode_thumbnail_url, episode_thumbnail_path)
                            # Update the modification time of the thumbnail file
                            os.utime(episode_thumbnail_path, None)
            else:
                # Season directory does not exist, skip processing for this season
                print(f"Skipping Season {season_number} for '{show_name}' as the directory does not exist.")
def process_movies(specific_movie=None):
    movies = (
        movie_name for movie_name in os.listdir(MOVIES_DIR)
        if os.path.isdir(os.path.join(MOVIES_DIR, movie_name)) and 
        (not specific_movie or movie_name == specific_movie)
    )

    for movie_name in movies:
        movie_dir = os.path.join(MOVIES_DIR, movie_name)
        tmdb_config_path = os.path.join(movie_dir, 'tmdb.config')
        metadata_file = os.path.join(movie_dir, 'metadata.json')
        
        print('Movie: ' + movie_name)

        # If there is a tmdb.config file in the movie directory, use that TMDB config
        tmdb_config = read_tmdb_config(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Determine need for metadata refresh
        refresh_metadata = True
        if os.path.exists(metadata_file):
            metadata_last_modified = datetime.fromtimestamp(os.path.getmtime(metadata_file))
            if os.path.exists(tmdb_config_path):
                config_last_modified = datetime.fromtimestamp(os.path.getmtime(tmdb_config_path))
                # Check if metadata file is older than 1 day or if the config file was updated more recently
                refresh_metadata = (datetime.now() - metadata_last_modified >= timedelta(days=1)) or (config_last_modified > metadata_last_modified)
            else:
                # Only check if metadata is older than 1 day if there is no TMDB config
                refresh_metadata = datetime.now() - metadata_last_modified >= timedelta(days=1)

        # Load the existing metadata for comparison
        existing_metadata = {}
        if os.path.exists(metadata_file):
            with open(metadata_file, 'r') as f:
                existing_metadata = json.load(f)

        # Refresh metadata or update if necessary
        if refresh_metadata:
            movie_data = get_tmdb_data(movie_name, tmdb_id=tmdb_id, type='movie')
            if movie_data:
                # Apply hard-coded replacements from tmdb.config
                if 'metadata' in tmdb_config:
                    movie_data.update(tmdb_config['metadata'])
                with open(metadata_file, 'w') as f:
                    json.dump(movie_data, f, indent=4, sort_keys=True)

                # Download and save poster, backdrop, and logo images
                for image_key in ['poster_path', 'backdrop_path', 'logo_path']:
                    if image_key in movie_data:
                        override_key = f'override_{image_key.split("_")[0]}'
                        if override_key in tmdb_config:
                            # Use the override image path directly
                            file_path = tmdb_config[override_key]
                        else:
                            # Use the TMDB image URL
                            image_url = f'https://image.tmdb.org/t/p/original{movie_data[image_key]}'
                            file_extension = get_file_extension(image_url)
                            file_path = os.path.join(movie_dir, f'{image_key.replace("_path", "")}{file_extension}')

                        # Check if the image needs to be updated
                        if image_key in existing_metadata and existing_metadata.get(image_key) != movie_data[image_key]:
                            # Image path is different, download and replace the existing file
                            print(f"Updating {image_key} for {movie_name}...")
                            download_image(image_url, file_path, True)
                        elif not os.path.exists(file_path):  # Download only if the file doesn't exist
                            print(f"Downloading {image_key} for {movie_name}...")
                            download_image(image_url, file_path)


print("Processing TMDB Updates")

# Main execution
if args.show:
    print("--Processing Show", args.show)
    process_shows(specific_show=args.show)
elif args.movie:
    print("--Processing Movie", args.movie)
    process_movies(specific_movie=args.movie)
else:
    process_movies()
    process_shows()

print("Finished TMDB Updates")
