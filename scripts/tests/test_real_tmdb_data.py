"""
Real TMDB API Integration Tests

Tests against actual TMDB API data for specific movie and TV show IDs.
This validates that our implementation correctly handles real-world TMDB responses.

Requires:
- Valid TMDB_API_KEY environment variable
- Internet connection

Test IDs:
- Movie: 701387 (Prey)
- TV Show: 60622 (Station Eleven)
"""

import pytest
import aiohttp
import os
from pathlib import Path

from utils.tmdb_utils import (
    fetch_tmdb_media_details,
    fetch_tmdb_cast_details,
)
from utils.file_utils import write_json_file


# Skip if no API key available
pytestmark = pytest.mark.skipif(
    not os.getenv('TMDB_API_KEY') or os.getenv('TMDB_API_KEY') == 'test_mock_api_key_12345',
    reason="Requires valid TMDB_API_KEY environment variable"
)


@pytest.mark.integration
@pytest.mark.slow
@pytest.mark.asyncio
class TestRealMovieData:
    """Test against real movie data: Prey (TMDB ID: 701387)."""
    
    async def test_fetch_prey_movie_details(self):
        """Fetch and validate Prey (2022) movie metadata."""
        async with aiohttp.ClientSession() as session:
            movie_data = await fetch_tmdb_media_details(
                session,
                "Prey",
                tmdb_id=701387,
                media_type='movie'
            )
            
            # Basic validation
            assert movie_data is not None, "Should fetch movie data"
            assert isinstance(movie_data, dict), "Should return dict"
            assert movie_data['id'] == 701387, "Should have correct TMDB ID"
            
            # Validate title
            assert 'title' in movie_data, "Should have title"
            print(f"\n✓ Movie Title: {movie_data['title']}")
            
            # Validate overview
            assert 'overview' in movie_data, "Should have overview"
            assert len(movie_data['overview']) > 0, "Overview should not be empty"
            print(f"✓ Overview length: {len(movie_data['overview'])} chars")
            
            # Validate release date
            assert 'release_date' in movie_data, "Should have release_date"
            print(f"✓ Release Date: {movie_data.get('release_date')}")
    
    async def test_prey_cast_structure(self):
        """Validate cast structure for Prey movie."""
        async with aiohttp.ClientSession() as session:
            movie_data = await fetch_tmdb_media_details(
                session,
                "Prey",
                tmdb_id=701387,
                media_type='movie'
            )
            
            # Type guard
            assert movie_data is not None and isinstance(movie_data, dict), "Should fetch movie data"
            
            # Validate cast presence
            assert 'cast' in movie_data, "Should include cast"
            cast = movie_data['cast']
            assert isinstance(cast, list), "Cast should be a list"
            assert len(cast) > 0, "Cast should not be empty"
            
            print(f"\n✓ Cast Members: {len(cast)}")
            
            # Validate first cast member structure
            first_member = cast[0]
            assert 'id' in first_member, "Cast member should have id"
            assert 'name' in first_member, "Cast member should have name"
            assert 'character' in first_member, "Cast member should have character"
            assert 'profile_path' in first_member, "Cast member should have profile_path"
            
            # Validate data types
            assert isinstance(first_member['id'], int), "Cast ID should be integer"
            assert isinstance(first_member['name'], str), "Cast name should be string"
            assert len(first_member['name']) > 0, "Cast name should not be empty"
            
            print(f"✓ Lead Actor: {first_member['name']} as {first_member['character']}")
            
            # Print first 5 cast members
            print("\nFirst 5 Cast Members:")
            for i, member in enumerate(cast[:5], 1):
                profile_status = "✓" if member['profile_path'] else "✗"
                print(f"  {i}. {member['name']} as {member['character']} [{profile_status} profile]")
    
    async def test_prey_genre_structure(self):
        """Validate genre structure for Prey movie."""
        async with aiohttp.ClientSession() as session:
            movie_data = await fetch_tmdb_media_details(
                session,
                "Prey",
                tmdb_id=701387,
                media_type='movie'
            )
            
            # Type guard
            assert movie_data is not None and isinstance(movie_data, dict), "Should fetch movie data"
            
            # Validate genres
            assert 'genres' in movie_data, "Should include genres"
            genres = movie_data['genres']
            assert isinstance(genres, list), "Genres should be a list"
            assert len(genres) > 0, "Should have at least one genre"
            
            print(f"\n✓ Genres: {len(genres)}")
            
            # Validate genre structure
            for genre in genres:
                assert 'id' in genre, "Genre should have id"
                assert 'name' in genre, "Genre should have name"
                assert isinstance(genre['id'], int), "Genre ID should be integer"
                assert isinstance(genre['name'], str), "Genre name should be string"
                
                print(f"  - {genre['name']} (ID: {genre['id']})")
    
    async def test_prey_additional_metadata(self):
        """Validate additional metadata fields for Prey."""
        async with aiohttp.ClientSession() as session:
            movie_data = await fetch_tmdb_media_details(
                session,
                "Prey",
                tmdb_id=701387,
                media_type='movie'
            )
            
            # Type guard
            assert movie_data is not None and isinstance(movie_data, dict), "Should fetch movie data"
            
            # Validate images
            assert 'poster_path' in movie_data, "Should have poster_path"
            assert 'backdrop_path' in movie_data, "Should have backdrop_path"
            
            print(f"\n✓ Poster: {'Present' if movie_data.get('poster_path') else 'Missing'}")
            print(f"✓ Backdrop: {'Present' if movie_data.get('backdrop_path') else 'Missing'}")
            
            # Validate logo
            assert 'logo_path' in movie_data, "Should have logo_path"
            print(f"✓ Logo: {'Present' if movie_data.get('logo_path') else 'Missing'}")
            
            # Validate trailer
            assert 'trailer_url' in movie_data, "Should have trailer_url"
            print(f"✓ Trailer: {'Present' if movie_data.get('trailer_url') else 'Missing'}")
            
            # Validate rating
            assert 'rating' in movie_data, "Should have rating"
            print(f"✓ Rating: {movie_data.get('rating', 'Not Rated')}")
            
            # Validate last_updated
            assert 'last_updated' in movie_data, "Should have last_updated timestamp"
            print(f"✓ Last Updated: {movie_data.get('last_updated')}")
    
    async def test_prey_save_metadata(self, temp_dir):
        """Test saving Prey metadata to JSON file."""
        async with aiohttp.ClientSession() as session:
            movie_data = await fetch_tmdb_media_details(
                session,
                "Prey",
                tmdb_id=701387,
                media_type='movie'
            )
            
            # Type guard
            assert movie_data is not None and isinstance(movie_data, dict), "Should fetch movie data"
            
            # Save to file
            metadata_file = temp_dir / "prey_metadata.json"
            await write_json_file(str(metadata_file), movie_data)
            
            # Validate file exists
            assert metadata_file.exists(), "Metadata file should be created"
            
            # Validate file can be read
            import json
            with open(metadata_file, 'r') as f:
                saved_data = json.load(f)
            
            assert saved_data['id'] == 701387, "Saved data should match"
            assert len(saved_data['cast']) == len(movie_data['cast']), "Cast should be preserved"
            assert len(saved_data['genres']) == len(movie_data['genres']), "Genres should be preserved"
            
            print(f"\n✓ Metadata saved successfully to {metadata_file.name}")
            print(f"✓ File size: {metadata_file.stat().st_size} bytes")


