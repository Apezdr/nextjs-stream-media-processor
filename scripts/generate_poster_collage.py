from PIL import Image
import os
import math
from dotenv import load_dotenv
from pathlib import Path

# Load environment variables from .env.local in parent directory
env_path = Path(__file__).parent.parent / '.env.local'
load_dotenv(env_path)

# Get base path from environment variable with default fallback
BASE_PATH = os.getenv('BASE_PATH', '/var/www/html')

def create_collage(width, height, list_of_images):
    collage = Image.new('RGB', (width, height))
    curr_x = 0
    curr_y = 0
    for image in list_of_images:
        img = Image.open(image)
        img.thumbnail((width // 6.7, height // 6.7))  # Adjust thumbnail size as needed
        collage.paste(img, (curr_x, curr_y))
        curr_x += img.size[0]
        if curr_x >= collage.width:
            curr_x = 0  # Reset to the start of the row
            curr_y += img.size[1]
        if curr_y >= collage.height:
            break  # Stop if we have filled the collage
    return collage

def get_posters(directory, poster_name):
    posters = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file == poster_name:
                posters.append(os.path.join(root, file))
    return posters

def repeat_images_to_fill(total_images_needed, images):
    repeated_images = []
    while len(repeated_images) < total_images_needed:
        repeated_images.extend(images)
    return repeated_images[:total_images_needed]

# Paths
movies_dir = os.path.join(BASE_PATH, 'movies')
tv_dir = os.path.join(BASE_PATH, 'tv')
output_path = os.path.join(BASE_PATH, 'poster_collage.jpg')

# Collect posters
movie_posters = get_posters(movies_dir, 'poster.jpg')
tv_posters = get_posters(tv_dir, 'show_poster.jpg')
all_posters = movie_posters + tv_posters

# Define minimum collage size
min_collage_width = 4200
min_collage_height = 3000

# Determine the size of a single thumbnail
sample_image = Image.open(all_posters[0])
sample_image.thumbnail((min_collage_width // 6.7, min_collage_height // 6.7))
image_width, image_height = sample_image.size

# Calculate the number of images needed to cover the collage dimensions
num_images_x = math.ceil(min_collage_width / image_width)
num_images_y = math.ceil(min_collage_height / image_height)
total_images_needed = num_images_x * num_images_y

# Adjust collage dimensions to fit whole posters
collage_width = num_images_x * image_width
collage_height = num_images_y * image_height

# Repeat images to fill the collage
all_posters = repeat_images_to_fill(total_images_needed, all_posters)

# Create collage
collage = create_collage(collage_width, collage_height, all_posters)

# Save collage
collage.save(output_path)
