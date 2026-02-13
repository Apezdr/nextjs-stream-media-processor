# TMDB Metadata Processing - Test Suite

Comprehensive pytest test suite for the TMDB metadata processing Python scripts.

## 📋 Overview

This test suite validates all aspects of the TMDB metadata generation system:

- ✅ **Business Rules**: 24-hour cache expiration, config change detection, force refresh
- ✅ **File Generation**: Metadata JSON files, image downloads, blurhash generation
- ✅ **Performance**: Execution time tracking, benchmarking, regression detection
- ✅ **API Integration**: TMDB API mocking, rate limiting compliance

## 🚀 Quick Start

### Installation

Install pytest and required dependencies:

```bash
# Navigate to scripts directory
cd scripts

# Install test dependencies
pip install pytest pytest-asyncio pytest-cov pytest-timeout aiohttp python-dotenv

# Or use the requirements file
pip install -r test-requirements.txt
```

**Note:** Tests automatically use a mock TMDB_API_KEY, so you don't need to set real environment variables for testing.

### Run All Tests

```bash
# Run all tests
pytest

# Run with verbose output
pytest -v

# Run with coverage report
pytest --cov=utils --cov-report=html --cov-report=term-missing
```

## 📊 Test Organization

### Test Files

```
tests/
├── conftest.py                  # Shared fixtures and configuration
├── test_business_rules.py       # Business logic tests (24h cache, etc.)
├── test_file_generation.py      # File creation and validation tests
├── test_performance.py          # Performance and benchmarking tests
└── fixtures/                    # Test data and mock responses
```

### Test Markers

Tests are organized using pytest markers for selective execution:

```bash
# Run only business rules tests
pytest -m business_rules

# Run only file generation tests
pytest -m file_generation

# Run only performance tests
pytest -m performance

# Run only unit tests (fast)
pytest -m unit

# Skip slow tests
pytest -m "not slow"
```

## 🎯 Test Categories

### 1. Business Rules Tests

Tests core business logic and cache behavior:

```bash
# Run all business rules tests
pytest tests/test_business_rules.py -v

# Specific test classes
pytest tests/test_business_rules.py::TestCacheExpiration -v
pytest tests/test_business_rules.py::TestUpdateMetadataFlag -v
pytest tests/test_business_rules.py::TestForceRefresh -v
```

**Key Tests:**
- ✅ Metadata refreshes after 24 hours
- ✅ No refresh within 24 hours
- ✅ Config changes trigger refresh
- ✅ `update_metadata: false` blocks updates
- ✅ Force refresh bypasses cache
- ✅ Initial metadata created even when updates disabled

### 2. File Generation Tests

Tests file creation, structure, and validation:

```bash
# Run all file generation tests
pytest tests/test_file_generation.py -v

# Specific test classes
pytest tests/test_file_generation.py::TestMetadataGeneration -v
pytest tests/test_file_generation.py::TestImageDownloads -v
pytest tests/test_file_generation.py::TestBlurhashGeneration -v
```

**Key Tests:**
- ✅ `metadata.json` created with correct structure
- ✅ Required fields present (id, name, cast, trailer_url, etc.)
- ✅ Images downloaded (poster, backdrop, logo)
- ✅ Episode files follow naming conventions (`01_metadata.json`)
- ✅ Blurhash strings generated and validated
- ✅ Timestamps included (`last_updated`)

### 3. Performance Tests

Tests execution time and performance benchmarks:

```bash
# Run all performance tests
pytest tests/test_performance.py -v

# Run with timing summary
pytest tests/test_performance.py::TestPerformanceSummary -v

# Skip slow performance tests
pytest tests/test_performance.py -m "not slow"
```

**Key Tests:**
- ⏱️ Single show processing time < 5s
- ⏱️ Single movie processing time < 5s
- ⏱️ Concurrent processing faster than sequential
- ⏱️ API requests complete quickly
- ⏱️ Rate limit retry timing correct
- ⏱️ JSON I/O performance benchmarks

## 📈 Performance Benchmarks

Expected performance (with mocked I/O):

| Operation | Expected Time |
|-----------|---------------|
| Single show processing | < 5 seconds |
| Single movie processing | < 5 seconds |
| JSON file write | < 0.1 seconds |
| JSON file read | < 0.1 seconds |
| Image download (mocked) | < 1 second |
| API request (mocked) | < 1 second |

## 🔍 Running Specific Tests

### By Test Name

```bash
# Run specific test by name
pytest tests/test_business_rules.py::TestCacheExpiration::test_metadata_refresh_needed_after_24_hours -v

# Run tests matching pattern
pytest -k "metadata_refresh" -v
pytest -k "blurhash" -v
pytest -k "performance" -v
```

### By Category

```bash
# Business logic only
pytest -m business_rules -v

# File operations only
pytest -m file_generation -v

# Performance tests only
pytest -m performance -v

# Unit tests (no I/O)
pytest -m unit -v

# Integration tests
pytest -m integration -v
```

### Exclude Categories

```bash
# Skip slow tests
pytest -m "not slow" -v

# Skip performance tests
pytest -m "not performance" -v
```

## 📝 Test Coverage

Generate coverage reports:

```bash
# HTML coverage report (opens in browser)
pytest --cov=utils --cov-report=html
open htmlcov/index.html  # macOS/Linux
start htmlcov/index.html  # Windows

# Terminal coverage report
pytest --cov=utils --cov-report=term-missing

# Coverage with specific threshold
pytest --cov=utils --cov-fail-under=80
```

