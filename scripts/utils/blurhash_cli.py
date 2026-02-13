#!/usr/bin/env python3
import blurhash
import sys
from PIL import Image
import io
import base64
import asyncio
import os

# Try to import cairosvg for SVG support
try:
    import cairosvg
    SVG_SUPPORT = True
except ImportError:
    SVG_SUPPORT = False

# Async function to convert SVG to PNG
async def convert_svg_to_png(svg_path, png_path, width=512, height=512):
    """
    Convert SVG file to PNG using cairosvg.
    
    Args:
        svg_path: Path to input SVG file
        png_path: Path to output PNG file
        width: Output width (default: 512)
        height: Output height (default: 512)
    """
    if not SVG_SUPPORT:
        raise ImportError("cairosvg is required for SVG support")
    
    def _convert():
        cairosvg.svg2png(url=svg_path, write_to=png_path, output_width=width, output_height=height)
    
    await asyncio.to_thread(_convert)

# Async function to generate a blurhash from an image file
async def generate_blurhash(image_path, x_components=8, y_components=6, max_encode_size=200):
    """
    Generate blurhash from an image file (including SVG support).
    
    PERFORMANCE OPTIMIZATION: Resize image to max_encode_size before encoding.
    Blurhash doesn't need high resolution - encoding from 200px is 10-20x faster
    than encoding from 2000px with virtually identical visual results.
    
    Args:
        image_path: Path to the image file
        x_components: Horizontal blurhash components (default: 8)
        y_components: Vertical blurhash components (default: 6)
        max_encode_size: Max dimension for encoding (default: 200px)
    """
    temp_png_path = None
    try:
        # Check if the file is an SVG
        if image_path.lower().endswith('.svg'):
            if not SVG_SUPPORT:
                print(f"Error: SVG file detected but cairosvg is not available: {image_path}", file=sys.stderr)
                return None
            
            # Convert SVG to temporary PNG file
            temp_png_path = image_path + '.tmp.png'
            await convert_svg_to_png(image_path, temp_png_path, width=512, height=512)
            # Use the temporary PNG file for processing
            actual_image_path = temp_png_path
        else:
            actual_image_path = image_path

        # Use asyncio.to_thread to open the image without blocking the event loop
        img = await asyncio.to_thread(Image.open, actual_image_path)
        
        # Store original dimensions (for aspect ratio calculation)
        original_width, original_height = img.size
        
        # PERFORMANCE OPTIMIZATION: Resize before encoding
        # Encoding blurhash from 200px is 10-20x faster than from 2000px
        if max(original_width, original_height) > max_encode_size:
            # Calculate new size maintaining aspect ratio
            if original_width > original_height:
                new_width = max_encode_size
                new_height = int(original_height * (max_encode_size / original_width))
            else:
                new_height = max_encode_size
                new_width = int(original_width * (max_encode_size / original_height))
            
            # Resize using high-quality LANCZOS resampling
            img = await asyncio.to_thread(img.resize, (new_width, new_height), Image.Resampling.LANCZOS)
        
        # Convert to RGBA if the image has transparency
        if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
            img = await asyncio.to_thread(img.convert, 'RGBA')

        # Convert to RGB if needed
        if img.mode != 'RGB':
            img = await asyncio.to_thread(img.convert, 'RGB')

        # Generate blurhash from the (now smaller) image
        hash = await asyncio.to_thread(blurhash.encode, img, x_components, y_components)
        
        # Close the image (clean up)
        img.close()

        # Return hash with ORIGINAL dimensions (not resized dimensions)
        return hash, original_width, original_height
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None
    finally:
        # Clean up temporary PNG file if it was created
        if temp_png_path and os.path.exists(temp_png_path):
            try:
                os.remove(temp_png_path)
            except Exception as cleanup_error:
                print(f"Warning: Could not clean up temporary file {temp_png_path}: {cleanup_error}", file=sys.stderr)

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
    return await process_image_with_size(image_path, 150)  # Default size

# Async function to process an image with custom size
async def process_image_with_size(image_path, max_height=150):
    result = await generate_blurhash(image_path)
    if result:
        blurhash_string, original_width, original_height = result
        
        if original_height == 0:
            print(f"Error: Original image height is zero.", file=sys.stderr)
            return None
            
        # Calculate output dimensions maintaining aspect ratio
        if original_height > max_height:
            scale_factor = max_height / original_height
            output_height = max_height
            output_width = int(original_width * scale_factor)
        else:
            # Use original dimensions if smaller than max
            output_width = original_width
            output_height = original_height
            
        # Ensure minimum dimensions
        output_width = max(output_width, 1)
        output_height = max(output_height, 1)
        
        base64_image = await blurhash_to_base64(blurhash_string, width=output_width, height=output_height)
        return base64_image
    return None
# Main function to handle command-line execution
async def main():
    if len(sys.argv) < 2 or len(sys.argv) > 3:
        print("Usage: blurhash-cli <image_path> [size]")
        print("  size: 'small' (64px), 'medium' (100px), 'large' (150px, default)")
        sys.exit(1)

    image_path = sys.argv[1]
    size_option = sys.argv[2] if len(sys.argv) == 3 else 'large'
    
    if not os.path.exists(image_path):
        print(f"Error: The file '{image_path}' does not exist.", file=sys.stderr)
        sys.exit(1)

    # Set max height based on size option
    if size_option == 'small':
        max_height = 64
    elif size_option == 'medium':
        max_height = 100
    elif size_option == 'large':
        max_height = 150
    else:
        print(f"Error: Invalid size option '{size_option}'. Use 'small', 'medium', or 'large'.", file=sys.stderr)
        sys.exit(1)

    result = await process_image_with_size(image_path, max_height)
    if result:
        print(result)

# Entry point for the script
if __name__ == "__main__":
    # Run the main function asynchronously
    asyncio.run(main())
else:
    # Export functions for use in other Python scripts
    __all__ = ['generate_blurhash', 'blurhash_to_base64', 'process_image', 'process_image_with_size']
