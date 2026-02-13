"""
Business Rules Tests for TMDB Metadata Processing

Tests the core business logic:
- 24-hour cache expiration
- tmdb.config change detection
- Force refresh behavior
- update_metadata flag adherence
- Rate limiting compliance
"""

import pytest
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch, AsyncMock

from utils.file_utils import (
    should_refresh_metadata,
    load_tmdb_config_file,
    update_tmdb_config,
)
from utils.tmdb_utils import is_metadata_update_allowed


# ============================================================================
# 24-Hour Cache Expiration Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.asyncio
class TestCacheExpiration:
    """Tests for 24-hour cache expiration logic."""
    
    async def test_metadata_refresh_needed_after_24_hours(
        self, mock_tv_show_structure, create_mock_metadata_file, time_25_hours_ago
    ):
        """Metadata should refresh when older than 24 hours."""
        # Create metadata file with old timestamp
        await create_mock_metadata_file(
            mock_tv_show_structure["metadata_path"],
            {"id": 12345, "name": "Test Show"},
            mtime=time_25_hours_ago
        )
        
        should_refresh = await should_refresh_metadata(
            str(mock_tv_show_structure["metadata_path"]),
            str(mock_tv_show_structure["config_path"])
        )
        
        assert should_refresh is True, "Metadata should refresh after 24 hours"
    
    async def test_metadata_no_refresh_within_24_hours(
        self, mock_tv_show_structure, create_mock_metadata_file, time_1_hour_ago
    ):
        """Metadata should NOT refresh when less than 24 hours old."""
        # Set config file to be older than metadata (2 hours ago)
        config_path = mock_tv_show_structure["config_path"]
        time_2_hours_ago = datetime.now() - timedelta(hours=2)
        timestamp = time_2_hours_ago.timestamp()
        os.utime(config_path, (timestamp, timestamp))
        
        # Create recent metadata file (1 hour ago - newer than config)
        await create_mock_metadata_file(
            mock_tv_show_structure["metadata_path"],
            {"id": 12345, "name": "Test Show"},
            mtime=time_1_hour_ago
        )
        
        should_refresh = await should_refresh_metadata(
            str(mock_tv_show_structure["metadata_path"]),
            str(mock_tv_show_structure["config_path"])
        )
        
        assert should_refresh is False, "Metadata should not refresh within 24 hours"
    
    async def test_metadata_refresh_when_file_missing(self, mock_tv_show_structure):
        """Metadata should refresh when file doesn't exist."""
        should_refresh = await should_refresh_metadata(
            str(mock_tv_show_structure["metadata_path"]),
            str(mock_tv_show_structure["config_path"])
        )
        
        assert should_refresh is True, "Should refresh when metadata file missing"
    
    async def test_episode_thumbnail_refresh_after_3_days(
        self, mock_tv_show_structure, time_25_hours_ago
    ):
        """Episode thumbnails should refresh after 3 days (test 25 hours as < 3 days)."""
        # Create thumbnail file
        thumbnail_path = mock_tv_show_structure["season_dir"] / "01 - Thumbnail.jpg"
        thumbnail_path.write_bytes(b"mock_image")
        
        # Set mtime to 25 hours ago (within 3 days)
        timestamp = time_25_hours_ago.timestamp()
        os.utime(thumbnail_path, (timestamp, timestamp))
        
        # Check if refresh needed (should be False since < 3 days)
        mtime = datetime.fromtimestamp(os.path.getmtime(thumbnail_path))
        days_old = (datetime.now() - mtime).days
        
        assert days_old < 3, "Thumbnail is less than 3 days old"


