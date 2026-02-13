"""
Pytest configuration and shared fixtures for TMDB metadata processing tests.

This module provides:
- Test fixtures for mock data and temporary directories
- TMDB API mocking utilities
- Database setup and teardown
- Shared test utilities
"""

import os
import sys
from pathlib import Path

# Load .env.local for local development testing
env_local_path = Path(__file__).parent.parent.parent / '.env.local'
if env_local_path.exists():
    from dotenv import load_dotenv
    load_dotenv(env_local_path)
    if os.getenv('TMDB_API_KEY'):
        print(f"✓ Loaded TMDB_API_KEY from .env.local for testing")

# Set mock environment variables BEFORE any imports that check them
# (only if not already set from .env.local)
os.environ.setdefault('TMDB_API_KEY', 'test_mock_api_key_12345')
os.environ.setdefault('BASE_PATH', str(Path(__file__).parent.parent.parent / 'test_media'))

import pytest
import asyncio
import aiohttp
import tempfile
import shutil
import json
from datetime import datetime, timedelta
from unittest.mock import Mock, AsyncMock, patch, MagicMock

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.tmdb_utils import (
    make_tmdb_api_request,
    fetch_tmdb_media_details,
    fetch_tmdb_episode_details,
    fetch_episode_thumbnail_url,
)
from utils.file_utils import (
    load_tmdb_config_file,
    should_refresh_metadata,
    read_json_file,
    write_json_file,
)
from utils.image_utils import (
    download_image_file,
)


# ============================================================================
# Session-scoped fixtures
# ============================================================================

@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the entire test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


# ============================================================================
# Temporary directory fixtures
# ============================================================================

@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    temp_path = tempfile.mkdtemp()
    yield Path(temp_path)
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def mock_base_path(temp_dir):
    """Create a mock BASE_PATH structure with tv and movies directories."""
    tv_dir = temp_dir / "tv"
    movies_dir = temp_dir / "movies"
    tv_dir.mkdir()
    movies_dir.mkdir()
    
    return {
        "base": temp_dir,
        "tv": tv_dir,
        "movies": movies_dir,
    }


@pytest.fixture
def mock_tv_show_structure(mock_base_path):
    """Create a complete TV show directory structure."""
    show_name = "Test Show"
    show_dir = mock_base_path["tv"] / show_name
    show_dir.mkdir()
    
    # Create tmdb.config
    config = {
        "tmdb_id": 12345,
        "update_metadata": True,
        "last_updated": (datetime.now() - timedelta(days=2)).isoformat(),
    }
    with open(show_dir / "tmdb.config", "w") as f:
        json.dump(config, f)
    
    # Create Season 1 directory
    season_dir = show_dir / "Season 1"
    season_dir.mkdir()
    
    return {
        "show_name": show_name,
        "show_dir": show_dir,
        "season_dir": season_dir,
        "config_path": show_dir / "tmdb.config",
        "metadata_path": show_dir / "metadata.json",
    }


@pytest.fixture
def mock_movie_structure(mock_base_path):
    """Create a complete movie directory structure."""
    movie_name = "Test Movie"
    movie_dir = mock_base_path["movies"] / movie_name
    movie_dir.mkdir()
    
    # Create tmdb.config
    config = {
        "tmdb_id": 67890,
        "update_metadata": True,
        "last_updated": (datetime.now() - timedelta(days=2)).isoformat(),
    }
    with open(movie_dir / "tmdb.config", "w") as f:
        json.dump(config, f)
    
    return {
        "movie_name": movie_name,
        "movie_dir": movie_dir,
        "config_path": movie_dir / "tmdb.config",
        "metadata_path": movie_dir / "metadata.json",
    }


# ============================================================================
# Mock TMDB API response fixtures
# ============================================================================