Target coverage goals:
- **Overall**: > 80%
- **Business logic**: > 90%
- **File operations**: > 85%

## 🧪 Test Examples

### Example 1: Verify 24-Hour Cache

```python
# Test: Metadata should refresh after 24 hours
pytest tests/test_business_rules.py::TestCacheExpiration::test_metadata_refresh_needed_after_24_hours -v

# Expected output:
# ✓ Creates metadata file with old timestamp
# ✓ Checks if refresh is needed
# ✓ Asserts refresh is True
```

### Example 2: Validate Metadata Structure

```python
# Test: Metadata should contain all required fields
pytest tests/test_file_generation.py::TestMetadataGeneration::test_metadata_required_fields_tv -v

# Expected output:
# ✓ Creates metadata.json
# ✓ Validates required fields exist
# ✓ Checks data types and structure
```

### Example 3: Performance Benchmark

```python
# Test: Single show should process quickly
pytest tests/test_performance.py::TestScriptPerformance::test_single_show_processing_time -v

# Expected output:
# ✓ Processes complete show
# ✓ Measures execution time
# ✓ Asserts time < 5 seconds
# Single show processing time: 0.23s
```

## 🐛 Debugging Tests

### Verbose Output

```bash
# Maximum verbosity
pytest -vv

# Show print statements
pytest -s

# Show local variables on failure
pytest -l

# Stop on first failure
pytest -x

# Drop into debugger on failure
pytest --pdb
```

### Specific Test Debugging

```bash
# Run one test with full output
pytest tests/test_business_rules.py::TestCacheExpiration::test_metadata_refresh_needed_after_24_hours -vv -s

# Show fixture setup/teardown
pytest --setup-show
```

## 🔧 Configuration

### pytest.ini

The test suite is configured via `pytest.ini`:

```ini
[pytest]
# Test discovery
python_files = test_*.py
testpaths = tests

# Markers
markers =
    unit: Unit tests
    integration: Integration tests
    performance: Performance tests
    business_rules: Business logic tests
    file_generation: File creation tests
    slow: Slow-running tests

# Output options
addopts = -v --strict-markers --tb=short --durations=10
```

### Environment Variables

Set environment variables for tests:

```bash
# Use .env.local from parent directory
export TMDB_API_KEY="your_api_key"
export BASE_PATH="/var/www/html"

# Or create tests/.env file
echo "TMDB_API_KEY=your_key" > tests/.env
```

## 📊 Continuous Integration

### GitHub Actions Example

```yaml
name: Run Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-python@v2
        with:
          python-version: '3.9'
      - name: Install dependencies
        run: |
          cd scripts
          pip install -r requirements.txt
          pip install pytest pytest-asyncio pytest-cov
      - name: Run tests
        run: |
          cd scripts
          pytest --cov=utils --cov-report=xml
      - name: Upload coverage
        uses: codecov/codecov-action@v2
```

## 🎨 Custom Fixtures

The test suite includes comprehensive fixtures:

### Directory Fixtures
- `temp_dir`: Temporary test directory
- `mock_base_path`: Mock BASE_PATH structure
- `mock_tv_show_structure`: Complete TV show directory
- `mock_movie_structure`: Complete movie directory

### Data Fixtures
- `mock_tmdb_tv_response`: Sample TV show response
- `mock_tmdb_movie_response`: Sample movie response
- `mock_tmdb_episode_response`: Sample episode response
- `mock_tmdb_response_with_blurhash`: Response with blurhash data

### Utility Fixtures
- `performance_tracker`: Track execution times
- `blurhash_validator`: Validate blurhash format
- `assert_file_exists`: Assert file existence
- `assert_json_structure`: Validate JSON structure

## 📚 Additional Resources

### Writing New Tests

```python
import pytest

@pytest.mark.unit
@pytest.mark.asyncio
async def test_my_feature(mock_tv_show_structure, mock_aiohttp_session):
    """Test description."""
    # Arrange
    show_dir = mock_tv_show_structure["show_dir"]
    
    # Act
    result = await my_function(show_dir)
    
    # Assert
    assert result is not None
```

### Mocking TMDB API

```python
@pytest.fixture
async def mock_tmdb_api(mock_aiohttp_session):
    """Mock TMDB API with custom response."""
    mock_response = {
        "id": 12345,
        "name": "Custom Show"
    }
    
    mock_aiohttp_session.get.return_value.__aenter__.return_value.json = AsyncMock(
        return_value=mock_response
    )
    
    return mock_aiohttp_session
```

## 🤝 Contributing

When adding new tests:

1. **Use appropriate markers**: `@pytest.mark.unit`, `@pytest.mark.business_rules`, etc.
2. **Follow naming conventions**: `test_<feature>_<scenario>`
3. **Add docstrings**: Explain what the test validates
4. **Use fixtures**: Leverage existing fixtures for consistency
5. **Keep tests isolated**: Each test should be independent
6. **Assert clearly**: Use descriptive assertion messages

## 📞 Support

If tests fail:

1. Check environment variables (TMDB_API_KEY, BASE_PATH)
2. Verify dependencies are installed
3. Review test output with `-vv` flag
4. Check fixture setup with `--setup-show`
5. Run specific test in isolation

## 📄 License

Same as parent project.
