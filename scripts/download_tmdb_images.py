import json
import argparse
import os
import requests
import json
import time
from urllib.parse import urlparse
from datetime import datetime, timedelta
import re

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
            return json.load(f)
    return {}

def get_tmdb_data(name, tmdb_id=None, type='tv'):
    """Fetch data from TMDB for both TV shows and movies, including trailers and logos."""
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

    # Reintegrate fetching trailer URL and logo file path using separate functions
    trailer_url = get_media_trailer_url(tmdb_id, type)
    if trailer_url:
        media_details['trailer_url'] = trailer_url

    logo_path = get_media_logo_path(tmdb_id, type)
    if logo_path:
        media_details['logo_path'] = logo_path
    
    media_details['last_updated'] = datetime.now().isoformat()

    return media_details

def download_image(image_url, file_path):
    """Download an image from the given URL to the specified file path."""
    if os.path.exists(file_path):
        return  # Skip download if file already exists
    response = requests.get(image_url, stream=True)
    if response.status_code == 200:
        with open(file_path, 'wb') as file:
            for chunk in response.iter_content(1024):
                file.write(chunk)

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

def get_file_extension(url):
    """Extracts and returns the file extension from a URL."""
    parsed_url = urlparse(url)
    return os.path.splitext(parsed_url.path)[1]

def process_shows(specific_show=None):
    for show_name in os.listdir(SHOWS_DIR):
        if specific_show and show_name != specific_show:
            continue
        show_dir = os.path.join(SHOWS_DIR, show_name)
        tmdb_config_path = os.path.join(show_dir, 'tmdb.config')
        metadata_file = os.path.join(show_dir, 'metadata.json')
        
        print('TV: ' + show_name)

        # Read TMDB config
        tmdb_config = read_tmdb_config(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Determine need for metadata refresh
        need_refresh = True
        if os.path.exists(metadata_file):
            last_modified = datetime.fromtimestamp(os.path.getmtime(metadata_file))
            need_refresh = datetime.now() - last_modified >= timedelta(days=1)

        # Refresh or load metadata as necessary
        if need_refresh:
            show_data = get_tmdb_data(show_name, tmdb_id=tmdb_id, type='tv')
            if show_data:
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
                if not os.path.exists(image_path) or need_refresh:
                    # If the image doesn't exist or needs to be refreshed, download the image from the URL
                    download_image(image_url, image_path)


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
                        print(f"{episode_thumbnail_path} does not exist. Downloading thumbnail.")
                        refresh_episode_thumbnail = True
                    
                    if refresh_episode_thumbnail:
                        print(f"Processing show {show_name}")
                        episode_thumbnail_url = get_episode_thumbnail_url(show_data["id"], season_number, episode_number)
                        if episode_thumbnail_url:
                            download_image(episode_thumbnail_url, episode_thumbnail_path)
                            # Update the modification time of the thumbnail file
                            os.utime(episode_thumbnail_path, None)
            else:
                # Season directory does not exist, skip processing for this season
                print(f"Skipping Season {season_number} for '{show_name}' as the directory does not exist.")

def process_movies(specific_movie=None):
    for movie_name in os.listdir(MOVIES_DIR):
        if specific_movie and movie_name != specific_movie:
            continue
        movie_dir = os.path.join(MOVIES_DIR, movie_name)
        if not os.path.isdir(movie_dir):  # Skip if not a directory
            continue
        tmdb_config_path = os.path.join(movie_dir, 'tmdb.config')
        metadata_file = os.path.join(movie_dir, 'metadata.json')
        
        print('Movie: ' + movie_name)

        # If there is a tmdb.config file in the movie directory, use that TMDB config
        tmdb_config = read_tmdb_config(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Check for existing metadata and its freshness
        refresh_metadata = not os.path.exists(metadata_file) or datetime.now() - datetime.fromtimestamp(os.path.getmtime(metadata_file)) > timedelta(days=1)

        if refresh_metadata:
            movie_data = get_tmdb_data(movie_name, tmdb_id=tmdb_id, type='movie')
            if movie_data:
                with open(metadata_file, 'w') as f:
                    json.dump(movie_data, f, indent=4, sort_keys=True)

                # Download and save poster, backdrop, and logo images
                for image_key in ['poster_path', 'backdrop_path', 'logo_path']:
                    if image_key in movie_data:
                        override_key = f'override_{image_key.split("_")[0]}'
                        if override_key in tmdb_config:
                            # Use the override image
                            file_path = tmdb_config[override_key]
                        else:
                            # Use the TMDB image
                            image_url = f'https://image.tmdb.org/t/p/original{movie_data[image_key]}'
                            file_extension = get_file_extension(image_url)
                            file_path = os.path.join(movie_dir, f'{image_key.replace("_path", "")}{file_extension}')
                            if not os.path.exists(file_path):  # Download only if the file doesn't exist
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
    process_shows()
    process_movies()

print("Finished TMDB Updates")