@pytest.fixture
def mock_tmdb_tv_response():
    """Mock TMDB API response for a TV show with comprehensive data matching API spec."""
    return {
        "adult": False,
        "backdrop_path": "/test_backdrop.jpg",
        "created_by": [
            {
                "id": 9001,
                "credit_id": "52571e8f19c2957114107d48",
                "name": "Creator Name",
                "gender": 2,
                "profile_path": "/creator_profile.jpg"
            }
        ],
        "episode_run_time": [45, 50],
        "first_air_date": "2020-01-01",
        "genres": [
            {"id": 18, "name": "Drama"},
            {"id": 10765, "name": "Sci-Fi & Fantasy"}
        ],
        "homepage": "https://www.example.com/testshow",
        "id": 12345,
        "in_production": True,
        "languages": ["en"],
        "last_air_date": "2023-12-31",
        "last_episode_to_air": {
            "id": 1111,
            "name": "Season Finale",
            "overview": "The final episode",
            "vote_average": 9.0,
            "vote_count": 150,
            "air_date": "2023-12-31",
            "episode_number": 10,
            "production_code": "",
            "runtime": 50,
            "season_number": 3,
            "show_id": 12345,
            "still_path": "/episode_still.jpg"
        },
        "name": "Test Show",
        "next_episode_to_air": None,
        "networks": [
            {
                "id": 49,
                "logo_path": "/network_logo.png",
                "name": "HBO",
                "origin_country": "US"
            }
        ],
        "number_of_episodes": 30,
        "number_of_seasons": 3,
        "origin_country": ["US"],
        "original_language": "en",
        "original_name": "Test Show",
        "overview": "A test TV show for testing purposes",
        "popularity": 100.5,
        "poster_path": "/test_poster.jpg",
        "production_companies": [
            {
                "id": 3001,
                "logo_path": "/company_logo.png",
                "name": "Test Productions",
                "origin_country": "US"
            }
        ],
        "production_countries": [
            {
                "iso_3166_1": "US",
                "name": "United States of America"
            }
        ],
        "seasons": [
            {
                "air_date": "2020-01-01",
                "episode_count": 10,
                "id": 50001,
                "name": "Season 1",
                "overview": "First season overview",
                "poster_path": "/season1_poster.jpg",
                "season_number": 1,
                "vote_average": 8.5
            }
        ],
        "spoken_languages": [
            {
                "english_name": "English",
                "iso_639_1": "en",
                "name": "English"
            }
        ],
        "status": "Returning Series",
        "tagline": "Test show tagline",
        "type": "Scripted",
        "vote_average": 8.5,
        "vote_count": 1000,
        # Custom fields from our implementation
        "cast": [
            {
                "id": 1001,
                "name": "Actor One",
                "character": "Main Character",
                "profile_path": "/actor1.jpg"
            },
            {
                "id": 1002,
                "name": "Actor Two",
                "character": "Supporting Character",
                "profile_path": "/actor2.jpg"
            }
        ],
        "trailer_url": "https://www.youtube.com/watch?v=test123",
        "logo_path": "https://image.tmdb.org/t/p/original/test_logo.png",
        "rating": "TV-14",
        "last_updated": datetime.now().isoformat(),
    }


@pytest.fixture
def mock_tmdb_movie_response():
    """Mock TMDB API response for a movie with comprehensive data matching API spec."""
    return {
        "adult": False,
        "backdrop_path": "/movie_backdrop.jpg",
        "belongs_to_collection": None,
        "budget": 100000000,
        "genres": [
            {"id": 28, "name": "Action"},
            {"id": 12, "name": "Adventure"}
        ],
        "homepage": "https://www.example.com/testmovie",
        "id": 67890,
        "imdb_id": "tt1234567",
        "original_language": "en",
        "original_title": "Test Movie",
        "overview": "A test movie for testing purposes",
        "popularity": 150.3,
        "poster_path": "/movie_poster.jpg",
        "production_companies": [
            {
                "id": 2001,
                "logo_path": "/company_logo.png",
                "name": "Test Studios",
                "origin_country": "US"
            }
        ],
        "production_countries": [
            {
                "iso_3166_1": "US",
                "name": "United States of America"
            }
        ],
        "release_date": "2022-06-15",
        "revenue": 500000000,
        "runtime": 120,
        "spoken_languages": [
            {
                "english_name": "English",
                "iso_639_1": "en",
                "name": "English"
            }
        ],
        "status": "Released",
        "tagline": "Test movie tagline",
        "title": "Test Movie",
        "video": False,
        "vote_average": 7.8,
        "vote_count": 2500,
        # Custom fields from our implementation
        "cast": [
            {
                "id": 2001,
                "name": "Movie Actor One",
                "character": "Hero",
                "profile_path": "/movie_actor1.jpg"
            }
        ],
        "trailer_url": "https://www.youtube.com/watch?v=movie123",
        "logo_path": "https://image.tmdb.org/t/p/original/movie_logo.png",
        "rating": "PG-13",
        "last_updated": datetime.now().isoformat(),
    }


@pytest.fixture
def mock_tmdb_episode_response():
    """Mock TMDB API response for a TV episode."""
    return {
        "id": 11111,
        "name": "Pilot",
        "overview": "The first episode of the series",
        "season_number": 1,
        "episode_number": 1,
        "air_date": "2020-01-01",
        "vote_average": 8.2,
        "vote_count": 500,
        "still_path": "/episode1_thumbnail.jpg",
        "last_updated": datetime.now().isoformat(),
    }