@pytest.mark.integration
@pytest.mark.slow
@pytest.mark.asyncio
class TestRealTVShowData:
    """Test against real TV show data: Station Eleven (TMDB ID: 60622)."""
    
    async def test_fetch_station_eleven_details(self):
        """Fetch and validate Station Eleven TV show metadata."""
        async with aiohttp.ClientSession() as session:
            show_data = await fetch_tmdb_media_details(
                session,
                "Station Eleven",
                tmdb_id=60622,
                media_type='tv'
            )
            
            # Type guard
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            assert show_data['id'] == 60622, "Should have correct TMDB ID"
            
            # Validate name
            assert 'name' in show_data, "Should have name"
            print(f"\n✓ TV Show Name: {show_data['name']}")
            
            # Validate overview
            assert 'overview' in show_data, "Should have overview"
            assert len(show_data['overview']) > 0, "Overview should not be empty"
            print(f"✓ Overview length: {len(show_data['overview'])} chars")
            
            # Validate air dates
            assert 'first_air_date' in show_data, "Should have first_air_date"
            print(f"✓ First Air Date: {show_data.get('first_air_date')}")
    
    async def test_station_eleven_cast_structure(self):
        """Validate cast structure for Station Eleven."""
        async with aiohttp.ClientSession() as session:
            show_data = await fetch_tmdb_media_details(
                session,
                "Station Eleven",
                tmdb_id=60622,
                media_type='tv'
            )
            
            # Type guard
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            
            # Validate cast presence
            assert 'cast' in show_data, "Should include cast"
            cast = show_data['cast']
            assert isinstance(cast, list), "Cast should be a list"
            assert len(cast) > 0, "Cast should not be empty"
            
            print(f"\n✓ Cast Members: {len(cast)}")
            
            # Validate first cast member structure
            first_member = cast[0]
            assert 'id' in first_member, "Cast member should have id"
            assert 'name' in first_member, "Cast member should have name"
            assert 'character' in first_member, "Cast member should have character"
            assert 'profile_path' in first_member, "Cast member should have profile_path"
            
            # Validate data types
            assert isinstance(first_member['id'], int), "Cast ID should be integer"
            assert isinstance(first_member['name'], str), "Cast name should be string"
            assert len(first_member['name']) > 0, "Cast name should not be empty"
            
            print(f"✓ Lead Actor: {first_member['name']} as {first_member['character']}")
            
            # Print first 5 cast members
            print("\nFirst 5 Cast Members:")
            for i, member in enumerate(cast[:5], 1):
                profile_status = "✓" if member['profile_path'] else "✗"
                print(f"  {i}. {member['name']} as {member['character']} [{profile_status} profile]")
    
    async def test_station_eleven_genre_structure(self):
        """Validate genre structure for Station Eleven."""
        async with aiohttp.ClientSession() as session:
            show_data = await fetch_tmdb_media_details(
                session,
                "Station Eleven",
                tmdb_id=60622,
                media_type='tv'
            )
            
            # Type guard
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            
            # Validate genres
            assert 'genres' in show_data, "Should include genres"
            genres = show_data['genres']
            assert isinstance(genres, list), "Genres should be a list"
            assert len(genres) > 0, "Should have at least one genre"
            
            print(f"\n✓ Genres: {len(genres)}")
            
            # Validate genre structure
            for genre in genres:
                assert 'id' in genre, "Genre should have id"
                assert 'name' in genre, "Genre should have name"
                assert isinstance(genre['id'], int), "Genre ID should be integer"
                assert isinstance(genre['name'], str), "Genre name should be string"
                
                print(f"  - {genre['name']} (ID: {genre['id']})")
    
    async def test_station_eleven_seasons(self):
        """Validate seasons structure for Station Eleven."""
        async with aiohttp.ClientSession() as session:
            show_data = await fetch_tmdb_media_details(
                session,
                "Station Eleven",
                tmdb_id=60622,
                media_type='tv'
            )
            
            # Type guard
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            
            # Validate seasons
            assert 'seasons' in show_data, "Should include seasons"
            seasons = show_data['seasons']
            assert isinstance(seasons, list), "Seasons should be a list"
            assert len(seasons) > 0, "Should have at least one season"
            
            print(f"\n✓ Total Seasons: {len(seasons)}")
            
            # Validate season structure
            for season in seasons:
                assert 'season_number' in season, "Season should have season_number"
                assert 'episode_count' in season, "Season should have episode_count"
                
                season_num = season['season_number']
                ep_count = season['episode_count']
                poster = "✓" if season.get('poster_path') else "✗"
                
                print(f"  Season {season_num}: {ep_count} episodes [{poster} poster]")
    
    async def test_station_eleven_additional_metadata(self):
        """Validate additional metadata fields for Station Eleven."""
        async with aiohttp.ClientSession() as session:
            show_data = await fetch_tmdb_media_details(
                session,
                "Station Eleven",
                tmdb_id=60622,
                media_type='tv'
            )
            
            # Type guard
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            
            # Validate images
            assert 'poster_path' in show_data, "Should have poster_path"
            assert 'backdrop_path' in show_data, "Should have backdrop_path"
            
            print(f"\n✓ Poster: {'Present' if show_data.get('poster_path') else 'Missing'}")
            print(f"✓ Backdrop: {'Present' if show_data.get('backdrop_path') else 'Missing'}")
            
            # Validate logo
            assert 'logo_path' in show_data, "Should have logo_path"
            print(f"✓ Logo: {'Present' if show_data.get('logo_path') else 'Missing'}")
            
            # Validate trailer
            assert 'trailer_url' in show_data, "Should have trailer_url"
            print(f"✓ Trailer: {'Present' if show_data.get('trailer_url') else 'Missing'}")
            
            # Validate rating
            assert 'rating' in show_data, "Should have rating"
            print(f"✓ Rating: {show_data.get('rating', 'Not Rated')}")
            
            # Validate episode count
            if 'number_of_episodes' in show_data:
                print(f"✓ Total Episodes: {show_data['number_of_episodes']}")
    
    async def test_station_eleven_save_metadata(self, temp_dir):
        """Test saving Station Eleven metadata to JSON file."""
        async with aiohttp.ClientSession() as session:
            show_data = await fetch_tmdb_media_details(
                session,
                "Station Eleven",
                tmdb_id=60622,
                media_type='tv'
            )
            
            # Type guard
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            
            # Save to file
            metadata_file = temp_dir / "station_eleven_metadata.json"
            await write_json_file(str(metadata_file), show_data)
            
            # Validate file exists
            assert metadata_file.exists(), "Metadata file should be created"
            
            # Validate file can be read
            import json
            with open(metadata_file, 'r') as f:
                saved_data = json.load(f)
            
            assert saved_data['id'] == 60622, "Saved data should match"
            assert len(saved_data['cast']) == len(show_data['cast']), "Cast should be preserved"
            assert len(saved_data['genres']) == len(show_data['genres']), "Genres should be preserved"
            assert len(saved_data['seasons']) == len(show_data['seasons']), "Seasons should be preserved"
            
            print(f"\n✓ Metadata saved successfully to {metadata_file.name}")
            print(f"✓ File size: {metadata_file.stat().st_size} bytes")