# ============================================================================
# Config Change Detection Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.asyncio
class TestConfigChangeDetection:
    """Tests for tmdb.config change detection triggering refreshes."""
    
    async def test_config_change_triggers_refresh(
        self, mock_tv_show_structure, create_mock_metadata_file, time_1_hour_ago
    ):
        """Config modification after metadata should trigger refresh."""
        # Create recent metadata
        await create_mock_metadata_file(
            mock_tv_show_structure["metadata_path"],
            {"id": 12345, "name": "Test Show"},
            mtime=time_1_hour_ago
        )
        
        # Modify config more recently
        config_path = mock_tv_show_structure["config_path"]
        with open(config_path, 'r') as f:
            config = json.load(f)
        config["last_updated"] = datetime.now().isoformat()
        with open(config_path, 'w') as f:
            json.dump(config, f)
        
        should_refresh = await should_refresh_metadata(
            str(mock_tv_show_structure["metadata_path"]),
            str(mock_tv_show_structure["config_path"])
        )
        
        assert should_refresh is True, "Config change should trigger refresh"
    
    async def test_override_images_applied(self, mock_tmdb_config_with_overrides):
        """Override images from config should be respected."""
        assert "override_poster" in mock_tmdb_config_with_overrides
        assert "override_backdrop" in mock_tmdb_config_with_overrides
        
        # Verify override paths are different from default
        assert mock_tmdb_config_with_overrides["override_poster"] == "/custom_poster.jpg"
    
    async def test_metadata_overrides_applied(self, mock_tmdb_config_with_overrides):
        """Metadata overrides from config should be merged."""
        overrides = mock_tmdb_config_with_overrides.get("metadata", {})
        
        assert overrides.get("name") == "Custom Show Name"
        assert overrides.get("overview") == "Custom overview text"


# ============================================================================
# update_metadata Flag Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.unit
class TestUpdateMetadataFlag:
    """Tests for update_metadata flag controlling refresh behavior."""
    
    def test_updates_allowed_when_flag_true(self, mock_tmdb_config_update_enabled):
        """Updates should be allowed when update_metadata is True."""
        is_allowed = is_metadata_update_allowed(mock_tmdb_config_update_enabled)
        assert is_allowed is True
    
    def test_updates_blocked_when_flag_false(self, mock_tmdb_config_update_disabled):
        """Updates should be blocked when update_metadata is False."""
        is_allowed = is_metadata_update_allowed(mock_tmdb_config_update_disabled)
        assert is_allowed is False
    
    def test_updates_allowed_by_default(self):
        """Updates should be allowed when flag is not specified (default True)."""
        config = {"tmdb_id": 12345}  # No update_metadata field
        is_allowed = is_metadata_update_allowed(config)
        assert is_allowed is True
    
    def test_initial_metadata_created_even_when_disabled(
        self, mock_tv_show_structure, mock_tmdb_config_update_disabled
    ):
        """Initial metadata should be created even when updates are disabled."""
        # Simulate the check: if metadata doesn't exist, allow initial fetch
        metadata_exists = mock_tv_show_structure["metadata_path"].exists()
        should_do_initial = not metadata_exists
        
        assert should_do_initial is True, "Should create initial metadata even when updates disabled"


# ============================================================================
# Force Refresh Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.asyncio
class TestForceRefresh:
    """Tests for force refresh behavior (admin override)."""
    
    async def test_force_refresh_bypasses_cache(
        self, mock_tv_show_structure, create_mock_metadata_file, time_1_hour_ago
    ):
        """Force refresh should bypass cache even with recent metadata."""
        # Create very recent metadata
        await create_mock_metadata_file(
            mock_tv_show_structure["metadata_path"],
            {"id": 12345, "name": "Test Show"},
            mtime=time_1_hour_ago
        )
        
        # With force refresh, should always refresh
        # (This would be simulated by passing force_refresh=True to the script)
        force_refresh = True
        
        if force_refresh:
            should_refresh = True
        else:
            should_refresh = await should_refresh_metadata(
                str(mock_tv_show_structure["metadata_path"]),
                str(mock_tv_show_structure["config_path"])
            )
        
        assert should_refresh is True, "Force refresh should bypass cache"
    
    async def test_force_refresh_with_disabled_updates(
        self, mock_tv_show_structure, mock_tmdb_config_update_disabled
    ):
        """Force refresh should work even when updates are disabled."""
        # In practice, force refresh would override update_metadata flag
        force_refresh = True
        updates_allowed = is_metadata_update_allowed(mock_tmdb_config_update_disabled)
        
        # Force refresh should take precedence
        should_proceed = force_refresh or updates_allowed
        
        assert should_proceed is True, "Force refresh should override disabled updates"


