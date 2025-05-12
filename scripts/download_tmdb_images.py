import json
import argparse
import os
import aiohttp
import asyncio
import sys
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
    should_refresh_metadata,
    read_json_file,
    write_json_file
)
from utils.image_utils import (
    download_image_file,
    extract_file_extension
)
import logging
from dotenv import load_dotenv
from pathlib import Path

# Configure logging with timestamps, logger names, and clear messages
logging.basicConfig(
    level=logging.INFO,  # Set the default logging level
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',  # Define the log message format
    datefmt='%Y-%m-%d %H:%M:%S',  # Specify the date format
)
# Configure logging with separate handlers for stdout and stderr
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)  # Capture all levels of logs

# Handler for stdout (INFO and DEBUG)
stdout_handler = logging.StreamHandler(sys.stdout)
stdout_handler.setLevel(logging.DEBUG)
stdout_formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s', 
                                    datefmt='%Y-%m-%d %H:%M:%S')
stdout_handler.setFormatter(stdout_formatter)

# Handler for stderr (WARNING and above)
stderr_handler = logging.StreamHandler(sys.stderr)
stderr_handler.setLevel(logging.WARNING)
stderr_formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s', 
                                    datefmt='%Y-%m-%d %H:%M:%S')
stderr_handler.setFormatter(stderr_formatter)

# Add handlers to the logger
logger.addHandler(stdout_handler)
logger.addHandler(stderr_handler)

# Only use environment PUID/PGID if they're explicitly set
# puid_str = os.getenv('PUID')
# pgid_str = os.getenv('PGID')

# try:
#     # If environment variables are set, use them
#     if puid_str is not None and pgid_str is not None:
#         puid = int(puid_str)
#         pgid = int(pgid_str)
#         os.setgid(pgid)  # Set GID
#         os.setuid(puid)  # Set UID
#         logger.info(f"Using environment-specified UID {puid} and GID {pgid}")
#     else:
#         # Otherwise use current user (existing behavior)
#         os.setgid(os.getgid())
#         os.setuid(os.getuid())
#         logger.info(f"Using current process UID {os.getuid()} and GID {os.getgid()}")
# except AttributeError:
#     # os.setgid and os.setuid may not be available on some systems (e.g., Windows)
#     logger.warning("UID and GID setting is not supported on this platform.")
# except PermissionError as e:
#     logger.warning(f"Permission error when setting UID/GID: {str(e)}")

parser = argparse.ArgumentParser(description='Download TMDB images for TV shows and movies.')
parser.add_argument('--show', type=str, help='Specific TV show to scan')
parser.add_argument('--movie', type=str, help='Specific movie to scan')
args = parser.parse_args()

# Load environment variables from .env.local in parent directory
env_path = Path(__file__).parent.parent / '.env.local'
load_dotenv(env_path)

# Get base path from environment variable with default fallback
BASE_PATH = os.getenv('BASE_PATH', '/var/www/html')

# Update the path definitions
SHOWS_DIR = os.path.join(BASE_PATH, 'tv')
MOVIES_DIR = os.path.join(BASE_PATH, 'movies')

async def process_seasons_and_episodes(session, show_data, show_dir, show_name):
    """
    Processes seasons and episodes for a TV show, including metadata and images.
    """
    for season in show_data.get('seasons', []):
        season_number = season['season_number']
        season_dir = os.path.join(show_dir, f'Season {season_number}')

        if not os.path.exists(season_dir):
            logger.info(f"Skipping Season {season_number} for '{show_name}' as the directory does not exist.")
            continue

        season_poster_path = os.path.join(season_dir, 'season_poster.jpg')
        refresh_season_poster = not os.path.exists(season_poster_path) or (datetime.now() - datetime.fromtimestamp(os.path.getmtime(season_poster_path)) > timedelta(days=1))
        if refresh_season_poster:
            season_poster_url = f'https://image.tmdb.org/t/p/original{season.get("poster_path", "")}'
            await download_image_file(session, season_poster_url, season_poster_path)

        for episode_number in range(1, season.get('episode_count', 0) + 1):
            episode_metadata_file = os.path.join(season_dir, f'{episode_number:02d}_metadata.json')
            refresh_episode_metadata = not os.path.exists(episode_metadata_file) or (datetime.now() - datetime.fromtimestamp(os.path.getmtime(episode_metadata_file)) > timedelta(days=1))

            if refresh_episode_metadata:
                episode_data = await fetch_tmdb_episode_details(session, show_data["id"], season_number, episode_number)
                if episode_data:
                    await write_json_file(episode_metadata_file, episode_data)

            episode_thumbnail_path = os.path.join(season_dir, f'{episode_number:02d} - Thumbnail.jpg')
            if os.path.exists(episode_thumbnail_path):
                refresh_episode_thumbnail = (datetime.now() - datetime.fromtimestamp(os.path.getmtime(episode_thumbnail_path)) > timedelta(days=3))
            else:
                refresh_episode_thumbnail = True

            if refresh_episode_thumbnail:
                episode_thumbnail_url = await fetch_episode_thumbnail_url(session, show_data["id"], season_number, episode_number)
                if episode_thumbnail_url:
                    await download_image_file(session, episode_thumbnail_url, episode_thumbnail_path)
                    await asyncio.to_thread(os.utime, episode_thumbnail_path, None)

