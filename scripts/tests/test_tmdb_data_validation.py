"""
TMDB Data Structure Validation Tests

Tests validate that TMDB API data is correctly parsed, structured, and saved:
- Cast member data (id, name, character, profile_path)
- Genre data (id, name)
- Complete metadata.json structure
- Integration with Node.js consumption patterns
"""

import pytest
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from utils.tmdb_utils import (
    fetch_tmdb_media_details,
    fetch_tmdb_cast_details,
)
from utils.file_utils import (
    read_json_file,
    write_json_file,
)


# ============================================================================
# Cast Data Structure Tests
# ============================================================================

@pytest.mark.unit
@pytest.mark.asyncio
class TestCastDataStructure:
    """Validate cast data structure and field requirements."""
    
    async def test_cast_member_has_all_required_fields(self, mock_cast_member_complete):
        """Each cast member must have id, name, character, and profile_path fields."""
        cast_member = mock_cast_member_complete
        
        assert "id" in cast_member, "Cast member must have 'id' field"
        assert "name" in cast_member, "Cast member must have 'name' field"
        assert "character" in cast_member, "Cast member must have 'character' field"
        assert "profile_path" in cast_member, "Cast member must have 'profile_path' field"
    
    async def test_cast_member_id_is_integer(self, mock_cast_member_complete):
        """Cast member ID must be an integer matching TMDB person ID."""
        cast_member = mock_cast_member_complete
        
        assert isinstance(cast_member["id"], int), "Cast ID must be an integer"
        assert cast_member["id"] > 0, "Cast ID must be positive"
    
    async def test_cast_member_name_is_nonempty_string(self, mock_cast_member_complete):
        """Cast member name must be a non-empty string."""
        cast_member = mock_cast_member_complete
        
        assert isinstance(cast_member["name"], str), "Cast name must be a string"
        assert len(cast_member["name"]) > 0, "Cast name cannot be empty"
        assert cast_member["name"].strip() == cast_member["name"], "Cast name should be trimmed"
    
    async def test_cast_member_character_is_string(self, mock_cast_member_complete):
        """Cast member character must be a string (can be empty)."""
        cast_member = mock_cast_member_complete
        
        assert isinstance(cast_member["character"], str), "Character must be a string"
        # Character can be empty string for extras/unnamed roles
    
    async def test_cast_member_profile_path_format_when_present(self, mock_cast_member_complete):
        """Profile path must be a valid TMDB image URL when present."""
        cast_member = mock_cast_member_complete
        
        if cast_member["profile_path"] is not None:
            assert isinstance(cast_member["profile_path"], str), "Profile path must be string or None"
            assert cast_member["profile_path"].startswith("https://image.tmdb.org/t/p/original"), \
                "Profile path must be a valid TMDB image URL"
            assert cast_member["profile_path"].endswith((".jpg", ".png")), \
                "Profile path must be an image file"
    
    async def test_cast_member_profile_path_null_when_missing(self, mock_cast_member_no_profile):
        """Profile path must be None when actor has no image."""
        cast_member = mock_cast_member_no_profile
        
        assert cast_member["profile_path"] is None, \
            "Profile path must be None (not empty string) when missing"
    
    async def test_cast_array_structure(self, mock_tmdb_tv_response):
        """Cast must be an array of cast member objects."""
        cast = mock_tmdb_tv_response["cast"]
        
        assert isinstance(cast, list), "Cast must be a list"
        assert len(cast) > 0, "Cast should not be empty for typical shows"
        
        # Verify all members have the same structure
        for member in cast:
            assert isinstance(member, dict), "Each cast member must be a dict"
            assert "id" in member
            assert "name" in member
    
    async def test_cast_order_preserved(self, mock_tmdb_tv_response):
        """Cast order should be preserved (importance/billing order)."""
        cast = mock_tmdb_tv_response["cast"]
        
        # Verify we have multiple cast members
        assert len(cast) >= 2, "Need at least 2 cast members to test order"
        
        # Cast should be ordered by importance (first IDs should be consistent)
        first_member_id = cast[0]["id"]
        second_member_id = cast[1]["id"]
        
        assert first_member_id == 1001, "First cast member should be consistent"
        assert second_member_id == 1002, "Second cast member should be consistent"


# ============================================================================
# Genre Data Structure Tests
# ============================================================================