@pytest.mark.integration
@pytest.mark.slow
@pytest.mark.asyncio
class TestRealDataComparison:
    """Compare movie vs TV show data structures."""
    
    async def test_cast_structure_consistency(self):
        """Verify cast structure is consistent between movies and TV shows."""
        async with aiohttp.ClientSession() as session:
            # Fetch both
            movie_data = await fetch_tmdb_media_details(
                session, "Prey", tmdb_id=701387, media_type='movie'
            )
            show_data = await fetch_tmdb_media_details(
                session, "Station Eleven", tmdb_id=60622, media_type='tv'
            )
            
            # Type guards
            assert movie_data is not None and isinstance(movie_data, dict), "Should fetch movie data"
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            
            # Both should have cast
            assert 'cast' in movie_data, "Movie should have cast"
            assert 'cast' in show_data, "Show should have cast"
            
            # TV shows should also have recurring_cast
            assert 'recurring_cast' in show_data, "TV shows should have recurring_cast field"
            
            # Compare structure of first cast member
            movie_cast = movie_data['cast'][0]
            show_cast = show_data['cast'][0]
            
            movie_keys = set(movie_cast.keys())
            show_keys = set(show_cast.keys())
            
            # Movies have basic fields
            required_movie_fields = {'id', 'name', 'character', 'profile_path'}
            assert required_movie_fields.issubset(movie_keys), f"Movie cast missing required fields: {required_movie_fields - movie_keys}"
            
            # TV shows have enhanced fields from aggregate_credits
            required_show_fields = {'id', 'name', 'character', 'profile_path', 'roles', 'total_episode_count', 'type', 'known_for_department'}
            assert required_show_fields.issubset(show_keys), f"TV show cast missing required fields: {required_show_fields - show_keys}"
            
            # Verify TV cast has proper type classification
            assert show_cast['type'] in ['Season Regular', 'Recurring', 'Guest Star'], "TV cast should have valid type classification"
            assert isinstance(show_cast['total_episode_count'], int), "TV cast should have integer episode count"
            
            print(f"\n✓ Cast structure is appropriate for each media type")
            print(f"  Movie keys: {', '.join(sorted(movie_keys))}")
            print(f"  TV show keys: {', '.join(sorted(show_keys))}")
            print(f"  TV show has {len(show_data['recurring_cast'])} recurring cast members")
    
    async def test_genre_structure_consistency(self):
        """Verify genre structure is consistent between movies and TV shows."""
        async with aiohttp.ClientSession() as session:
            # Fetch both
            movie_data = await fetch_tmdb_media_details(
                session, "Prey", tmdb_id=701387, media_type='movie'
            )
            show_data = await fetch_tmdb_media_details(
                session, "Station Eleven", tmdb_id=60622, media_type='tv'
            )
            
            # Type guards
            assert movie_data is not None and isinstance(movie_data, dict), "Should fetch movie data"
            assert show_data is not None and isinstance(show_data, dict), "Should fetch show data"
            
            # Both should have genres
            assert 'genres' in movie_data, "Movie should have genres"
            assert 'genres' in show_data, "Show should have genres"
            
            # Compare structure
            movie_genre = movie_data['genres'][0]
            show_genre = show_data['genres'][0]
            
            movie_keys = set(movie_genre.keys())
            show_keys = set(show_genre.keys())
            
            # Should have same keys
            assert movie_keys == show_keys, "Genre structure should be identical"
            
            print(f"\n✓ Genre structure is consistent")
            print(f"  Keys: {', '.join(sorted(movie_keys))}")
