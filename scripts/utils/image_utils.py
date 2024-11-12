import os
from urllib.parse import urlparse
import aiohttp
import asyncio
import aiofiles
from utils.blurhash_cli import process_image

async def generate_blurhash_for_image(file_path, blurhash_file_path):
    """
    Generates the blurhash for the given image file and saves it to the blurhash file.
    """
    try:
        # Await the async generate_blurhash function directly
        blurhash_string = await process_image(file_path)
        if blurhash_string:  # Ensure the blurhash is valid
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
    After downloading, it generates a blurhash for the image.
    
    Parameters:
        session (aiohttp.ClientSession): The HTTP session to use for downloading.
        image_url (str): The URL of the image to download.
        file_path (str): The local file path to save the downloaded image.
        force_download (bool): If True, forces re-downloading even if the file exists.
    """
    # Check if the image already exists and skip downloading if not forced
    if os.path.exists(file_path) and not force_download:
        print(f"Image already exists at {file_path}. Skipping download.")
        return

    # Define the blurhash file path
    blurhash_file_path = f"{file_path}.blurhash"

    # Remove existing blurhash file to ensure consistency
    if os.path.exists(blurhash_file_path):
        try:
            os.remove(blurhash_file_path)
            print(f"Deleted existing blurhash file: {blurhash_file_path}")
        except FileNotFoundError:
            print(f"Blurhash file not found for deletion: {blurhash_file_path}")
        except Exception as e:
            print(f"Error deleting blurhash file: {e}")

    try:
        # Download the image
        async with session.get(image_url) as response:
            if response.status == 200:
                image_data = await response.read()
                # Save the image synchronously to ensure it's fully written before proceeding
                with open(file_path, mode='wb') as f:
                    f.write(image_data)
                    f.flush()
                    os.fsync(f.fileno())  # Force write buffer to disk
                print(f"Image successfully downloaded and saved to {file_path}")
            else:
                print(f"Failed to download image. HTTP Status: {response.status}")
                return  # Exit if download failed

        # Confirm that the file has been written and is not empty
        if os.path.exists(file_path) and os.path.getsize(file_path) > 0:
            # Directly await the blurhash generation
            await generate_blurhash_for_image(file_path, blurhash_file_path)
        else:
            print(f"Verification failed: {file_path} does not exist or is empty.")
                
    except aiohttp.ClientError as e:
        print(f"HTTP error occurred while downloading the image: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

def extract_file_extension(url):
    """
    Extracts and returns the file extension from a URL.
    
    Parameters:
        url (str): The URL to extract the file extension from.
    
    Returns:
        str: The file extension, including the dot (e.g., '.jpg'). Returns an empty string if none found.
    """
    parsed_url = urlparse(url)
    return os.path.splitext(parsed_url.path)[1]

# Example usage
async def main():
    image_urls = [
        "https://example.com/path/to/backdrop.jpg",
        "https://example.com/path/to/poster.jpg",
        "https://example.com/path/to/logo.png"
    ]
    
    async with aiohttp.ClientSession() as session:
        tasks = []
        for image_url in image_urls:
            file_extension = extract_file_extension(image_url)
            file_path = f"downloaded_image_{os.path.basename(image_url)}"
            tasks.append(download_image_file(session, image_url, file_path, force_download=True))
        await asyncio.gather(*tasks)

if __name__ == "__main__":
    asyncio.run(main())
