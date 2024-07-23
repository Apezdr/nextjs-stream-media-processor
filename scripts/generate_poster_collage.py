from PIL import Image
import os

def create_collage(width, height, list_of_images):
    collage = Image.new('RGB', (width, height))
    curr_x = -width // 4  # Start with a negative offset to cut off part of the image
    curr_y = -15
    for image in list_of_images:
        img = Image.open(image)
        img.thumbnail((width // 6.7, height // 6.7))  # Adjust thumbnail size as needed
        collage.paste(img, (curr_x, curr_y))
        curr_x += img.size[0]
        if curr_x >= collage.width:
            curr_x = -width // 10  # Reset to negative offset for each new row
            curr_y += img.size[1]
    return collage

def get_posters(directory, poster_name):
    posters = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file == poster_name:
                posters.append(os.path.join(root, file))
    return posters

# Paths
movies_dir = '/var/www/html/movies'
tv_dir = '/var/www/html/tv'

# Collect posters
movie_posters = get_posters(movies_dir, 'poster.jpg')
tv_posters = get_posters(tv_dir, 'show_poster.jpg')
all_posters = movie_posters + tv_posters + movie_posters + tv_posters + movie_posters + tv_posters + movie_posters + tv_posters + movie_posters + tv_posters + movie_posters + tv_posters

# Define collage size
collage_width = 4200  # You can adjust this
collage_height = 3000  # You can adjust this

# Create collage
collage = create_collage(collage_width, collage_height, all_posters)

# Save collage
collage.save('/var/www/html/poster_collage.jpg')
