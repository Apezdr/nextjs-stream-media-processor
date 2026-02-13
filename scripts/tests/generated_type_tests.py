
"""
Auto-generated Type Validation Tests
Generated from actual TMDB API responses
"""

import pytest
from typing import Union

@pytest.mark.unit
class TestMovieMetadataTypes:
    """Type validation for movie metadata fields."""
    
    def test_movie_root_level_types(self, mock_tmdb_movie_response):
        """Validate all root-level field types for movies."""
        movie = mock_tmdb_movie_response
        
        # Required integer fields
        assert isinstance(movie['id'], int), "id should be int"

        # Fields found in actual response:
        assert isinstance(movie.get('adult'), (bool, type(None))), "adult should be bool or None"
        assert isinstance(movie.get('backdrop_path'), (str, type(None))), "backdrop_path should be str or None"
        assert isinstance(movie.get('budget'), (int, type(None))), "budget should be int or None"
        assert isinstance(movie.get('cast'), (list, type(None))), "cast should be list or None"
        assert isinstance(movie.get('genres'), (list, type(None))), "genres should be list or None"
        assert isinstance(movie.get('homepage'), (str, type(None))), "homepage should be str or None"
        assert isinstance(movie.get('id'), (int, type(None))), "id should be int or None"
        assert isinstance(movie.get('imdb_id'), (str, type(None))), "imdb_id should be str or None"
        assert isinstance(movie.get('last_updated'), (str, type(None))), "last_updated should be str or None"
        assert isinstance(movie.get('logo_path'), (str, type(None))), "logo_path should be str or None"
        assert isinstance(movie.get('origin_country'), (list, type(None))), "origin_country should be list or None"
        assert isinstance(movie.get('original_language'), (str, type(None))), "original_language should be str or None"
        assert isinstance(movie.get('original_title'), (str, type(None))), "original_title should be str or None"
        assert isinstance(movie.get('overview'), (str, type(None))), "overview should be str or None"
        assert isinstance(movie.get('popularity'), (float, int, type(None))), "popularity should be numeric or None"
        assert isinstance(movie.get('poster_path'), (str, type(None))), "poster_path should be str or None"
        assert isinstance(movie.get('production_companies'), (list, type(None))), "production_companies should be list or None"
        assert isinstance(movie.get('production_countries'), (list, type(None))), "production_countries should be list or None"
        assert isinstance(movie.get('rating'), (str, type(None))), "rating should be str or None"
        assert isinstance(movie.get('release_date'), (str, type(None))), "release_date should be str or None"
        assert isinstance(movie.get('revenue'), (int, type(None))), "revenue should be int or None"
        assert isinstance(movie.get('runtime'), (int, type(None))), "runtime should be int or None"
        assert isinstance(movie.get('spoken_languages'), (list, type(None))), "spoken_languages should be list or None"
        assert isinstance(movie.get('status'), (str, type(None))), "status should be str or None"
        assert isinstance(movie.get('tagline'), (str, type(None))), "tagline should be str or None"
        assert isinstance(movie.get('title'), (str, type(None))), "title should be str or None"
        assert isinstance(movie.get('trailer_url'), (str, type(None))), "trailer_url should be str or None"
        assert isinstance(movie.get('video'), (bool, type(None))), "video should be bool or None"
        assert isinstance(movie.get('vote_average'), (float, int, type(None))), "vote_average should be numeric or None"
        assert isinstance(movie.get('vote_count'), (int, type(None))), "vote_count should be int or None"