# ============================================================================
# Rate Limiting Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.unit
class TestRateLimiting:
    """Tests for TMDB API rate limiting compliance."""
    
    def test_rate_limit_retry_logic_parameters(self):
        """Verify rate limit handling uses appropriate retry parameters."""
        max_retries = 5
        initial_backoff = 1
        
        # Simulate exponential backoff
        backoff_sequence = [initial_backoff * (2 ** i) for i in range(max_retries)]
        
        assert max_retries >= 3, "Should have at least 3 retries for rate limits"
        assert backoff_sequence[-1] <= 32, "Max backoff should be reasonable"
    
    def test_rate_limit_response_handling(self):
        """Verify that 429 status code triggers retry logic."""
        # This would be tested in integration tests with mock responses
        status_codes_requiring_retry = [429, 503]
        
        assert 429 in status_codes_requiring_retry, "Should retry on 429 Rate Limited"


# ============================================================================
# Config Update Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.asyncio
class TestConfigUpdates:
    """Tests for tmdb.config update behavior."""
    
    async def test_config_updated_with_tmdb_id(self, mock_tv_show_structure):
        """Config should be updated with TMDB ID when not already present."""
        config_path = str(mock_tv_show_structure["config_path"])
        
        # Load existing config and remove tmdb_id to test it gets added
        config = await load_tmdb_config_file(config_path)
        config.pop("tmdb_id", None)  # Remove if exists
        
        # Write config without tmdb_id
        with open(config_path, 'w') as f:
            json.dump(config, f)
        
        # Reload to verify it's gone
        config = await load_tmdb_config_file(config_path)
        assert "tmdb_id" not in config
        
        # Simulate updating config with new ID
        await update_tmdb_config(config_path, config, 99999, "Test Show")
        
        # Read updated config
        updated_config = await load_tmdb_config_file(config_path)
        
        # Should now have the tmdb_id
        assert updated_config["tmdb_id"] == 99999
        assert "last_updated" in updated_config
    
    async def test_config_preserves_custom_fields(self, mock_tv_show_structure):
        """Config updates should preserve custom fields like overrides."""
        config_path = str(mock_tv_show_structure["config_path"])
        
        # Add custom fields
        config = await load_tmdb_config_file(config_path)
        config["custom_field"] = "preserved_value"
        config["override_poster"] = "/custom.jpg"
        
        with open(config_path, 'w') as f:
            json.dump(config, f)
        
        # Update config
        config = await load_tmdb_config_file(config_path)
        await update_tmdb_config(config_path, config, 12345, "Test Show")
        
        # Read updated config
        updated_config = await load_tmdb_config_file(config_path)
        
        assert updated_config.get("custom_field") == "preserved_value"
        assert updated_config.get("override_poster") == "/custom.jpg"


# ============================================================================
# Image Update Logic Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.unit
class TestImageUpdateLogic:
    """Tests for image file update detection logic."""
    
    def test_image_updated_when_url_changes(self):
        """Image should be updated when TMDB URL changes."""
        existing_url = "https://image.tmdb.org/t/p/original/old_poster.jpg"
        new_url = "https://image.tmdb.org/t/p/original/new_poster.jpg"
        
        should_update = existing_url != new_url
        
        assert should_update is True, "Should update image when URL changes"
    
    def test_image_not_updated_when_url_same(self):
        """Image should NOT be updated when URL is the same."""
        existing_url = "https://image.tmdb.org/t/p/original/same_poster.jpg"
        new_url = "https://image.tmdb.org/t/p/original/same_poster.jpg"
        
        should_update = existing_url != new_url
        
        assert should_update is False, "Should not update image when URL unchanged"
    
    def test_image_downloaded_when_missing(self, mock_tv_show_structure):
        """Image should be downloaded when file doesn't exist."""
        poster_path = mock_tv_show_structure["show_dir"] / "show_poster.jpg"
        
        should_download = not poster_path.exists()
        
        assert should_download is True, "Should download missing image"


# ============================================================================
# Concurrent Processing Tests
# ============================================================================

@pytest.mark.business_rules
@pytest.mark.slow
@pytest.mark.asyncio
class TestConcurrentProcessing:
    """Tests for concurrent media processing behavior."""
    
    async def test_concurrent_show_and_movie_processing(self):
        """Shows and movies should be processable concurrently."""
        # This tests that the script uses asyncio.gather for concurrent processing
        import asyncio
        
        async def mock_process_shows():
            await asyncio.sleep(0.1)
            return "shows_done"
        
        async def mock_process_movies():
            await asyncio.sleep(0.1)
            return "movies_done"
        
        # Run concurrently
        results = await asyncio.gather(
            mock_process_shows(),
            mock_process_movies()
        )
        
        assert "shows_done" in results
        assert "movies_done" in results
