import json
import argparse
import os
from datetime import datetime, timedelta
from utils.tmdb_utils import (
    fetch_tmdb_media_details,
    fetch_tmdb_episode_details,
    fetch_episode_thumbnail_url,
    is_metadata_update_allowed
)
from utils.file_utils import (
    load_tmdb_config_file,
    update_tmdb_config,
    should_refresh_metadata
)
from utils.image_utils import (
    download_image_file,
    extract_file_extension
)

# Set UID and GID to the current user
os.setgid(os.getgid())  # Set GID
os.setuid(os.getuid())  # Set UID

parser = argparse.ArgumentParser(description='Download TMDB images for TV shows and movies.')
parser.add_argument('--show', type=str, help='Specific TV show to scan')
parser.add_argument('--movie', type=str, help='Specific movie to scan')
args = parser.parse_args()

SHOWS_DIR = '/var/www/html/tv'
MOVIES_DIR = '/var/www/html/movies'

def process_seasons_and_episodes(show_data, show_dir, show_name):
    """
    Processes seasons and episodes for a TV show, including metadata and images.
    """
    for season in show_data.get('seasons', []):
        season_number = season['season_number']
        season_dir = os.path.join(show_dir, f'Season {season_number}')

        if not os.path.exists(season_dir):
            print(f"Skipping Season {season_number} for '{show_name}' as the directory does not exist.")
            continue

        season_poster_path = os.path.join(season_dir, 'season_poster.jpg')
        refresh_season_poster = not os.path.exists(season_poster_path) or datetime.now() - datetime.fromtimestamp(os.path.getmtime(season_poster_path)) > timedelta(days=1)
        if refresh_season_poster:
            season_poster_url = f'https://image.tmdb.org/t/p/original{season["poster_path"]}'
            download_image_file(season_poster_url, season_poster_path)

        for episode_number in range(1, season['episode_count'] + 1):
            episode_metadata_file = os.path.join(season_dir, f'{episode_number:02d}_metadata.json')
            refresh_episode_metadata = not os.path.exists(episode_metadata_file) or datetime.now() - datetime.fromtimestamp(os.path.getmtime(episode_metadata_file)) > timedelta(days=1)

            if refresh_episode_metadata:
                episode_data = fetch_tmdb_episode_details(show_data["id"], season_number, episode_number)
                if episode_data:
                    with open(episode_metadata_file, 'w') as ep_file:
                        json.dump(episode_data, ep_file, indent=4, sort_keys=True)

            episode_thumbnail_path = os.path.join(season_dir, f'{episode_number:02d} - Thumbnail.jpg')
            if os.path.exists(episode_thumbnail_path):
                refresh_episode_thumbnail = datetime.now() - datetime.fromtimestamp(os.path.getmtime(episode_thumbnail_path)) > timedelta(days=3)
            else:
                refresh_episode_thumbnail = True

            if refresh_episode_thumbnail:
                episode_thumbnail_url = fetch_episode_thumbnail_url(show_data["id"], season_number, episode_number)
                if episode_thumbnail_url:
                    download_image_file(episode_thumbnail_url, episode_thumbnail_path)
                    os.utime(episode_thumbnail_path, None)