async def process_media_images(session, media_data, media_dir, tmdb_config, existing_metadata, media_type):
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
                new_image_url = f'https://image.tmdb.org/t/p/original{media_data.get(image_key, "")}'

            file_extension = extract_file_extension(new_image_url)
            image_filename = f'{image_filename_map[image_key]}{file_extension}'
            image_path = os.path.join(media_dir, image_filename)

            # Determine if the image needs updating
            image_needs_update = False

            # Check if the image file does not exist
            if not os.path.exists(image_path):
                image_needs_update = True
                logger.info(f"Image {image_filename} does not exist and will be downloaded.")
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
                        existing_image_url = f'https://image.tmdb.org/t/p/original{existing_metadata.get(image_key, "")}'

                # Compare the new image URL with the existing one
                if existing_image_url != new_image_url:
                    image_needs_update = True
                    logger.info(f"Image {image_filename} has changed and will be updated.")

            if image_needs_update and new_image_url:
                # Download the new image
                await download_image_file(session, new_image_url, image_path, force_download=True)
        else:
            logger.warning(f"{image_key} not found in media data for {media_type}.")

async def process_shows(session, specific_show=None):
    """
    Processes TV shows: updates metadata, downloads images, and handles seasons and episodes.
    """
    shows = (
        show_name for show_name in os.listdir(SHOWS_DIR)
        if os.path.isdir(os.path.join(SHOWS_DIR, show_name)) and 
        (not specific_show or show_name == specific_show)
    )
    for show_name in shows:
        show_dir = os.path.join(SHOWS_DIR, show_name)
        tmdb_config_path = os.path.join(show_dir, 'tmdb.config')
        metadata_file = os.path.join(show_dir, 'metadata.json')
        
        logger.info('TV: ' + show_name)

        # Read TMDB config
        tmdb_config = await load_tmdb_config_file(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Check if metadata updates are allowed based on the config
        if not is_metadata_update_allowed(tmdb_config):
            logger.info(f"Updates are disabled for {show_name}. Skipping periodic metadata refresh.")
            if not os.path.exists(metadata_file):
                # Perform initial metadata retrieval if metadata file doesn't exist
                logger.info(f"Initial metadata retrieval for {show_name}.")
                show_data = await fetch_tmdb_media_details(session, show_name, tmdb_id=tmdb_id, media_type='tv')
                if show_data:
                    if 'metadata' in tmdb_config:
                        show_data.update(tmdb_config['metadata'])
                    await write_json_file(metadata_file, show_data)
            else:
                continue  # Skip further processing

        # Determine need for metadata refresh
        need_refresh = await should_refresh_metadata(metadata_file, tmdb_config_path)
        
        # Load the existing metadata for comparison
        existing_metadata = await read_json_file(metadata_file)

        # Refresh or load metadata as necessary
        if need_refresh:
            show_data = await fetch_tmdb_media_details(session, show_name, tmdb_id=tmdb_id, media_type='tv')
            if show_data:
                # Apply hard-coded replacements from tmdb.config
                if 'metadata' in tmdb_config:
                    show_data.update(tmdb_config['metadata'])
                
                await write_json_file(metadata_file, show_data)
        else:
            show_data = existing_metadata

        # Update tmdb.config if necessary
        await update_tmdb_config(tmdb_config_path, tmdb_config, show_data['id'], show_name)

        # Process images
        await process_media_images(session, show_data, show_dir, tmdb_config, existing_metadata, 'tv')

        # Process seasons and episodes
        await process_seasons_and_episodes(session, show_data, show_dir, show_name)

async def process_movies(session, specific_movie=None):
    """
    Processes movies: updates metadata and downloads images.
    """
    movies = (
        movie_name for movie_name in os.listdir(MOVIES_DIR)
        if os.path.isdir(os.path.join(MOVIES_DIR, movie_name)) and 
        (not specific_movie or movie_name == specific_movie)
    )

    for movie_name in movies:
        movie_dir = os.path.join(MOVIES_DIR, movie_name)
        tmdb_config_path = os.path.join(movie_dir, 'tmdb.config')
        metadata_file = os.path.join(movie_dir, 'metadata.json')
        
        logger.info('Processing Movie: ' + movie_name)

        # Read TMDB config
        tmdb_config = await load_tmdb_config_file(tmdb_config_path)
        tmdb_id = tmdb_config.get('tmdb_id')

        # Determine need for metadata refresh
        need_refresh = await should_refresh_metadata(metadata_file, tmdb_config_path)

        # Load the existing metadata for comparison
        existing_metadata = await read_json_file(metadata_file)

        # Refresh metadata or update if necessary
        if need_refresh:
            movie_data = await fetch_tmdb_media_details(session, movie_name, tmdb_id=tmdb_id, media_type='movie')
            if movie_data:
                # Apply hard-coded replacements from tmdb.config
                if 'metadata' in tmdb_config:
                    movie_data.update(tmdb_config['metadata'])
                await write_json_file(metadata_file, movie_data)
                    
                # Update tmdb.config if necessary
                await update_tmdb_config(tmdb_config_path, tmdb_config, movie_data['id'], movie_name)

        else:
            # Use existing metadata if no refresh is needed
            movie_data = existing_metadata

        # Process images
        await process_media_images(session, movie_data, movie_dir, tmdb_config, existing_metadata, 'movie')

print("Processing TMDB Updates")

# Main execution
async def main():
    async with aiohttp.ClientSession() as session:
        if args.show:
            logger.info(f"--Processing Show: {args.show}")
            await process_shows(session, specific_show=args.show)
        elif args.movie:
            logger.info(f"--Processing Movie: {args.movie}")
            await process_movies(session, specific_movie=args.movie)
        else:
            # Use asyncio.gather to run both concurrently
            await asyncio.gather(
                process_movies(session),
                process_shows(session)
            )

if __name__ == "__main__":
    asyncio.run(main())

print("Finished TMDB Updates")
