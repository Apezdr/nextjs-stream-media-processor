import os
#import requests
import aiohttp
import asyncio
import aiofiles
#import threading
from utils.tmdb_utils import process_image  # Adjust this import if necessary
from urllib.parse import urlparse

async def generate_blurhash_for_image(file_path, blurhash_file_path):
    """
    Generates the blurhash for the given image file and saves it to the blurhash file.
    """
    try:
        blurhash_string = await asyncio.to_thread(process_image, file_path)
        if blurhash_string:  # Check if the blurhash_string is valid (not None or empty)
            async with aiofiles.open(blurhash_file_path, 'w') as blurhash_file:
                await blurhash_file.write(blurhash_string)
            print(f"Blurhash saved to {blurhash_file_path}")
        else:
            print("No valid blurhash generated for the image.")
    except Exception as e:
        print(f"Error generating blurhash: {e}")

async def download_image_file(session, image_url, file_path, force_download=False):
    """
    Downloads an image from the given URL to the specified file path asynchronously.
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

    # Attempt to download the image asynchronously
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(image_url) as response:
                if response.status == 200:
                    f = await aiofiles.open(file_path, mode='wb')
                    await f.write(await response.read())
                    await f.close()
                    print(f"Image downloaded and saved to {file_path}")

                    # Start the blurhash generation asynchronously
                    await generate_blurhash_for_image(file_path, blurhash_file_path)
                else:
                    print(f"Failed to download image from {image_url}. Status code: {response.status}")
        except aiohttp.ClientError as e:
            print(f"An error occurred while downloading the image: {e}")

def extract_file_extension(url):
    """
    Extracts and returns the file extension from a URL.
    """
    parsed_url = urlparse(url)
    return os.path.splitext(parsed_url.path)[1]