def process_media_images(media_data, media_dir, tmdb_config, existing_metadata, media_type):
    """
    Processes and downloads images (backdrop, poster, logo) for the media.
    """
    # Map image keys to filenames based on media type
    image_filename_map = {
        'backdrop_path': f'{"show_" if media_type == "tv" else ""}backdrop',
        'poster_path': f'{"show_" if media_type == "tv" else ""}poster',
        'logo_path': f'{"show_" if media_type == "tv" else ""}logo',
    }

    for image_key in ['backdrop_path', 'poster_path', 'logo_path']:
        new_image_url = None
        if image_key in media_data:
            override_key = f'override_{image_key.split("_")[0]}'
            if override_key in tmdb_config:
                # Use the override image
                override_image = tmdb_config[override_key]
                new_image_url = f'https://image.tmdb.org/t/p/original{override_image}'
            else:
                # Use the TMDB image
                new_image_url = f'https://image.tmdb.org/t/p/original{media_data[image_key]}'

            file_extension = extract_file_extension(new_image_url)
            image_filename = f'{image_filename_map[image_key]}{file_extension}'
            image_path = os.path.join(media_dir, image_filename)

            # Determine if the image needs updating
            image_needs_update = False

            # Check if the image file does not exist
            if not os.path.exists(image_path):
                image_needs_update = True
                print(f"Image {image_filename} does not exist and will be downloaded.")
            else:
                # Load the existing image URL from existing metadata or tmdb.config
                existing_image_url = None
                if image_key in existing_metadata:
                    # Existing image URL from previous metadata
                    if f'override_{image_key.split("_")[0]}' in tmdb_config:
                        # Existing override image
                        existing_override_image = tmdb_config[f'override_{image_key.split("_")[0]}']
                        existing_image_url = f'https://image.tmdb.org/t/p/original{existing_override_image}'
                    else:
                        existing_image_url = f'https://image.tmdb.org/t/p/original{existing_metadata[image_key]}'

                # Compare the new image URL with the existing one
                if existing_image_url != new_image_url:
                    image_needs_update = True
                    print(f"Image {image_filename} has changed and will be updated.")

            if image_needs_update:
                # Download the new image
                download_image_file(new_image_url, image_path, True)
        else:
            print(f"{image_key} not found in media data for {media_type}.")

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
        tmdb_config = load_tmdb_config_file(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Check if metadata updates are allowed based on the config
        if not is_metadata_update_allowed(tmdb_config):
            print(f"Updates are disabled for {show_name}. Skipping periodic metadata refresh.")
            if not os.path.exists(metadata_file):
                # Perform initial metadata retrieval if metadata file doesn't exist
                print(f"Initial metadata retrieval for {show_name}.")
                show_data = fetch_tmdb_media_details(show_name, tmdb_id=tmdb_id, media_type='tv')
                if show_data:
                    if 'metadata' in tmdb_config:
                        show_data.update(tmdb_config['metadata'])
                    with open(metadata_file, 'w') as f:
                        json.dump(show_data, f, indent=4, sort_keys=True)
            else:
                continue  # Skip further processing

        # Determine need for metadata refresh
        need_refresh = should_refresh_metadata(metadata_file, tmdb_config_path)
        
        # Load the existing metadata for comparison
        existing_metadata = {}
        if os.path.exists(metadata_file):
            with open(metadata_file, 'r') as f:
                existing_metadata = json.load(f)

        # Refresh or load metadata as necessary
        if need_refresh:
            show_data = fetch_tmdb_media_details(show_name, tmdb_id=tmdb_id, media_type='tv')
            if show_data:
                # Apply hard-coded replacements from tmdb.config
                if 'metadata' in tmdb_config:
                    show_data.update(tmdb_config['metadata'])
                with open(metadata_file, 'w') as f:
                    json.dump(show_data, f, indent=4, sort_keys=True)
        else:
            with open(metadata_file, 'r') as f:
                show_data = json.load(f)

        # Update tmdb.config if necessary
        update_tmdb_config(tmdb_config_path, tmdb_config, show_data['id'], show_name)

        # Process images
        process_media_images(show_data, show_dir, tmdb_config, existing_metadata, 'tv')

        # Process seasons and episodes
        process_seasons_and_episodes(show_data, show_dir, show_name)

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
        
        print('Processing Movie: ' + movie_name)

        # Read TMDB config
        tmdb_config = load_tmdb_config_file(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Determine need for metadata refresh
        need_refresh = should_refresh_metadata(metadata_file, tmdb_config_path)

        # Load the existing metadata for comparison
        existing_metadata = {}
        if os.path.exists(metadata_file):
            with open(metadata_file, 'r') as f:
                existing_metadata = json.load(f)

        # Refresh metadata or update if necessary
        if need_refresh:
            movie_data = fetch_tmdb_media_details(movie_name, tmdb_id=tmdb_id, media_type='movie')
            if movie_data:
                # Apply hard-coded replacements from tmdb.config
                if 'metadata' in tmdb_config:
                    movie_data.update(tmdb_config['metadata'])
                with open(metadata_file, 'w') as f:
                    json.dump(movie_data, f, indent=4, sort_keys=True)
                
                # Update tmdb.config if necessary
                update_tmdb_config(tmdb_config_path, tmdb_config, movie_data['id'], movie_name)

        else:
            # Use existing metadata if no refresh is needed
            movie_data = existing_metadata

        # Process images
        process_media_images(movie_data, movie_dir, tmdb_config, existing_metadata, 'movie')

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
