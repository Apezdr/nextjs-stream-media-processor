"""
Comprehensive Type Validation Tests for TMDB Metadata

These tests validate that all fields in TMDB API responses have the correct types.
Based on actual API responses from:
- Movie: Bugonia (TMDB ID: 701387)
- TV Show: Fargo (TMDB ID: 60622)

All type assertions are explicit and based on real-world data.
"""

import pytest
from typing import Union


@pytest.mark.unit
class TestMovieMetadataTypeValidation:
    """Comprehensive type validation for movie metadata fields."""
    
    def test_movie_boolean_fields(self, mock_tmdb_movie_response):
        """Validate all boolean fields in movie metadata."""
        movie = mock_tmdb_movie_response
        
        # Boolean fields (required)
        assert isinstance(movie.get('adult'), bool), "adult must be bool"
        assert isinstance(movie.get('video'), bool), "video must be bool"
    
    def test_movie_integer_fields(self, mock_tmdb_movie_response):
        """Validate all integer fields in movie metadata."""
        movie = mock_tmdb_movie_response
        
        # Integer fields (required)
        assert isinstance(movie['id'], int), "id must be int"
        assert isinstance(movie.get('budget'), int), "budget must be int"
        assert isinstance(movie.get('revenue'), int), "revenue must be int"
        assert isinstance(movie.get('runtime'), int), "runtime must be int (minutes)"
        assert isinstance(movie.get('vote_count'), int), "vote_count must be int"
        
        # Validate positive values where appropriate
        assert movie['id'] > 0, "id must be positive"
        if movie.get('runtime'):
            assert movie['runtime'] > 0, "runtime must be positive if present"
    
    def test_movie_float_fields(self, mock_tmdb_movie_response):
        """Validate all float/numeric fields in movie metadata."""
        movie = mock_tmdb_movie_response
        
        # Float fields
        assert isinstance(movie.get('popularity'), (float, int)), "popularity must be numeric"
        assert isinstance(movie.get('vote_average'), (float, int)), "vote_average must be numeric"
        
        # Validate ranges
        if movie.get('vote_average') is not None:
            assert 0 <= movie['vote_average'] <= 10, "vote_average should be 0-10"
    
    def test_movie_string_fields(self, mock_tmdb_movie_response):
        """Validate all string fields in movie metadata."""
        movie = mock_tmdb_movie_response
        
        # Required string fields
        assert isinstance(movie.get('title'), str), "title must be str"
        assert isinstance(movie.get('original_title'), str), "original_title must be str"
        assert isinstance(movie.get('original_language'), str), "original_language must be str"
        
        # Optional string fields
        assert isinstance(movie.get('backdrop_path'), (str, type(None))), "backdrop_path must be str or None"
        assert isinstance(movie.get('poster_path'), (str, type(None))), "poster_path must be str or None"
        assert isinstance(movie.get('homepage'), (str, type(None))), "homepage must be str or None"
        assert isinstance(movie.get('imdb_id'), (str, type(None))), "imdb_id must be str or None"
        assert isinstance(movie.get('overview'), (str, type(None))), "overview must be str or None"
        assert isinstance(movie.get('release_date'), (str, type(None))), "release_date must be str or None"
        assert isinstance(movie.get('status'), (str, type(None))), "status must be str or None"
        assert isinstance(movie.get('tagline'), (str, type(None))), "tagline must be str or None"
        
        # Custom fields from our implementation
        assert isinstance(movie.get('trailer_url'), (str, type(None))), "trailer_url must be str or None"
        assert isinstance(movie.get('logo_path'), (str, type(None))), "logo_path must be str or None"
        assert isinstance(movie.get('rating'), (str, type(None))), "rating must be str or None"
        assert isinstance(movie.get('last_updated'), (str, type(None))), "last_updated must be str or None"
        
        # Validate ISO language code format
        if movie.get('original_language'):
            assert len(movie['original_language']) == 2, "original_language should be 2-char ISO code"
        
        # Validate IMDB ID format if present
        if movie.get('imdb_id'):
            assert movie['imdb_id'].startswith('tt'), "imdb_id should start with 'tt'"
    
    def test_movie_array_fields(self, mock_tmdb_movie_response):
        """Validate all array fields in movie metadata."""
        movie = mock_tmdb_movie_response
        
        # Array fields
        assert isinstance(movie.get('genres'), list), "genres must be list"
        assert isinstance(movie.get('cast'), list), "cast must be list"
        assert isinstance(movie.get('origin_country'), (list, type(None))), "origin_country must be list or None"
        assert isinstance(movie.get('production_companies'), (list, type(None))), "production_companies must be list or None"
        assert isinstance(movie.get('production_countries'), (list, type(None))), "production_countries must be list or None"
        assert isinstance(movie.get('spoken_languages'), (list, type(None))), "spoken_languages must be list or None"
    
    def test_movie_nullable_fields(self, mock_tmdb_movie_response):
        """Validate fields that can be null."""
        movie = mock_tmdb_movie_response
        
        # Fields that are commonly null
        belongs_to_collection = movie.get('belongs_to_collection')
        assert belongs_to_collection is None or isinstance(belongs_to_collection, dict), \
            "belongs_to_collection must be dict or None"


