import os
#import requests
#import requests_cache
import aiohttp
from urllib.parse import urlparse
from datetime import datetime
import re
import logging
from typing import Optional, Dict
import asyncio

logger = logging.getLogger(__name__)

# Suppress specific urllib3 warnings
logging.getLogger("urllib3.response").setLevel(logging.ERROR)
# Alternatively, to suppress all urllib3 warnings, use:
# logging.getLogger("urllib3").setLevel(logging.ERROR)
logging.getLogger("requests_cache.backends.sqlite").setLevel(logging.ERROR)

# Pull the TMDB API key from the environment variable
TMDB_API_KEY = os.getenv('TMDB_API_KEY')
if not TMDB_API_KEY:
    raise ValueError("No TMDB API key found in the environment variables")

# Determine the parent directory of the current script
#current_dir = Path(__file__).resolve().parent
#parent_dir = current_dir.parent

# Initialize aiohttp client session with cache
#cache_dir = parent_dir / 'cache'
#cache_dir.mkdir(exist_ok=True)

async def make_tmdb_api_request(
    session: aiohttp.ClientSession,
    url: str,
    params: Optional[Dict] = None,
    max_retries: int = 5
) -> Optional[Dict]:
    retries = 0
    backoff_factor = 1

    while retries < max_retries if isinstance(max_retries, int) else False:
        try:
            async with session.get(url, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    return data
                elif response.status == 429:
                    retry_after = int(response.headers.get('Retry-After', backoff_factor))
                    logger.warning(f"Rate limit exceeded. Waiting for {retry_after} seconds before retrying...")
                    await asyncio.sleep(retry_after)
                    retries += 1
                    backoff_factor *= 2
                else:
                    text = await response.text()
                    logger.error(f"Error {response.status}: {text}")
                    return None
        except aiohttp.ClientError as e:
            logger.error(f"Request exception: {e}")
            retries += 1
            await asyncio.sleep(backoff_factor)
            backoff_factor *= 2

    logger.error(f"Max retries exceeded for URL: {url}")
    return None

async def fetch_tmdb_media_details(
    session: aiohttp.ClientSession,
    name: str,
    tmdb_id: Optional[int] = None,
    media_type: str = 'tv'
) -> Optional[Dict]:
    params = {'api_key': TMDB_API_KEY}
    if tmdb_id:
        details_url = f'https://api.themoviedb.org/3/{media_type}/{tmdb_id}'
    else:
        search_url = f'https://api.themoviedb.org/3/search/{media_type}'
        params['query'] = name
        search_results = await make_tmdb_api_request(session, search_url, params)
        if not search_results or not search_results.get('results'):
            # Try removing the year from the name
            show_name = re.sub(r'\s*\(\d{4}\)', '', name)
            params['query'] = show_name
            search_results = await make_tmdb_api_request(session, search_url, params)
            if not search_results or not search_results.get('results'):
                return None
        tmdb_id = search_results['results'][0]['id']
        details_url = f'https://api.themoviedb.org/3/{media_type}/{tmdb_id}'

    media_details = await make_tmdb_api_request(session, details_url, params)
    if not media_details:
        return None

    # At this point, tmdb_id is guaranteed to be an int
    assert tmdb_id is not None
    
    # Fetch and integrate additional details
    cast_data = await fetch_tmdb_cast_details(session, tmdb_id, media_type)
    
    # Handle structured cast data for TV shows
    if media_type == 'tv' and isinstance(cast_data, dict):
        # TV shows return dict with cast and recurring_cast
        media_details['cast'] = cast_data.get('cast', [])
        media_details['recurring_cast'] = cast_data.get('recurring_cast', [])
    else:
        # Movies return list (backward compatible)
        media_details['cast'] = cast_data if cast_data else []
    
    media_details['trailer_url'] = await fetch_tmdb_trailer_url(session, tmdb_id, media_type)
    media_details['logo_path'] = await fetch_tmdb_logo_path(session, tmdb_id, media_type)
    media_details['rating'] = await fetch_tmdb_rating(session, tmdb_id, media_type)
    media_details['last_updated'] = datetime.now().isoformat()

    return media_details

async def fetch_tmdb_rating(session: aiohttp.ClientSession, tmdb_id: int, media_type: str) -> Optional[str]:
    if media_type == 'movie':
        release_dates_url = f'https://api.themoviedb.org/3/{media_type}/{tmdb_id}/release_dates'
    else:  # media_type == 'tv'
        release_dates_url = f'https://api.themoviedb.org/3/{media_type}/{tmdb_id}/content_ratings'
    params = {'api_key': TMDB_API_KEY}
    release_dates_data = await make_tmdb_api_request(session, release_dates_url, params)

    if release_dates_data:
        if media_type == 'movie' and 'results' in release_dates_data:
            for country in release_dates_data['results']:
                if country['iso_3166_1'] == 'US':
                    for release in country['release_dates']:
                        if release.get('certification'):
                            return release['certification']
        elif media_type == 'tv' and 'results' in release_dates_data:
            for rating_info in release_dates_data['results']:
                if rating_info['iso_3166_1'] == 'US' and rating_info.get('rating'):
                    return rating_info['rating']
    return None

async def fetch_tmdb_cast_details(session: aiohttp.ClientSession, tmdb_id: int, media_type: str):
    """
    Fetch cast details for a movie or TV show.
    For TV shows, uses aggregate_credits to get comprehensive cast with episode counts.
    For movies, uses standard credits endpoint.
    
    Returns:
        For TV shows: Dict with 'cast' (all cast), 'recurring_cast' (3-7 eps)
        For movies: List of cast members (backward compatible)
    """
    params = {'api_key': TMDB_API_KEY}
    
    if media_type == 'tv':
        # Use aggregate_credits for TV shows to get episode counts
        credits_url = f'https://api.themoviedb.org/3/tv/{tmdb_id}/aggregate_credits'
        credits_data = await make_tmdb_api_request(session, credits_url, params)
        
        if credits_data and 'cast' in credits_data:
            # Format all cast members with enhanced TV data
            all_cast = []
            for member in credits_data['cast']:
                episode_count = member.get('total_episode_count', 0)
                cast_member = {
                    'id': member['id'],
                    'name': member['name'],
                    'character': member.get('roles', [{}])[0].get('character', '') if member.get('roles') else '',
                    'profile_path': f'https://image.tmdb.org/t/p/original{member["profile_path"]}' if member.get('profile_path') else None,
                    'roles': member.get('roles', []),
                    'total_episode_count': episode_count,
                    'type': classify_role(episode_count),
                    'known_for_department': member.get('known_for_department')
                }
                all_cast.append(cast_member)
            
            # Separate recurring cast (3-7 episodes)
            recurring_cast = [member for member in all_cast if member['type'] == 'Recurring']
            
            # Return structured data for TV shows
            return {
                'cast': all_cast,
                'recurring_cast': recurring_cast
            }
    else:
        # For movies, use standard credits endpoint (backward compatible)
        credits_url = f'https://api.themoviedb.org/3/{media_type}/{tmdb_id}/credits'
        credits_data = await make_tmdb_api_request(session, credits_url, params)
        
        if credits_data and 'cast' in credits_data:
            cast_details = []
            for member in credits_data['cast']:
                cast_details.append({
                    'id': member['id'],
                    'name': member['name'],
                    'character': member.get('character', ''),
                    'profile_path': f'https://image.tmdb.org/t/p/original{member["profile_path"]}' if member.get('profile_path') else None
                })
            return cast_details
    
    return None


def classify_role(episode_count: int) -> str:
    """
    Classify role type based on episode count for TV shows.
    
    Args:
        episode_count: Number of episodes appeared in
    
    Returns:
        Role classification: 'Season Regular', 'Recurring', or 'Guest Star'
    """
    if not episode_count or episode_count <= 0:
        return 'Guest Star'
    
    # Classification thresholds
    if episode_count >= 8:
        return 'Season Regular'
    
    if episode_count >= 3:
        return 'Recurring'
    
    return 'Guest Star'

async def fetch_tmdb_trailer_url(session: aiohttp.ClientSession, tmdb_id: int, media_type: str) -> Optional[str]:
    videos_url = f'https://api.themoviedb.org/3/{media_type}/{tmdb_id}/videos'
    params = {'api_key': TMDB_API_KEY}
    videos_data = await make_tmdb_api_request(session, videos_url, params)
    if videos_data and 'results' in videos_data:
        for video in videos_data['results']:
            if video['type'] == 'Trailer' and video['site'] == 'YouTube':
                return f'https://www.youtube.com/watch?v={video["key"]}'
    return None

async def fetch_tmdb_logo_path(session: aiohttp.ClientSession, tmdb_id: int, media_type: str) -> Optional[str]:
    images_url = f'https://api.themoviedb.org/3/{media_type}/{tmdb_id}/images'
    params = {
        'api_key': TMDB_API_KEY,
        'include_image_language': 'en,null'
    }
    images_data = await make_tmdb_api_request(session, images_url, params)
    if images_data and 'logos' in images_data:
        for image in images_data['logos']:
            if image['iso_639_1'] == 'en':
                return f"https://image.tmdb.org/t/p/original{image['file_path']}"
    return None

async def fetch_tmdb_episode_details(
    session: aiohttp.ClientSession,
    show_id: int,
    season_number: int,
    episode_number: int
) -> Optional[Dict]:
    episode_url = f'https://api.themoviedb.org/3/tv/{show_id}/season/{season_number}/episode/{episode_number}'
    params = {'api_key': TMDB_API_KEY}
    episode_data = await make_tmdb_api_request(session, episode_url, params)
    if episode_data:
        episode_data['last_updated'] = datetime.now().isoformat()
    return episode_data

async def fetch_episode_thumbnail_url(
    session: aiohttp.ClientSession,
    show_id: int,
    season_number: int,
    episode_number: int
) -> Optional[str]:
    images_url = f'https://api.themoviedb.org/3/tv/{show_id}/season/{season_number}/episode/{episode_number}/images'
    params = {'api_key': TMDB_API_KEY}
    images_data = await make_tmdb_api_request(session, images_url, params)
    if images_data and 'stills' in images_data and images_data['stills']:
        return f'https://image.tmdb.org/t/p/original{images_data["stills"][0]["file_path"]}'
    return None

def extract_file_extension(url: str) -> str:
    """
    Extracts and returns the file extension from a URL.
    """
    parsed_url = urlparse(url)
    return os.path.splitext(parsed_url.path)[1]

def is_metadata_update_allowed(tmdb_config):
    """
    Checks if metadata updates are allowed based on the 'update_metadata' key in the TMDB config.
    Defaults to True if not specified.
    """
    return tmdb_config.get('update_metadata', True)
