"""
TMDB API Response Inspector

Fetches real TMDB data and inspects all fields and types to ensure
comprehensive test coverage.

Usage:
    python inspect_tmdb_response.py
"""

import asyncio
import aiohttp
import json
import os
from pprint import pprint
from typing import Any, Dict, Optional

# Ensure API key is set
TMDB_API_KEY = os.getenv('TMDB_API_KEY')
if not TMDB_API_KEY:
    raise ValueError("TMDB_API_KEY environment variable must be set")

async def fetch_and_inspect():
    """Fetch and inspect actual TMDB responses."""
    
    print("="*80)
    print("TMDB API RESPONSE INSPECTOR")
    print("="*80)
    
    async with aiohttp.ClientSession() as session:
        # Import after session is created
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).parent.parent))
        
        from utils.tmdb_utils import fetch_tmdb_media_details
        
        print("\n" + "="*80)
        print("MOVIE: Bugonia (TMDB ID: 701387)")
        print("="*80)
        
        movie_data = await fetch_tmdb_media_details(
            session, "Bugonia", tmdb_id=701387, media_type='movie'
        )
        
        if movie_data:
            print("\n### MOVIE FIELDS AND TYPES ###\n")
            inspect_fields(movie_data, "Movie Root")
            
            # Deep inspect cast
            if 'cast' in movie_data and movie_data['cast']:
                print("\n### CAST MEMBER STRUCTURE ###\n")
                inspect_fields(movie_data['cast'][0], "Cast Member [0]")
            
            # Deep inspect genres
            if 'genres' in movie_data and movie_data['genres']:
                print("\n### GENRE STRUCTURE ###\n")
                inspect_fields(movie_data['genres'][0], "Genre [0]")
            
            # Save full response
            with open('movie_701387_response.json', 'w') as f:
                json.dump(movie_data, f, indent=2, default=str)
            print(f"\n✓ Full movie response saved to: movie_701387_response.json")
        
        print("\n" + "="*80)
        print("TV SHOW: Fargo (TMDB ID: 60622)")
        print("="*80)
        
        show_data = await fetch_tmdb_media_details(
            session, "Fargo", tmdb_id=60622, media_type='tv'
        )
        
        if show_data:
            print("\n### TV SHOW FIELDS AND TYPES ###\n")
            inspect_fields(show_data, "TV Show Root")
            
            # Deep inspect cast
            if 'cast' in show_data and show_data['cast']:
                print("\n### CAST MEMBER STRUCTURE (TV) ###\n")
                inspect_fields(show_data['cast'][0], "Cast Member [0]")
            
            # Deep inspect genres
            if 'genres' in show_data and show_data['genres']:
                print("\n### GENRE STRUCTURE (TV) ###\n")
                inspect_fields(show_data['genres'][0], "Genre [0]")
            
            # Deep inspect seasons
            if 'seasons' in show_data and show_data['seasons']:
                print("\n### SEASON STRUCTURE ###\n")
                inspect_fields(show_data['seasons'][0], "Season [0]")
                if len(show_data['seasons']) > 1:
                    inspect_fields(show_data['seasons'][1], "Season [1]")
            
            # Save full response
            with open('tv_60622_response.json', 'w') as f:
                json.dump(show_data, f, indent=2, default=str)
            print(f"\n✓ Full TV response saved to: tv_60622_response.json")
        
        # Generate comprehensive test template if data was fetched
        if movie_data or show_data:
            generate_type_tests(movie_data, show_data)


def inspect_fields(data: Optional[Dict[str, Any]], label: str = "Object"):
    """Recursively inspect all fields and their types."""
    if not isinstance(data, dict):
        print(f"{label}: {type(data).__name__} = {data}")
        return
    
    print(f"\n{label}:")
    print("-" * 60)
    
    for key, value in sorted(data.items()):
        type_name = type(value).__name__
        
        if value is None:
            print(f"  {key:30} : None")
        elif isinstance(value, bool):
            print(f"  {key:30} : bool = {value}")
        elif isinstance(value, int):
            print(f"  {key:30} : int = {value}")
        elif isinstance(value, float):
            print(f"  {key:30} : float = {value}")
        elif isinstance(value, str):
            preview = value[:50] + "..." if len(value) > 50 else value
            print(f"  {key:30} : str = \"{preview}\"")
        elif isinstance(value, list):
            if len(value) > 0:
                first_type = type(value[0]).__name__
                print(f"  {key:30} : list[{first_type}] (len={len(value)})")
            else:
                print(f"  {key:30} : list[] (empty)")
        elif isinstance(value, dict):
            print(f"  {key:30} : dict (keys={len(value)})")
        else:
            print(f"  {key:30} : {type_name}")


def generate_type_tests(movie_data: Optional[Dict[str, Any]], show_data: Optional[Dict[str, Any]]):
    """Generate comprehensive type validation test code."""
    
    if not movie_data and not show_data:
        print("\n⚠ No data fetched, skipping test generation")
        return
    
    test_code = '''
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
'''
    
    if movie_data:
        test_code += "\n        # Fields found in actual response:\n"
        for key, value in sorted(movie_data.items()):
            if isinstance(value, bool):
                test_code += f"        assert isinstance(movie.get('{key}'), (bool, type(None))), \"{key} should be bool or None\"\n"
            elif isinstance(value, int):
                test_code += f"        assert isinstance(movie.get('{key}'), (int, type(None))), \"{key} should be int or None\"\n"
            elif isinstance(value, float):
                test_code += f"        assert isinstance(movie.get('{key}'), (float, int, type(None))), \"{key} should be numeric or None\"\n"
            elif isinstance(value, str):
                test_code += f"        assert isinstance(movie.get('{key}'), (str, type(None))), \"{key} should be str or None\"\n"
            elif isinstance(value, list):
                test_code += f"        assert isinstance(movie.get('{key}'), (list, type(None))), \"{key} should be list or None\"\n"
            elif isinstance(value, dict):
                test_code += f"        assert isinstance(movie.get('{key}'), (dict, type(None))), \"{key} should be dict or None\"\n"
    
    with open('generated_type_tests.py', 'w') as f:
        f.write(test_code)
    
    print("\n" + "="*80)
    print("✓ Generated type validation tests: generated_type_tests.py")
    print("="*80)


if __name__ == '__main__':
    asyncio.run(fetch_and_inspect())