@pytest.fixture
def mock_tmdb_response_with_blurhash(mock_tmdb_tv_response):
    """Mock TMDB response enhanced with blurhash data."""
    response = mock_tmdb_tv_response.copy()
    response["poster_blurhash"] = "LEHV6nWB2yk8pyo0adR*.7kCMdnj"
    response["backdrop_blurhash"] = "L6Pj0^jE.AyE_3t7t7R**0o#DgR4"
    return response


# ============================================================================
# Mock aiohttp session fixtures
# ============================================================================

@pytest.fixture
async def mock_aiohttp_session():
    """Create a mock aiohttp ClientSession with configurable responses."""
    session = AsyncMock(spec=aiohttp.ClientSession)
    
    # Default successful response
    mock_response = AsyncMock()
    mock_response.status = 200
    mock_response.json = AsyncMock(return_value={"success": True})
    mock_response.read = AsyncMock(return_value=b"mock_image_data")
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=None)
    
    session.get = AsyncMock(return_value=mock_response)
    
    return session


# ============================================================================
# Mock image data fixtures
# ============================================================================

@pytest.fixture
def mock_image_data():
    """Create mock image binary data (1x1 pixel PNG)."""
    # Minimal valid PNG file (1x1 transparent pixel)
    return bytes([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  # PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,  # IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  # 1x1 dimensions
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,  # IDAT chunk
        0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,  # IEND chunk
        0x42, 0x60, 0x82
    ])


# ============================================================================
# Time manipulation fixtures
# ============================================================================

@pytest.fixture
def freeze_time():
    """Fixture to freeze time at a specific datetime."""
    def _freeze_time(frozen_datetime):
        with patch('utils.file_utils.datetime', wraps=datetime) as mock_dt:
            mock_dt.now.return_value = frozen_datetime
            mock_dt.fromtimestamp = datetime.fromtimestamp
            return mock_dt
    return _freeze_time


@pytest.fixture
def time_24_hours_ago():
    """Return a datetime 24 hours ago."""
    return datetime.now() - timedelta(hours=24)


@pytest.fixture
def time_25_hours_ago():
    """Return a datetime 25 hours ago (should trigger refresh)."""
    return datetime.now() - timedelta(hours=25)


@pytest.fixture
def time_1_hour_ago():
    """Return a datetime 1 hour ago (should not trigger refresh)."""
    return datetime.now() - timedelta(hours=1)


# ============================================================================
# Configuration fixtures
# ============================================================================

@pytest.fixture
def mock_tmdb_config_update_enabled():
    """Mock tmdb.config with updates enabled."""
    return {
        "tmdb_id": 12345,
        "update_metadata": True,
        "last_updated": (datetime.now() - timedelta(days=2)).isoformat(),
    }


@pytest.fixture
def mock_tmdb_config_update_disabled():
    """Mock tmdb.config with updates disabled."""
    return {
        "tmdb_id": 12345,
        "update_metadata": False,
        "last_updated": (datetime.now() - timedelta(days=2)).isoformat(),
    }


@pytest.fixture
def mock_tmdb_config_with_overrides():
    """Mock tmdb.config with image overrides."""
    return {
        "tmdb_id": 12345,
        "update_metadata": True,
        "override_poster": "/custom_poster.jpg",
        "override_backdrop": "/custom_backdrop.jpg",
        "metadata": {
            "name": "Custom Show Name",
            "overview": "Custom overview text",
        },
        "last_updated": (datetime.now() - timedelta(days=2)).isoformat(),
    }


# ============================================================================
# Performance tracking fixtures
# ============================================================================

@pytest.fixture
def performance_tracker():
    """Track execution time of operations."""
    class PerformanceTracker:
        def __init__(self):
            self.timings = {}
        
        def start(self, label):
            self.timings[label] = {"start": datetime.now()}
        
        def end(self, label):
            if label in self.timings:
                self.timings[label]["end"] = datetime.now()
                self.timings[label]["duration"] = (
                    self.timings[label]["end"] - self.timings[label]["start"]
                ).total_seconds()
        
        def get_duration(self, label):
            return self.timings.get(label, {}).get("duration", 0)
        
        def get_all_timings(self):
            return {
                label: timing.get("duration", 0)
                for label, timing in self.timings.items()
            }
    
    return PerformanceTracker()


# ============================================================================
# Blurhash validation fixtures
# ============================================================================

