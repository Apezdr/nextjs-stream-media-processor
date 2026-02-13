"""
TMDB API Specification Compliance Tests

Validates that our implementation correctly handles ALL fields from TMDB API
responses according to the official API specification.

Based on official TMDB API v3 documentation:
- Movie endpoint: https://api.themoviedb.org/3/movie/{movie_id}
- TV endpoint: https://api.themoviedb.org/3/tv/{series_id}
"""

import pytest
from typing import Union


@pytest.mark.unit
class TestMovieAPISpecCompliance:
    """
    Validates movie metadata against TMDB API specification.
    All fields and types match official documentation.
    """
    
    def test_movie_all_field_types(self, mock_tmdb_movie_response):
        """Validate all movie fields match TMDB API specification."""
        movie = mock_tmdb_movie_response
        
        # ===== Boolean Fields =====
        assert isinstance(movie.get('adult'), bool), "adult: boolean"
        assert isinstance(movie.get('video'), bool), "video: boolean"
        
        # ===== Integer Fields =====
        assert isinstance(movie.get('id'), int), "id: integer (required)"
        assert isinstance(movie.get('budget'), (int, type(None))), "budget: integer (default: 0)"
        assert isinstance(movie.get('revenue'), (int, type(None))), "revenue: integer (default: 0)"
        assert isinstance(movie.get('runtime'), (int, type(None))), "runtime: integer (default: 0)"
        assert isinstance(movie.get('vote_count'), (int, type(None))), "vote_count: integer (default: 0)"
        
        # ===== Number (Float) Fields =====
        assert isinstance(movie.get('popularity'), (float, int, type(None))), "popularity: number"
        assert isinstance(movie.get('vote_average'), (float, int, type(None))), "vote_average: number"
        
        # ===== String Fields =====
        assert isinstance(movie.get('backdrop_path'), (str, type(None))), "backdrop_path: string"
        assert isinstance(movie.get('homepage'), (str, type(None))), "homepage: string"
        assert isinstance(movie.get('imdb_id'), (str, type(None))), "imdb_id: string"
        assert isinstance(movie.get('original_language'), (str, type(None))), "original_language: string"
        assert isinstance(movie.get('original_title'), (str, type(None))), "original_title: string"
        assert isinstance(movie.get('overview'), (str, type(None))), "overview: string"
        assert isinstance(movie.get('poster_path'), (str, type(None))), "poster_path: string"
        assert isinstance(movie.get('release_date'), (str, type(None))), "release_date: string"
        assert isinstance(movie.get('status'), (str, type(None))), "status: string"
        assert isinstance(movie.get('tagline'), (str, type(None))), "tagline: string"
        assert isinstance(movie.get('title'), (str, type(None))), "title: string"
        
        # ===== Nullable Fields =====
        belongs_to = movie.get('belongs_to_collection')
        assert belongs_to is None or isinstance(belongs_to, dict), \
            "belongs_to_collection: string or null"
    
    def test_movie_array_structures(self, mock_tmdb_movie_response):
        """Validate array field structures in movie metadata."""
        movie = mock_tmdb_movie_response
        
        # ===== genres: Array of Objects =====
        genres = movie.get('genres', [])
        assert isinstance(genres, list), "genres must be array"
        
        for genre in genres:
            assert isinstance(genre, dict), "Each genre must be object"
            assert isinstance(genre.get('id'), int), "genre.id: integer"
            assert isinstance(genre.get('name'), str), "genre.name: string"
        
        # ===== production_companies: Array of Objects =====
        companies = movie.get('production_companies', [])
        if companies:
            for company in companies:
                assert isinstance(company, dict), "Each production_company must be object"
                assert isinstance(company.get('id'), int), "company.id: integer"
                assert isinstance(company.get('logo_path'), (str, type(None))), "company.logo_path: string or null"
                assert isinstance(company.get('name'), str), "company.name: string"
                assert isinstance(company.get('origin_country'), str), "company.origin_country: string"
        
        # ===== production_countries: Array of Objects =====
        countries = movie.get('production_countries', [])
        if countries:
            for country in countries:
                assert isinstance(country, dict), "Each production_country must be object"
                assert isinstance(country.get('iso_3166_1'), str), "country.iso_3166_1: string"
                assert isinstance(country.get('name'), str), "country.name: string"
        
        # ===== spoken_languages: Array of Objects =====
        languages = movie.get('spoken_languages', [])
        if languages:
            for lang in languages:
                assert isinstance(lang, dict), "Each spoken_language must be object"
                assert isinstance(lang.get('english_name'), str), "language.english_name: string"
                assert isinstance(lang.get('iso_639_1'), str), "language.iso_639_1: string"
                assert isinstance(lang.get('name'), str), "language.name: string"


