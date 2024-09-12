#!/usr/bin/env python3
import blurhash
import sys
from PIL import Image
import io
import base64

def generate_blurhash(image_path, x_components=4, y_components=3):
    try:
        with Image.open(image_path) as img:
            # Convert to RGBA if the image has transparency
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                img = img.convert('RGBA')

            # Convert the image to a file-like object
            buffered = io.BytesIO()
            img.save(buffered, format="JPEG")  # Save image to buffer as JPEG
            buffered.seek(0)

            # Now use this buffer with blurhash
            hash = blurhash.encode(buffered, x_components, y_components)
        return hash
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return None

def blurhash_to_base64(hash, width=400, height=300):
    try:
        # Decode the blurhash to an image
        image = blurhash.decode(hash, width, height)
        buffered = io.BytesIO()
        image.save(buffered, format="PNG")
        return base64.b64encode(buffered.getvalue()).decode()
    except Exception as e:
        print(f"Error converting blurhash to base64: {e}", file=sys.stderr)
        return None

def process_image(image_path):
    blurhash_string = generate_blurhash(image_path)
    if blurhash_string:
        base64_image = blurhash_to_base64(blurhash_string)
        return base64_image
    return None

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: blurhash-cli <image_path>")
        sys.exit(1)
    
    result = process_image(sys.argv[1])
    if result:
        print(result)

else:
    # Export functions for use in other Python scripts
    __all__ = ['generate_blurhash', 'blurhash_to_base64', 'process_image']
