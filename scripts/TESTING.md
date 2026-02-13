# 🚀 Quick Start - Running TMDB Metadata Tests

## Install Dependencies

```bash
cd scripts
pip install -r test-requirements.txt
```

## Run Tests

### Option 1: Using pytest directly

```bash
# All tests
pytest

# With coverage
pytest --cov=utils --cov-report=html

# Only business rules
pytest -m business_rules

# Only performance tests
pytest -m performance

# Skip slow tests
pytest -m "not slow"
```

### Option 2: Using test runner

```bash
# All tests
python run_tests.py

# Unit tests only
python run_tests.py --unit

# With coverage
python run_tests.py --coverage

# Fast mode (skip slow tests)
python run_tests.py --fast

# Stop on first failure
python run_tests.py --failfast
```

## Expected Results

✅ **Business Rules Tests** (test_business_rules.py)
- 24-hour cache expiration
- Config change detection
- Force refresh behavior
- update_metadata flag compliance

✅ **Data Validation Tests** (test_tmdb_data_validation.py) ⭐ **NEW**
- **Cast Data Validation**: Ensures cast members have correct structure (id, name, character, profile_path)
- **Genre Data Validation**: Validates genre IDs and names match TMDB standards
- **API Response Parsing**: Tests TMDB API response handling for cast/genres
- **Metadata JSON Structure**: Verifies saved metadata.json matches Node.js expectations
- **Edge Cases**: Handles empty arrays, missing data, special characters

✅ **File Generation Tests** (test_file_generation.py)
- metadata.json creation
- Image downloads (poster/backdrop/logo)
- Episode files
- Blurhash validation

✅ **Performance Tests** (test_performance.py)
- Execution time tracking
- API request benchmarks
- File I/O performance
- Large cast array handling (100+ members)

✅ **Integration Tests** (test_integration.py)
- End-to-end workflow validation
- Error recovery

## View Results

```bash
# Open coverage report (after running with --coverage)
start htmlcov/index.html  # Windows
open htmlcov/index.html   # macOS
xdg-open htmlcov/index.html  # Linux
```

## Troubleshooting

### Tests fail with import errors
```bash
# Ensure you're in the scripts directory
cd scripts
export PYTHONPATH="${PYTHONPATH}:$(pwd)"
pytest
```

### Need TMDB_API_KEY
```bash
# Set environment variable
export TMDB_API_KEY="your_api_key"
# Or create .env file in scripts directory
echo "TMDB_API_KEY=your_key" > .env
```

### Tests run too slow
```bash
# Use pytest-xdist for parallel execution
pip install pytest-xdist
pytest -n auto  # Use all CPU cores
```

## Next Steps

1. ✅ Run all tests: `python run_tests.py`
2. ✅ Check coverage: `python run_tests.py --coverage`
3. ✅ Review test output and performance metrics
4. ✅ Add custom tests as needed

For detailed documentation, see [tests/README.md](tests/README.md)
