import os
import requests
import threading
from utils.tmdb_utils import process_image  # Adjust this import if necessary
from urllib.parse import urlparse

def generate_blurhash_for_image(file_path, blurhash_file_path):
    """
    Generates the blurhash for the given image file and saves it to the blurhash file.
    """
    try:
        blurhash_string = process_image(file_path)
        if blurhash_string:  # Check if the blurhash_string is valid (not None or empty)
            with open(blurhash_file_path, 'w') as blurhash_file:
                blurhash_file.write(blurhash_string)
            print(f"Blurhash saved to {blurhash_file_path}")
        else:
            print("No valid blurhash generated for the image.")
    except Exception as e:
        print(f"Error generating blurhash: {e}")

def download_image_file(image_url, file_path, force_download=False):
    """
    Downloads an image from the given URL to the specified file path.
    """
    # Check if the file exists and download only if needed
    if os.path.exists(file_path) and not force_download:
        return  # Skip download if the file exists and force_download is not set
    
    # Delete any accompanying blurhash file before downloading the new image
    blurhash_file_path = file_path + '.blurhash'
    if os.path.exists(blurhash_file_path):
        try:
            os.remove(blurhash_file_path)
            print(f"Deleted accompanying blurhash file: {blurhash_file_path}")
        except FileNotFoundError:
            print(f"Blurhash file not found: {blurhash_file_path}")

    # Attempt to download the image
    response = requests.get(image_url, stream=True)
    if response.status_code == 200:
        with open(file_path, 'wb') as file:
            for chunk in response.iter_content(1024):
                file.write(chunk)
        print(f"Image downloaded and saved to {file_path}")

        # Start the blurhash generation in a separate thread
        blurhash_thread = threading.Thread(target=generate_blurhash_for_image, args=(file_path, blurhash_file_path))
        blurhash_thread.start()

    else:
        print(f"Failed to download image from {image_url}. Status code: {response.status_code}")

def extract_file_extension(url):
    """
    Extracts and returns the file extension from a URL.
    """
    parsed_url = urlparse(url)
    return os.path.splitext(parsed_url.path)[1]