@pytest.mark.unit
class TestTVShowMetadataTypeValidation:
    """Comprehensive type validation for TV show metadata fields."""
    
    def test_tv_boolean_fields(self, mock_tmdb_tv_response):
        """Validate all boolean fields in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # Boolean fields
        assert isinstance(show.get('adult'), bool), "adult must be bool"
        assert isinstance(show.get('in_production'), (bool, type(None))), "in_production must be bool or None"
    
    def test_tv_integer_fields(self, mock_tmdb_tv_response):
        """Validate all integer fields in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # Integer fields (required)
        assert isinstance(show['id'], int), "id must be int"
        assert isinstance(show.get('number_of_episodes'), (int, type(None))), "number_of_episodes must be int or None"
        assert isinstance(show.get('number_of_seasons'), (int, type(None))), "number_of_seasons must be int or None"
        assert isinstance(show.get('vote_count'), (int, type(None))), "vote_count must be int or None"
        
        # Validate positive values
        assert show['id'] > 0, "id must be positive"
        if show.get('number_of_episodes'):
            assert show['number_of_episodes'] > 0, "number_of_episodes must be positive if present"
        if show.get('number_of_seasons'):
            assert show['number_of_seasons'] > 0, "number_of_seasons must be positive if present"
    
    def test_tv_float_fields(self, mock_tmdb_tv_response):
        """Validate all float/numeric fields in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # Float fields
        assert isinstance(show.get('popularity'), (float, int, type(None))), "popularity must be numeric or None"
        assert isinstance(show.get('vote_average'), (float, int, type(None))), "vote_average must be numeric or None"
        
        # Validate ranges
        if show.get('vote_average') is not None:
            assert 0 <= show['vote_average'] <= 10, "vote_average should be 0-10"
    
    def test_tv_string_fields(self, mock_tmdb_tv_response):
        """Validate all string fields in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # Required string fields
        assert isinstance(show.get('name'), str), "name must be str"
        assert isinstance(show.get('original_name'), str), "original_name must be str"
        assert isinstance(show.get('original_language'), str), "original_language must be str"
        
        # Optional string fields
        assert isinstance(show.get('backdrop_path'), (str, type(None))), "backdrop_path must be str or None"
        assert isinstance(show.get('poster_path'), (str, type(None))), "poster_path must be str or None"
        assert isinstance(show.get('homepage'), (str, type(None))), "homepage must be str or None"
        assert isinstance(show.get('overview'), (str, type(None))), "overview must be str or None"
        assert isinstance(show.get('first_air_date'), (str, type(None))), "first_air_date must be str or None"
        assert isinstance(show.get('last_air_date'), (str, type(None))), "last_air_date must be str or None"
        assert isinstance(show.get('status'), (str, type(None))), "status must be str or None"
        assert isinstance(show.get('tagline'), (str, type(None))), "tagline must be str or None"
        assert isinstance(show.get('type'), (str, type(None))), "type must be str or None"
        
        # Custom fields from our implementation
        assert isinstance(show.get('trailer_url'), (str, type(None))), "trailer_url must be str or None"
        assert isinstance(show.get('logo_path'), (str, type(None))), "logo_path must be str or None"
        assert isinstance(show.get('rating'), (str, type(None))), "rating must be str or None"
        assert isinstance(show.get('last_updated'), (str, type(None))), "last_updated must be str or None"
    
    def test_tv_array_fields(self, mock_tmdb_tv_response):
        """Validate all array fields in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # Array fields
        assert isinstance(show.get('genres'), list), "genres must be list"
        assert isinstance(show.get('cast'), list), "cast must be list"
        assert isinstance(show.get('seasons'), list), "seasons must be list"
        assert isinstance(show.get('created_by'), (list, type(None))), "created_by must be list or None"
        assert isinstance(show.get('episode_run_time'), (list, type(None))), "episode_run_time must be list or None"
        assert isinstance(show.get('languages'), (list, type(None))), "languages must be list or None"
        assert isinstance(show.get('networks'), (list, type(None))), "networks must be list or None"
        assert isinstance(show.get('origin_country'), (list, type(None))), "origin_country must be list or None"
        assert isinstance(show.get('production_companies'), (list, type(None))), "production_companies must be list or None"
        assert isinstance(show.get('production_countries'), (list, type(None))), "production_countries must be list or None"
        assert isinstance(show.get('spoken_languages'), (list, type(None))), "spoken_languages must be list or None"
    
    def test_tv_object_fields(self, mock_tmdb_tv_response):
        """Validate object/dict fields in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # Optional object fields
        last_episode = show.get('last_episode_to_air')
        assert last_episode is None or isinstance(last_episode, dict), \
            "last_episode_to_air must be dict or None"
        
        next_episode = show.get('next_episode_to_air')
        assert next_episode is None or isinstance(next_episode, dict), \
            "next_episode_to_air must be dict or None"