@pytest.mark.unit
@pytest.mark.asyncio
class TestGenreDataStructure:
    """Validate genre data structure and TMDB standard compliance."""
    
    async def test_genre_has_id_and_name(self, mock_genre_drama):
        """Each genre must have id and name fields."""
        genre = mock_genre_drama
        
        assert "id" in genre, "Genre must have 'id' field"
        assert "name" in genre, "Genre must have 'name' field"
    
    async def test_genre_id_is_integer(self, mock_genre_drama):
        """Genre ID must be an integer."""
        genre = mock_genre_drama
        
        assert isinstance(genre["id"], int), "Genre ID must be an integer"
        assert genre["id"] > 0, "Genre ID must be positive"
    
    async def test_genre_name_is_nonempty_string(self, mock_genre_drama):
        """Genre name must be a non-empty string."""
        genre = mock_genre_drama
        
        assert isinstance(genre["name"], str), "Genre name must be a string"
        assert len(genre["name"]) > 0, "Genre name cannot be empty"
    
    async def test_genre_id_matches_tmdb_standard(self, mock_genre_drama, mock_genre_action):
        """Genre IDs should match TMDB standard genre IDs."""
        # TMDB standard genre IDs
        TMDB_GENRE_IDS = {
            18: "Drama",
            28: "Action",
            12: "Adventure",
            16: "Animation",
            35: "Comedy",
            80: "Crime",
            99: "Documentary",
            10765: "Sci-Fi & Fantasy",
            10759: "Action & Adventure",
        }
        
        drama = mock_genre_drama
        action = mock_genre_action
        
        assert drama["id"] in TMDB_GENRE_IDS, "Drama ID should match TMDB standard"
        assert action["id"] in TMDB_GENRE_IDS, "Action ID should match TMDB standard"
    
    async def test_genre_name_matches_tmdb_standard(self, mock_genre_drama):
        """Genre name should match TMDB standard naming."""
        genre = mock_genre_drama
        
        # Verify name matches expected format
        assert genre["name"] == "Drama", "Genre name should match TMDB standard"
    
    async def test_multiple_genres_preserved(self, mock_tmdb_tv_response):
        """Multiple genres should be preserved in array."""
        genres = mock_tmdb_tv_response["genres"]
        
        assert isinstance(genres, list), "Genres must be a list"
        assert len(genres) >= 2, "Should support multiple genres"
        
        # Verify structure of each genre
        for genre in genres:
            assert "id" in genre
            assert "name" in genre
    
    async def test_movie_genres_structure(self, mock_tmdb_movie_response):
        """Movie genres should have same structure as TV genres."""
        genres = mock_tmdb_movie_response["genres"]
        
        assert isinstance(genres, list), "Movie genres must be a list"
        
        for genre in genres:
            assert isinstance(genre, dict), "Each genre must be a dict"
            assert "id" in genre
            assert "name" in genre
            assert isinstance(genre["id"], int)
            assert isinstance(genre["name"], str)


# ============================================================================
# TMDB API Response Parsing Tests
# ============================================================================