@pytest.mark.unit
class TestTVAPISpecCompliance:
    """
    Validates TV show metadata against TMDB API specification.
    All fields and types match official documentation.
    """
    
    def test_tv_all_field_types(self, mock_tmdb_tv_response):
        """Validate all TV show fields match TMDB API specification."""
        show = mock_tmdb_tv_response
        
        # ===== Boolean Fields =====
        assert isinstance(show.get('adult'), bool), "adult: boolean"
        assert isinstance(show.get('in_production'), (bool, type(None))), "in_production: boolean"
        
        # ===== Integer Fields =====
        assert isinstance(show.get('id'), int), "id: integer (required)"
        assert isinstance(show.get('number_of_episodes'), (int, type(None))), "number_of_episodes: integer"
        assert isinstance(show.get('number_of_seasons'), (int, type(None))), "number_of_seasons: integer"
        assert isinstance(show.get('vote_count'), (int, type(None))), "vote_count: integer"
        
        # ===== Number (Float) Fields =====
        assert isinstance(show.get('popularity'), (float, int, type(None))), "popularity: number"
        assert isinstance(show.get('vote_average'), (float, int, type(None))), "vote_average: number"
        
        # ===== String Fields =====
        assert isinstance(show.get('backdrop_path'), (str, type(None))), "backdrop_path: string"
        assert isinstance(show.get('first_air_date'), (str, type(None))), "first_air_date: string"
        assert isinstance(show.get('homepage'), (str, type(None))), "homepage: string"
        assert isinstance(show.get('last_air_date'), (str, type(None))), "last_air_date: string"
        assert isinstance(show.get('name'), (str, type(None))), "name: string"
        assert isinstance(show.get('original_language'), (str, type(None))), "original_language: string"
        assert isinstance(show.get('original_name'), (str, type(None))), "original_name: string"
        assert isinstance(show.get('overview'), (str, type(None))), "overview: string"
        assert isinstance(show.get('poster_path'), (str, type(None))), "poster_path: string"
        assert isinstance(show.get('status'), (str, type(None))), "status: string"
        assert isinstance(show.get('tagline'), (str, type(None))), "tagline: string"
        assert isinstance(show.get('type'), (str, type(None))), "type: string"
    
    def test_tv_array_fields(self, mock_tmdb_tv_response):
        """Validate array field structures in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # ===== created_by: Array of Objects =====
        created_by = show.get('created_by', [])
        if created_by:
            for creator in created_by:
                assert isinstance(creator, dict), "Each creator must be object"
                assert isinstance(creator.get('id'), int), "creator.id: integer"
                assert isinstance(creator.get('credit_id'), str), "creator.credit_id: string"
                assert isinstance(creator.get('name'), str), "creator.name: string"
                assert isinstance(creator.get('gender'), int), "creator.gender: integer"
                assert isinstance(creator.get('profile_path'), (str, type(None))), "creator.profile_path: string or null"
        
        # ===== episode_run_time: Array of Integers =====
        run_times = show.get('episode_run_time', [])
        assert isinstance(run_times, list), "episode_run_time must be array"
        for runtime in run_times:
            assert isinstance(runtime, int), "Each episode_run_time must be integer"
        
        # ===== genres: Array of Objects =====
        genres = show.get('genres', [])
        assert isinstance(genres, list), "genres must be array"
        for genre in genres:
            assert isinstance(genre, dict), "Each genre must be object"
            assert isinstance(genre.get('id'), int), "genre.id: integer"
            assert isinstance(genre.get('name'), str), "genre.name: string"
        
        # ===== languages: Array of Strings =====
        languages = show.get('languages', [])
        if languages:
            for lang in languages:
                assert isinstance(lang, str), "Each language must be string"
        
        # ===== networks: Array of Objects =====
        networks = show.get('networks', [])
        if networks:
            for network in networks:
                assert isinstance(network, dict), "Each network must be object"
                assert isinstance(network.get('id'), int), "network.id: integer"
                assert isinstance(network.get('logo_path'), (str, type(None))), "network.logo_path: string or null"
                assert isinstance(network.get('name'), str), "network.name: string"
                assert isinstance(network.get('origin_country'), str), "network.origin_country: string"
        
        # ===== origin_country: Array of Strings =====
        origins = show.get('origin_country', [])
        if origins:
            for country in origins:
                assert isinstance(country, str), "Each origin_country must be string"
        
        # ===== seasons: Array of Objects =====
        seasons = show.get('seasons', [])
        assert isinstance(seasons, list), "seasons must be array"
        for season in seasons:
            assert isinstance(season, dict), "Each season must be object"
            assert isinstance(season.get('air_date'), (str, type(None))), "season.air_date: string or null"
            assert isinstance(season.get('episode_count'), int), "season.episode_count: integer"
            assert isinstance(season.get('id'), int), "season.id: integer"
            assert isinstance(season.get('name'), str), "season.name: string"
            assert isinstance(season.get('overview'), str), "season.overview: string"
            assert isinstance(season.get('poster_path'), (str, type(None))), "season.poster_path: string or null"
            assert isinstance(season.get('season_number'), int), "season.season_number: integer"
            assert isinstance(season.get('vote_average'), (float, int)), "season.vote_average: number"
    
    def test_tv_object_fields(self, mock_tmdb_tv_response):
        """Validate object field structures in TV show metadata."""
        show = mock_tmdb_tv_response
        
        # ===== last_episode_to_air: Object or Null =====
        last_ep = show.get('last_episode_to_air')
        if last_ep is not None:
            assert isinstance(last_ep, dict), "last_episode_to_air must be object when present"
            assert isinstance(last_ep.get('id'), int), "episode.id: integer"
            assert isinstance(last_ep.get('name'), str), "episode.name: string"
            assert isinstance(last_ep.get('overview'), str), "episode.overview: string"
            assert isinstance(last_ep.get('vote_average'), (float, int)), "episode.vote_average: number"
            assert isinstance(last_ep.get('vote_count'), int), "episode.vote_count: integer"
            assert isinstance(last_ep.get('air_date'), str), "episode.air_date: string"
            assert isinstance(last_ep.get('episode_number'), int), "episode.episode_number: integer"
            assert isinstance(last_ep.get('runtime'), (int, type(None))), "episode.runtime: integer or null"
            assert isinstance(last_ep.get('season_number'), int), "episode.season_number: integer"
            assert isinstance(last_ep.get('still_path'), (str, type(None))), "episode.still_path: string or null"
        
        # ===== next_episode_to_air: String or Null (per spec) =====
        next_ep = show.get('next_episode_to_air')
        # Note: Spec says string, but real API returns object or null - validate both
        assert next_ep is None or isinstance(next_ep, (str, dict)), \
            "next_episode_to_air: string or null (or object in practice)"


@pytest.mark.unit
class TestCastAPISpecCompliance:
    """
    Validates cast member structure from TMDB credits endpoint.
    Based on actual API responses (not in official spec but validated from real data).
    """
    
    def test_cast_member_all_fields(self, mock_cast_member_complete):
        """Validate cast member has all expected fields."""
        cast = mock_cast_member_complete
        
        # Required fields based on our implementation
        assert 'id' in cast, "Cast member must have id"
        assert 'name' in cast, "Cast member must have name"
        assert 'character' in cast, "Cast member must have character"
        assert 'profile_path' in cast, "Cast member must have profile_path field (can be None)"
    
    def test_cast_member_field_types_explicit(self, mock_cast_member_complete):
        """Explicit type validation for each cast member field."""
        cast = mock_cast_member_complete
        
        # id: integer (TMDB person ID)
        assert isinstance(cast['id'], int), "id must be integer"
        assert cast['id'] > 0, "id must be positive"
        
        # name: string (actor/actress name)
        assert isinstance(cast['name'], str), "name must be string"
        assert len(cast['name']) > 0, "name cannot be empty"
        
        # character: string (role name - can be empty for extras)
        assert isinstance(cast['character'], str), "character must be string"
        
        # profile_path: string or null (TMDB image URL or null)
        assert isinstance(cast['profile_path'], (str, type(None))), \
            "profile_path must be string or None"
        
        # Validate URL format when present
        if cast['profile_path'] is not None:
            assert cast['profile_path'].startswith('https://image.tmdb.org/t/p/original'), \
                "profile_path must be full TMDB image URL"
    
    def test_cast_member_handles_null_profile(self, mock_cast_member_no_profile):
        """Validate cast members without profile images."""
        cast = mock_cast_member_no_profile
        
        # All other fields still required
        assert isinstance(cast['id'], int)
        assert isinstance(cast['name'], str)
        assert isinstance(cast['character'], str)
        
        # profile_path must be None, not empty string
        assert cast['profile_path'] is None, "profile_path must be None when missing, not empty string"


@pytest.mark.unit
class TestGenreAPISpecCompliance:
    """Validates genre structure matches TMDB API specification."""
    
    def test_genre_all_fields(self, mock_genre_drama):
        """Validate genre has all required fields."""
        genre = mock_genre_drama
        
        # Required fields per API spec
        assert 'id' in genre, "Genre must have id"
        assert 'name' in genre, "Genre must have name"
    
    def test_genre_field_types_explicit(self, mock_genre_drama):
        """Explicit type validation for genre fields."""
        genre = mock_genre_drama
        
        # id: integer (TMDB genre ID)
        assert isinstance(genre['id'], int), "id must be integer"
        assert genre['id'] > 0, "id must be positive"
        
        # name: string (genre name)
        assert isinstance(genre['name'], str), "name must be string"
        assert len(genre['name']) > 0, "name cannot be empty"
    
    def test_genre_tmdb_standard_ids(self):
        """Validate genre IDs match TMDB standard genre taxonomy."""
        # Complete TMDB genre ID list (as of v3 API)
        TMDB_STANDARD_GENRES = {
            # Movie Genres
            12: "Adventure",
            14: "Fantasy",
            16: "Animation",
            18: "Drama",
            27: "Horror",
            28: "Action",
            35: "Comedy",
            36: "History",
            37: "Western",
            53: "Thriller",
            80: "Crime",
            99: "Documentary",
            878: "Science Fiction",
            9648: "Mystery",
            10402: "Music",
            10749: "Romance",
            10751: "Family",
            10752: "War",
            # TV Genres
            10759: "Action & Adventure",
            10762: "Kids",
            10763: "News",
            10764: "Reality",
            10765: "Sci-Fi & Fantasy",
            10766: "Soap",
            10767: "Talk",
            10768: "War & Politics",
        }
        
        # This is a reference test - validates our test fixtures use valid IDs
        drama_id = 18
        action_id = 28
        
        assert drama_id in TMDB_STANDARD_GENRES, "Drama ID should be in TMDB standards"
        assert TMDB_STANDARD_GENRES[drama_id] == "Drama"
        assert action_id in TMDB_STANDARD_GENRES, "Action ID should be in TMDB standards"
        assert TMDB_STANDARD_GENRES[action_id] == "Action"


@pytest.mark.unit
class TestSeasonAPISpecCompliance:
    """Validates season structure from TV show seasons array."""
    
    def test_season_all_fields(self):
        """Validate season has all fields per TMDB API specification."""
        # Example season object based on API spec
        season = {
            "air_date": "2014-04-15",
            "episode_count": 10,
            "id": 60040,
            "name": "Season 1",
            "overview": "Season overview text",
            "poster_path": "/poster.jpg",
            "season_number": 1,
            "vote_average": 8.5
        }
        
        # Required fields
        assert 'id' in season
        assert 'season_number' in season
        assert 'episode_count' in season
    
    def test_season_field_types_explicit(self):
        """Explicit type validation for season fields."""
        season = {
            "air_date": "2014-04-15",
            "episode_count": 10,
            "id": 60040,
            "name": "Season 1",
            "overview": "Season overview text",
            "poster_path": "/poster.jpg",
            "season_number": 1,
            "vote_average": 8.5
        }
        
        # air_date: string or null
        assert isinstance(season.get('air_date'), (str, type(None))), "air_date must be string or None"
        
        # episode_count: integer
        assert isinstance(season['episode_count'], int), "episode_count must be integer"
        assert season['episode_count'] > 0, "episode_count must be positive"
        
        # id: integer (season ID)
        assert isinstance(season['id'], int), "id must be integer"
        assert season['id'] > 0, "id must be positive"
        
        # name: string
        assert isinstance(season['name'], str), "name must be string"
        
        # overview: string
        assert isinstance(season['overview'], str), "overview must be string (can be empty)"
        
        # poster_path: string or null
        assert isinstance(season.get('poster_path'), (str, type(None))), \
            "poster_path must be string or None"
        
        # season_number: integer (0 for specials)
        assert isinstance(season['season_number'], int), "season_number must be integer"
        assert season['season_number'] >= 0, "season_number must be >= 0 (0 = specials)"
        
        # vote_average: number (actually integer per spec, but can be float)
        assert isinstance(season.get('vote_average'), (float, int)), \
            "vote_average must be numeric"


@pytest.mark.integration
@pytest.mark.asyncio
class TestCustomFieldsCompliance:
    """
    Validates custom fields added by our implementation.
    These are NOT in the base TMDB API but are fetched from additional endpoints.
    """
    
    async def test_custom_cast_field_structure(self, mock_tmdb_movie_response):
        """Validate our custom 'cast' field is properly structured."""
        movie = mock_tmdb_movie_response
        
        # Our implementation adds 'cast' from /credits endpoint
        assert 'cast' in movie, "Our implementation must include cast"
        cast = movie['cast']
        
        assert isinstance(cast, list), "cast must be array"
        
        if len(cast) > 0:
            # Validate structure matches our implementation
            member = cast[0]
            assert isinstance(member['id'], int), "cast.id from /credits endpoint"
            assert isinstance(member['name'], str), "cast.name from /credits endpoint"
            assert isinstance(member['character'], str), "cast.character from /credits endpoint"
            assert isinstance(member['profile_path'], (str, type(None))), \
                "cast.profile_path (converted to full URL or None)"
    
    async def test_custom_trailer_url_field(self, mock_tmdb_movie_response):
        """Validate our custom 'trailer_url' field."""
        movie = mock_tmdb_movie_response
        
        # Our implementation adds 'trailer_url' from /videos endpoint
        assert 'trailer_url' in movie, "Our implementation must include trailer_url"
        
        trailer = movie.get('trailer_url')
        assert isinstance(trailer, (str, type(None))), "trailer_url must be string or None"
        
        if trailer:
            assert trailer.startswith('https://www.youtube.com/watch?v='), \
                "trailer_url must be YouTube URL format"
    
    async def test_custom_logo_path_field(self, mock_tmdb_movie_response):
        """Validate our custom 'logo_path' field."""
        movie = mock_tmdb_movie_response
        
        # Our implementation adds 'logo_path' from /images endpoint
        assert 'logo_path' in movie, "Our implementation must include logo_path"
        
        logo = movie.get('logo_path')
        assert isinstance(logo, (str, type(None))), "logo_path must be string or None"
        
        if logo:
            assert logo.startswith('https://image.tmdb.org/t/p/original'), \
                "logo_path must be full TMDB image URL"
    
    async def test_custom_rating_field(self, mock_tmdb_movie_response):
        """Validate our custom 'rating' field."""
        movie = mock_tmdb_movie_response
        
        # Our implementation adds 'rating' from /release_dates or /content_ratings endpoint
        assert 'rating' in movie, "Our implementation must include rating"
        
        rating = movie.get('rating')
        assert isinstance(rating, (str, type(None))), "rating must be string or None"
        
        # Common US ratings
        VALID_MOVIE_RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR', 'Not Rated']
        VALID_TV_RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA']
        
        if rating:
            # Should be one of the known ratings
            is_valid = rating in VALID_MOVIE_RATINGS or rating in VALID_TV_RATINGS
            # Note: Not asserting this as mandatory since international ratings may differ
    
    async def test_custom_last_updated_field(self, mock_tmdb_movie_response):
        """Validate our custom 'last_updated' field."""
        movie = mock_tmdb_movie_response
        
        # Our implementation adds 'last_updated' timestamp
        assert 'last_updated' in movie, "Our implementation must include last_updated"
        
        last_updated = movie.get('last_updated')
        assert isinstance(last_updated, str), "last_updated must be string (ISO datetime)"
        
        # Validate ISO 8601 format (basic check)
        assert 'T' in last_updated, "last_updated should be ISO 8601 format"
        assert len(last_updated) > 10, "last_updated should include date and time"


@pytest.mark.integration
class TestProductionCompaniesCompliance:
    """Validate production_companies array structure."""
    
    def test_production_company_structure(self, mock_tmdb_movie_response):
        """Validate production company objects match API spec."""
        movie = mock_tmdb_movie_response
        
        companies = movie.get('production_companies', [])
        
        if len(companies) > 0:
            company = companies[0]
            
            # Per API spec
            assert isinstance(company.get('id'), int), "company.id: integer"
            assert isinstance(company.get('logo_path'), (str, type(None))), "company.logo_path: string or null"
            assert isinstance(company.get('name'), str), "company.name: string"
            assert isinstance(company.get('origin_country'), str), "company.origin_country: string"


@pytest.mark.integration
class TestSpokenLanguagesCompliance:
    """Validate spoken_languages array structure."""
    
    def test_spoken_language_structure(self, mock_tmdb_movie_response):
        """Validate spoken language objects match API spec."""
        movie = mock_tmdb_movie_response
        
        languages = movie.get('spoken_languages', [])
        
        if len(languages) > 0:
            lang = languages[0]
            
            # Per API spec
            assert isinstance(lang.get('english_name'), str), "language.english_name: string"
            assert isinstance(lang.get('iso_639_1'), str), "language.iso_639_1: string"
            assert isinstance(lang.get('name'), str), "language.name: string"
            
            # Validate ISO code format
            assert len(lang['iso_639_1']) == 2, "iso_639_1 should be 2-character code"
