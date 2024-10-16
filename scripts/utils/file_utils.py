import json
import os
from datetime import datetime, timedelta
import aiofiles
import asyncio
import logging

# Configure logging with timestamps, logger names, and clear messages
# logging.basicConfig(
#     level=logging.INFO,  # Set the default logging level
#     format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',  # Define the log message format
#     datefmt='%Y-%m-%d %H:%M:%S',  # Specify the date format
# )
logger = logging.getLogger(__name__)

async def load_tmdb_config_file(config_path):
    """
    Asynchronously loads the TMDB configuration from a given file path.
    Returns the content of the config file as a dictionary.
    """
    if os.path.exists(config_path):
        try:
            async with aiofiles.open(config_path, 'r') as f:
                content = await f.read()
                return json.loads(content)
        except json.JSONDecodeError as e:
            logger.error(f"Error decoding JSON from {config_path}: {e}")
            return {}  # Return an empty dict in case of error
        except Exception as e:
            logger.error(f"Unexpected error while loading config file {config_path}: {e}")
            return {}
    return {}

async def update_tmdb_config(tmdb_config_path, tmdb_config, media_id, media_name):
    """
    Asynchronously updates the tmdb.config file with the TMDB ID if it's not already present.
    """
    config_exists = os.path.exists(tmdb_config_path)

    if not config_exists:
        # tmdb.config doesn't exist, create it and set 'tmdb_id'
        tmdb_config = {'tmdb_id': media_id}
        try:
            async with aiofiles.open(tmdb_config_path, 'w') as f:
                await f.write(json.dumps(tmdb_config, indent=4))
            logger.info(f"Created tmdb.config with tmdb_id {media_id} for '{media_name}'")
        except Exception as e:
            logger.error(f"Error creating tmdb.config for '{media_name}': {e}")
    else:
        # tmdb.config exists, check if 'tmdb_id' is defined
        if 'tmdb_id' not in tmdb_config:
            # Add 'tmdb_id' to tmdb.config
            tmdb_config['tmdb_id'] = media_id
            try:
                async with aiofiles.open(tmdb_config_path, 'w') as f:
                    await f.write(json.dumps(tmdb_config, indent=4))
                logger.info(f"Added tmdb_id {media_id} to tmdb.config for '{media_name}'")
            except Exception as e:
                logger.error(f"Error updating tmdb.config for '{media_name}': {e}")
        else:
            # 'tmdb_id' is already defined, do not overwrite
            logger.info(f"'tmdb_id' is already defined in tmdb.config for '{media_name}', not overwriting.")

async def should_refresh_metadata(metadata_file, tmdb_config_path):
    """
    Determines asynchronously if the metadata needs to be refreshed based on file modification times.
    """
    need_refresh = True
    try:
        if os.path.exists(metadata_file):
            loop = asyncio.get_event_loop()
            
            # Fetch modification times asynchronously
            metadata_mtime = await loop.run_in_executor(None, os.path.getmtime, metadata_file)
            metadata_last_modified = datetime.fromtimestamp(metadata_mtime)

            if os.path.exists(tmdb_config_path):
                config_mtime = await loop.run_in_executor(None, os.path.getmtime, tmdb_config_path)
                config_last_modified = datetime.fromtimestamp(config_mtime)
            else:
                config_last_modified = None

            # Check if the metadata file is older than 1 day or if the config file was updated more recently
            if (datetime.now() - metadata_last_modified < timedelta(days=1)) and \
               (not config_last_modified or config_last_modified <= metadata_last_modified):
                need_refresh = False
    except Exception as e:
        logger.error(f"Error checking if metadata should be refreshed: {e}")
    
    return need_refresh

async def read_json_file(file_path):
    """
    Asynchronously reads a JSON file and returns its content as a dictionary.
    """
    if os.path.exists(file_path):
        try:
            async with aiofiles.open(file_path, 'r') as f:
                content = await f.read()
                return json.loads(content)
        except json.JSONDecodeError as e:
            logger.error(f"Error decoding JSON from {file_path}: {e}")
            return {}
        except Exception as e:
            logger.error(f"Unexpected error while reading {file_path}: {e}")
            return {}
    return {}

async def write_json_file(file_path, data):
    """
    Asynchronously writes a dictionary to a JSON file.
    """
    try:
        async with aiofiles.open(file_path, 'w') as f:
            await f.write(json.dumps(data, indent=4, sort_keys=True))
        logger.info(f"Successfully wrote to {file_path}")
    except Exception as e:
        logger.error(f"Error writing to {file_path}: {e}")