@pytest.mark.unit
class TestCastMemberTypeValidation:
    """Type validation for cast member objects."""
    
    def test_cast_member_required_fields(self, mock_cast_member_complete):
        """Validate all required fields in cast member objects."""
        cast = mock_cast_member_complete
        
        # All cast members must have these fields
        assert 'id' in cast, "Cast member must have id"
        assert 'name' in cast, "Cast member must have name"
        assert 'character' in cast, "Cast member must have character"
        assert 'profile_path' in cast, "Cast member must have profile_path (can be None)"
    
    def test_cast_member_field_types(self, mock_cast_member_complete):
        """Validate data types of all cast member fields."""
        cast = mock_cast_member_complete
        
        # Type validation
        assert isinstance(cast['id'], int), "Cast id must be int"
        assert isinstance(cast['name'], str), "Cast name must be str"
        assert isinstance(cast['character'], str), "Cast character must be str"
        assert isinstance(cast['profile_path'], (str, type(None))), \
            "Cast profile_path must be str or None"
        
        # Value validation
        assert cast['id'] > 0, "Cast id must be positive"
        assert len(cast['name']) > 0, "Cast name cannot be empty"
        # Note: character CAN be empty string for extras
    
    def test_cast_member_profile_path_format(self, mock_cast_member_complete):
        """Validate profile_path URL format when present."""
        cast = mock_cast_member_complete
        
        if cast['profile_path'] is not None:
            assert isinstance(cast['profile_path'], str), "profile_path must be string when present"
            assert cast['profile_path'].startswith('https://image.tmdb.org/t/p/original'), \
                "profile_path must be TMDB image URL"


