import json
import os
from datetime import datetime, timedelta

def load_tmdb_config_file(config_path):
    """
    Loads the TMDB configuration from a given file path.
    Returns the content of the config file as a dictionary.
    """
    if os.path.exists(config_path):
        with open(config_path, 'r') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError as e:
                print(f"Error decoding JSON from {config_path}: {e}")
                return {}  # Return an empty dict in case of error
    return {}

def update_tmdb_config(tmdb_config_path, tmdb_config, media_id, media_name):
    """
    Updates the tmdb.config file with the TMDB ID if it's not already present.
    """
    if not os.path.exists(tmdb_config_path):
        # tmdb.config doesn't exist, create it and set 'tmdb_id'
        tmdb_config = {'tmdb_id': media_id}
        with open(tmdb_config_path, 'w') as f:
            json.dump(tmdb_config, f, indent=4)
        print(f"Created tmdb.config with tmdb_id {media_id} for {media_name}")
    else:
        # tmdb.config exists, check if 'tmdb_id' is defined
        if 'tmdb_id' not in tmdb_config:
            # Add 'tmdb_id' to tmdb.config
            tmdb_config['tmdb_id'] = media_id
            with open(tmdb_config_path, 'w') as f:
                json.dump(tmdb_config, f, indent=4)
            print(f"Added tmdb_id {media_id} to tmdb.config for {media_name}")
        else:
            # 'tmdb_id' is already defined, do not overwrite
            print(f"tmdb_id is already defined in tmdb.config for {media_name}, not overwriting.")

def should_refresh_metadata(metadata_file, tmdb_config_path):
    """
    Determines if the metadata needs to be refreshed based on file modification times.
    """
    need_refresh = True
    if os.path.exists(metadata_file):
        metadata_last_modified = datetime.fromtimestamp(os.path.getmtime(metadata_file))
        config_last_modified = datetime.fromtimestamp(os.path.getmtime(tmdb_config_path)) if os.path.exists(tmdb_config_path) else None

        # Check if the metadata file is older than 1 day or if the config file was updated more recently
        need_refresh = (datetime.now() - metadata_last_modified >= timedelta(days=1)) or (config_last_modified and config_last_modified > metadata_last_modified)
    return need_refresh
