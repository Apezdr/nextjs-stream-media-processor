#!/usr/bin/env python3
import blurhash
import sys
from PIL import Image
import io
import base64
import asyncio
import os

# Async function to generate a blurhash from an image file
async def generate_blurhash(image_path, x_components=4, y_components=3):
    try:
        # Use asyncio.to_thread to open the image without blocking the event loop
        img = await asyncio.to_thread(Image.open, image_path)
        
        # Convert to RGBA if the image has transparency
        if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
            img = await asyncio.to_thread(img.convert, 'RGBA')

        # Convert to RGB if needed
        if img.mode != 'RGB':
            img = await asyncio.to_thread(img.convert, 'RGB')

        # Get original image dimensions
        width, height = img.size

        # Save the image to an in-memory buffer
        buffered = io.BytesIO()
        await asyncio.to_thread(img.save, buffered, format="JPEG")  # Save image to buffer as JPEG
        buffered.seek(0)

        # Use this buffer with blurhash (non-blocking)
        hash = await asyncio.to_thread(blurhash.encode, buffered, x_components, y_components)
        
        # Close the image (clean up)
        img.close()

        return hash, width, height
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return None

# Async function to convert a blurhash string to a base64-encoded image
async def blurhash_to_base64(hash, width, height):
    try:
        width = int(width)
        height = int(height)
        # Decode the blurhash to an image (non-blocking)
        image = await asyncio.to_thread(blurhash.decode, hash, width, height)
        buffered = io.BytesIO()
        await asyncio.to_thread(image.save, buffered, format="PNG")
        return base64.b64encode(buffered.getvalue()).decode()
    except Exception as e:
        print(f"Error converting blurhash to base64: {e}", file=sys.stderr)
        return None

# Async function to process an image (generate blurhash and convert to base64)
async def process_image(image_path):
    result = await generate_blurhash(image_path)
    if result:
        blurhash_string, original_width, original_height = result
        max_height = 80
        if original_height == 0:
            print(f"Error: Original image height is zero.", file=sys.stderr)
            return None
        output_height = min(original_height, max_height)
        scale_factor = output_height / original_height
        output_width = int(original_width * scale_factor)
        # Ensure output_width is at least 1
        output_width = max(output_width, 1)
        output_height = int(output_height)
        base64_image = await blurhash_to_base64(blurhash_string, width=output_width, height=output_height)
        return base64_image
    return None

# Main function to handle command-line execution
async def main():
    if len(sys.argv) != 2:
        print("Usage: blurhash-cli <image_path>")
        sys.exit(1)

    image_path = sys.argv[1]
    if not os.path.exists(image_path):
        print(f"Error: The file '{image_path}' does not exist.", file=sys.stderr)
        sys.exit(1)

    result = await process_image(image_path)
    if result:
        print(result)

# Entry point for the script
if __name__ == "__main__":
    # Run the main function asynchronously
    asyncio.run(main())
else:
    # Export functions for use in other Python scripts
    __all__ = ['generate_blurhash', 'blurhash_to_base64', 'process_image']