@pytest.mark.integration
@pytest.mark.asyncio
class TestTMDBAPIResponseParsing:
    """Test parsing of TMDB API responses for cast and genre data."""
    
    async def test_fetch_cast_details_returns_correct_structure(self, mock_tmdb_cast_response):
        """fetch_tmdb_cast_details should return properly structured cast array."""
        from unittest.mock import Mock
        
        # Create properly configured async mock
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=mock_tmdb_cast_response)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = Mock()
        mock_session.get = Mock(return_value=mock_response)
        
        # Fetch cast details
        cast_data = await fetch_tmdb_cast_details(mock_session, 12345, "tv")
        
        # TV shows return structured dict with cast and recurring_cast
        assert isinstance(cast_data, dict), "TV shows should return a dict"
        assert "cast" in cast_data, "Should have 'cast' field"
        assert "recurring_cast" in cast_data, "Should have 'recurring_cast' field"
        
        cast = cast_data["cast"]
        assert isinstance(cast, list), "Cast should be a list"
        assert len(cast) > 0, "Should have cast members"
        
        # Validate first member
        first_member = cast[0]
        assert "id" in first_member
        assert "name" in first_member
        assert "character" in first_member
        assert "profile_path" in first_member
    
    async def test_cast_parsing_with_incomplete_data(self, mock_tmdb_cast_response_incomplete):
        """Should handle cast members with missing profile images."""
        from unittest.mock import Mock
        
        # Create properly configured async mock
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=mock_tmdb_cast_response_incomplete)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = Mock()
        mock_session.get = Mock(return_value=mock_response)
        
        cast_data = await fetch_tmdb_cast_details(mock_session, 12345, "tv")
        
        # Ensure cast data is not None
        assert cast_data is not None, "Cast data should not be None"
        assert isinstance(cast_data, dict), "TV shows should return a dict"
        
        cast = cast_data["cast"]
        assert isinstance(cast, list), "Cast should be a list"
        
        # Find member without profile
        no_profile_member = next((m for m in cast if m["profile_path"] is None), None)
        
        assert no_profile_member is not None, "Should handle members without profile images"
        assert "name" in no_profile_member, "Should still have name"
        assert no_profile_member["profile_path"] is None, "Should be None, not empty string"
    
    async def test_fetch_media_details_includes_cast(self, mock_complete_tmdb_response):
        """fetch_tmdb_media_details should include cast in response."""
        from unittest.mock import Mock
        
        # Setup mock for multiple API calls (details + aggregate_credits + videos + images + rating)
        responses = [
            mock_complete_tmdb_response,  # Main details
            {"cast": mock_complete_tmdb_response["cast"]},  # Aggregate credits for TV
            {"results": [{"type": "Trailer", "site": "YouTube", "key": "test123"}]},  # Videos
            {"logos": [{"iso_639_1": "en", "file_path": "/test_logo.png"}]},  # Images
            {"results": [{"iso_3166_1": "US", "rating": "TV-14"}]},  # Content ratings
        ]
        
        call_count = [0]
        
        async def mock_json():
            result = responses[min(call_count[0], len(responses) - 1)]
            call_count[0] += 1
            return result
        
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = mock_json
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = Mock()
        mock_session.get = Mock(return_value=mock_response)
        
        media_details = await fetch_tmdb_media_details(
            mock_session, "Test Show", tmdb_id=12345, media_type="tv"
        )
        
        assert media_details is not None, "Media details should not be None"
        assert "cast" in media_details, "Media details should include cast"
        assert isinstance(media_details["cast"], list), "Cast should be a list"
    
    async def test_genre_extraction_from_api_response(self, mock_complete_tmdb_response):
        """Should correctly extract genres from API response."""
        genres = mock_complete_tmdb_response.get("genres", [])
        
        assert len(genres) > 0, "Should have genres"
        
        for genre in genres:
            assert isinstance(genre["id"], int)
            assert isinstance(genre["name"], str)


# ============================================================================
# Metadata JSON Integration Tests
# ============================================================================

@pytest.mark.integration
@pytest.mark.asyncio
class TestMetadataJSONStructure:
    """Validate saved metadata.json structure for Node.js consumption."""
    
    async def test_metadata_json_contains_cast_array(
        self, mock_tv_show_structure, mock_complete_tmdb_response
    ):
        """Saved metadata.json must contain cast array."""
        metadata_path = mock_tv_show_structure["metadata_path"]
        
        # Write metadata
        await write_json_file(str(metadata_path), mock_complete_tmdb_response)
        
        # Read and validate
        metadata = await read_json_file(str(metadata_path))
        
        assert "cast" in metadata, "Metadata must include cast"
        assert isinstance(metadata["cast"], list), "Cast must be an array"
        assert len(metadata["cast"]) > 0, "Cast should not be empty"
    
    async def test_metadata_json_contains_genres_array(
        self, mock_tv_show_structure, mock_complete_tmdb_response
    ):
        """Saved metadata.json must contain genres array."""
        metadata_path = mock_tv_show_structure["metadata_path"]
        
        await write_json_file(str(metadata_path), mock_complete_tmdb_response)
        metadata = await read_json_file(str(metadata_path))
        
        assert "genres" in metadata, "Metadata must include genres"
        assert isinstance(metadata["genres"], list), "Genres must be an array"
    
    async def test_metadata_structure_matches_node_expectations(
        self, mock_tv_show_structure, mock_complete_tmdb_response, assert_json_structure
    ):
        """Saved metadata should match Node.js consumption patterns."""
        metadata_path = mock_tv_show_structure["metadata_path"]
        
        await write_json_file(str(metadata_path), mock_complete_tmdb_response)
        
        # Define required fields based on Node.js usage
        required_fields = [
            "id",
            "name",
            "overview",
            "poster_path",
            "backdrop_path",
            "genres",
            "cast",
            "cast.0.id",
            "cast.0.name",
            "cast.0.character",
            "genres.0.id",
            "genres.0.name",
        ]
        
        metadata = await assert_json_structure(metadata_path, required_fields)
        
        # Additional validations
        assert metadata["id"] == mock_complete_tmdb_response["id"]
        assert len(metadata["cast"]) == len(mock_complete_tmdb_response["cast"])
        assert len(metadata["genres"]) == len(mock_complete_tmdb_response["genres"])
    
    async def test_cast_data_survives_json_serialization(
        self, mock_tv_show_structure, mock_complete_tmdb_response
    ):
        """Cast data should maintain integrity through JSON serialization."""
        metadata_path = mock_tv_show_structure["metadata_path"]
        
        original_cast = mock_complete_tmdb_response["cast"]
        
        # Write and read
        await write_json_file(str(metadata_path), mock_complete_tmdb_response)
        metadata = await read_json_file(str(metadata_path))
        
        saved_cast = metadata["cast"]
        
        # Compare structure
        assert len(saved_cast) == len(original_cast)
        
        for original, saved in zip(original_cast, saved_cast):
            assert saved["id"] == original["id"]
            assert saved["name"] == original["name"]
            assert saved["character"] == original["character"]
            assert saved["profile_path"] == original["profile_path"]
    
    async def test_movie_metadata_structure(
        self, mock_movie_structure, mock_complete_movie_response
    ):
        """Movie metadata should have same cast/genre structure as TV."""
        metadata_path = mock_movie_structure["metadata_path"]
        
        await write_json_file(str(metadata_path), mock_complete_movie_response)
        metadata = await read_json_file(str(metadata_path))
        
        # Should have same structure
        assert "cast" in metadata
        assert "genres" in metadata
        assert isinstance(metadata["cast"], list)
        assert isinstance(metadata["genres"], list)