@pytest.fixture
def blurhash_validator():
    """Utility to validate blurhash format."""
    def _validate_blurhash(blurhash_string):
        """
        Validate that a string is a valid blurhash.
        
        Blurhash format:
        - Minimum 6 characters
        - Contains only base83 characters
        - First character encodes X and Y components
        """
        if not blurhash_string or not isinstance(blurhash_string, str):
            return False
        
        if len(blurhash_string) < 6:
            return False
        
        # Base83 alphabet used by blurhash
        base83_chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"
        
        for char in blurhash_string:
            if char not in base83_chars:
                return False
        
        return True
    
    return _validate_blurhash


# ============================================================================
# Cast and Genre specific fixtures
# ============================================================================

@pytest.fixture
def mock_cast_member_complete():
    """Mock cast member with all fields present."""
    return {
        "id": 1001,
        "name": "John Doe",
        "character": "Main Character",
        "profile_path": "https://image.tmdb.org/t/p/original/actor_profile.jpg"
    }


@pytest.fixture
def mock_cast_member_no_profile():
    """Mock cast member without profile image."""
    return {
        "id": 1002,
        "name": "Jane Smith",
        "character": "Supporting Character",
        "profile_path": None
    }


@pytest.fixture
def mock_genre_drama():
    """Mock Drama genre (TMDB ID: 18)."""
    return {
        "id": 18,
        "name": "Drama"
    }


@pytest.fixture
def mock_genre_action():
    """Mock Action genre (TMDB ID: 28)."""
    return {
        "id": 28,
        "name": "Action"
    }


@pytest.fixture
def mock_tmdb_cast_response():
    """Mock TMDB API credits response with cast data."""
    return {
        "cast": [
            {
                "id": 1001,
                "name": "Lead Actor",
                "character": "Protagonist",
                "profile_path": "/lead_actor.jpg"
            },
            {
                "id": 1002,
                "name": "Supporting Actor",
                "character": "Sidekick",
                "profile_path": "/supporting_actor.jpg"
            }
        ]
    }


@pytest.fixture
def mock_tmdb_cast_response_incomplete():
    """Mock TMDB API cast response with some members missing profile images."""
    return {
        "cast": [
            {
                "id": 1001,
                "name": "Lead Actor",
                "character": "Protagonist",
                "profile_path": "/lead_actor.jpg"
            },
            {
                "id": 1002,
                "name": "Extra",
                "character": "Background Character",
                "profile_path": None  # No profile image
            }
        ]
    }


@pytest.fixture
def mock_complete_tmdb_response(mock_tmdb_tv_response):
    """Mock complete TMDB response with all data including cast and genres."""
    return mock_tmdb_tv_response


@pytest.fixture
def mock_complete_movie_response(mock_tmdb_movie_response):
    """Mock complete TMDB movie response with all data."""
    return mock_tmdb_movie_response


# ============================================================================
# Utility fixtures
# ============================================================================

@pytest.fixture
def create_mock_metadata_file():
    """Factory fixture to create metadata files with specific content."""
    async def _create_file(file_path, content, mtime=None):
        await write_json_file(str(file_path), content)
        
        # Set modification time if specified
        if mtime:
            timestamp = mtime.timestamp()
            os.utime(file_path, (timestamp, timestamp))
        
        return file_path
    
    return _create_file


@pytest.fixture
def assert_file_exists():
    """Utility to assert file existence with helpful error messages."""
    def _assert_exists(file_path, file_type="file"):
        path = Path(file_path)
        assert path.exists(), f"Expected {file_type} does not exist: {file_path}"
        if file_type == "file":
            assert path.is_file(), f"Path exists but is not a file: {file_path}"
        elif file_type == "directory":
            assert path.is_dir(), f"Path exists but is not a directory: {file_path}"
        return True
    
    return _assert_exists


@pytest.fixture
def assert_json_structure():
    """Utility to assert JSON file structure and required fields."""
    async def _assert_structure(file_path, required_fields):
        data = await read_json_file(str(file_path))
        
        for field in required_fields:
            if "." in field:  # Nested field like "cast.0.name"
                parts = field.split(".")
                current = data
                for part in parts:
                    if part.isdigit():
                        current = current[int(part)]
                    else:
                        assert part in current, f"Missing field: {field}"
                        current = current[part]
            else:
                assert field in data, f"Missing required field: {field}"
        
        return data
    
    return _assert_structure


# ============================================================================
# Cleanup
# ============================================================================

@pytest.fixture(autouse=True)
def cleanup_temp_files():
    """Automatically cleanup temporary files after each test."""
    yield
    # Cleanup happens automatically via temp_dir fixture