@pytest.mark.unit
class TestGenreTypeValidation:
    """Type validation for genre objects."""
    
    def test_genre_required_fields(self, mock_genre_drama):
        """Validate all required fields in genre objects."""
        genre = mock_genre_drama
        
        # All genres must have these fields
        assert 'id' in genre, "Genre must have id"
        assert 'name' in genre, "Genre must have name"
    
    def test_genre_field_types(self, mock_genre_drama):
        """Validate data types of all genre fields."""
        genre = mock_genre_drama
        
        # Type validation
        assert isinstance(genre['id'], int), "Genre id must be int"
        assert isinstance(genre['name'], str), "Genre name must be str"
        
        # Value validation
        assert genre['id'] > 0, "Genre id must be positive"
        assert len(genre['name']) > 0, "Genre name cannot be empty"
    
    def test_genre_standard_ids(self, mock_genre_drama, mock_genre_action):
        """Validate genre IDs match TMDB standards."""
        # Standard TMDB genre IDs
        VALID_GENRE_IDS = {
            12, 14, 16, 18, 27, 28, 35, 36, 37, 53, 80, 99, 878, 9648, 10402,
            10749, 10751, 10752, 10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768
        }
        
        drama = mock_genre_drama
        action = mock_genre_action
        
        assert drama['id'] in VALID_GENRE_IDS, f"Drama ID {drama['id']} should be valid TMDB genre"
        assert action['id'] in VALID_GENRE_IDS, f"Action ID {action['id']} should be valid TMDB genre"


@pytest.mark.unit
class TestSeasonTypeValidation:
    """Type validation for TV show season objects."""
    
    def test_season_required_fields(self):
        """Validate required fields in season objects."""
        # Based on actual API response
        season = {
            "air_date": "2014-04-15",
            "episode_count": 10,
            "id": 60040,
            "name": "Season 1",
            "overview": "Description",
            "poster_path": "/path.jpg",
            "season_number": 1,
            "vote_average": 8.5
        }
        
        assert 'season_number' in season, "Season must have season_number"
        assert 'episode_count' in season, "Season must have episode_count"
        assert 'id' in season, "Season must have id"
    
    def test_season_field_types(self):
        """Validate data types of season fields."""
        season = {
            "air_date": "2014-04-15",
            "episode_count": 10,
            "id": 60040,
            "name": "Season 1",
            "overview": "Description",
            "poster_path": "/path.jpg",
            "season_number": 1,
            "vote_average": 8.5
        }
        
        # Integer fields
        assert isinstance(season['id'], int), "Season id must be int"
        assert isinstance(season['season_number'], int), "season_number must be int"
        assert isinstance(season['episode_count'], int), "episode_count must be int"
        
        # String fields
        assert isinstance(season.get('name'), (str, type(None))), "name must be str or None"
        assert isinstance(season.get('overview'), (str, type(None))), "overview must be str or None"
        assert isinstance(season.get('air_date'), (str, type(None))), "air_date must be str or None"
        assert isinstance(season.get('poster_path'), (str, type(None))), "poster_path must be str or None"
        
        # Numeric fields
        assert isinstance(season.get('vote_average'), (float, int, type(None))), \
            "vote_average must be numeric or None"
        
        # Value validation
        assert season['season_number'] >= 0, "season_number can be 0 for specials"
        assert season['episode_count'] > 0, "episode_count must be positive"


@pytest.mark.integration
class TestMetadataStructureConsistency:
    """Validate consistency of metadata structures across media types."""
    
    def test_cast_structure_identical_across_types(
        self, mock_tmdb_movie_response, mock_tmdb_tv_response
    ):
        """Cast structure should be identical for movies and TV shows."""
        movie_cast = mock_tmdb_movie_response.get('cast', [])
        tv_cast = mock_tmdb_tv_response.get('cast', [])
        
        if len(movie_cast) > 0 and len(tv_cast) > 0:
            movie_keys = set(movie_cast[0].keys())
            tv_keys = set(tv_cast[0].keys())
            
            assert movie_keys == tv_keys, \
                f"Cast structure mismatch: Movie={movie_keys}, TV={tv_keys}"
    
    def test_genre_structure_identical_across_types(
        self, mock_tmdb_movie_response, mock_tmdb_tv_response
    ):
        """Genre structure should be identical for movies and TV shows."""
        movie_genres = mock_tmdb_movie_response.get('genres', [])
        tv_genres = mock_tmdb_tv_response.get('genres', [])
        
        if len(movie_genres) > 0 and len(tv_genres) > 0:
            movie_keys = set(movie_genres[0].keys())
            tv_keys = set(tv_genres[0].keys())
            
            assert movie_keys == tv_keys, \
                f"Genre structure mismatch: Movie={movie_keys}, TV={tv_keys}"