# ============================================================================
# Edge Case Handling Tests
# ============================================================================

@pytest.mark.unit
@pytest.mark.asyncio
class TestEdgeCases:
    """Test handling of edge cases in cast/genre data."""
    
    async def test_empty_cast_array_handled(self):
        """Should handle media with no cast information."""
        from unittest.mock import Mock
        
        empty_cast_response = {"cast": []}
        
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=empty_cast_response)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = Mock()
        mock_session.get = Mock(return_value=mock_response)
        
        cast_data = await fetch_tmdb_cast_details(mock_session, 12345, "tv")
        
        # TV shows return structured dict
        assert isinstance(cast_data, dict), "TV shows should return a dict"
        assert len(cast_data["cast"]) == 0, "Should handle empty cast"
        assert len(cast_data["recurring_cast"]) == 0, "Should have empty recurring_cast"
    
    async def test_cast_with_special_characters_in_name(self):
        """Should handle cast names with special characters."""
        cast_member = {
            "id": 1,
            "name": "Zoë Saldaña",  # Special characters
            "character": "Neytiri",
            "profile_path": "https://image.tmdb.org/t/p/original/test.jpg"
        }
        
        # Should serialize/deserialize correctly
        json_str = json.dumps(cast_member)
        parsed = json.loads(json_str)
        
        assert parsed["name"] == cast_member["name"]
    
    async def test_cast_with_very_long_character_name(self):
        """Should handle very long character names."""
        long_character = "The Ancient One, Sorcerer Supreme, Protector of the Earth Dimension"
        
        cast_member = {
            "id": 1,
            "name": "Tilda Swinton",
            "character": long_character,
            "profile_path": "https://image.tmdb.org/t/p/original/test.jpg"
        }
        
        # Should handle long strings
        assert len(cast_member["character"]) > 50
        assert isinstance(cast_member["character"], str)
    
    async def test_null_cast_response_handled(self):
        """Should handle null cast response from API."""
        from unittest.mock import Mock
        
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=None)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = Mock()
        mock_session.get = Mock(return_value=mock_response)
        
        cast_data = await fetch_tmdb_cast_details(mock_session, 12345, "tv")
        
        # Should return None or valid structure, not crash
        assert cast_data is None or (isinstance(cast_data, dict) and "cast" in cast_data)


# ============================================================================
# Performance Tests
# ============================================================================

@pytest.mark.performance
@pytest.mark.slow
@pytest.mark.asyncio
class TestCastGenrePerformance:
    """Test performance with large cast/genre arrays."""
    
    async def test_large_cast_array_performance(self, performance_tracker):
        """Should handle shows with large cast (50+ members) efficiently."""
        # Create large cast array
        large_cast = [
            {
                "id": i,
                "name": f"Actor {i}",
                "character": f"Character {i}",
                "profile_path": f"https://image.tmdb.org/t/p/original/actor{i}.jpg"
            }
            for i in range(100)
        ]
        
        performance_tracker.start("large_cast_serialization")
        
        # Serialize and deserialize
        json_str = json.dumps({"cast": large_cast})
        parsed = json.loads(json_str)
        
        performance_tracker.end("large_cast_serialization")
        
        duration = performance_tracker.get_duration("large_cast_serialization")
        
        assert len(parsed["cast"]) == 100
        assert duration < 1.0, "Should handle 100 cast members in < 1 second"
