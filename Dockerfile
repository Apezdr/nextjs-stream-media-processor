# Use a compatible Node.js image as a parent image
FROM node:18.17.0-alpine AS builder

# Install necessary tools
RUN apk add --no-cache python3 py3-pip curl jq bash ffmpeg libavif libavif-apps

# Set the working directory for Node.js dependencies
WORKDIR /usr/src/app/node

# Copy package.json and package-lock.json to the working directory
COPY node/package*.json ./

# Use build arguments for environment variables
ARG NODE_ENV
ARG API_KEY

# Set environment variables
ENV NODE_ENV=${NODE_ENV}
ENV API_KEY=${API_KEY}

# Install Node.js dependencies including sharp with optional dependencies
RUN npm install --include=optional

# Copy all Node.js application files to the working directory
COPY node ./

# Remove .env.local after using it
RUN rm -f .env.local

# Build stage is complete, now create the final runtime stage
FROM node:18.17.0-alpine

# Add necessary repositories
RUN echo "http://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories && \
    echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
    echo "http://dl-cdn.alpinelinux.org/alpine/edge/testing" >> /etc/apk/repositories

# Update and install required packages
RUN apk update && \
    apk add --no-cache \
    python3 \
    py3-pip \
    curl \
    jq \
    bash \
    ffmpeg \
    mediainfo \
    sqlite \
    sudo \
    gcc \
    musl-dev \
    linux-headers \
    python3-dev \
    libavif \
    libavif-apps \
    libva \
    libva-utils \
    libva-intel-driver \
    intel-media-driver \
    mesa-va-gallium \
    pciutils \
    dos2unix \
    mesa-dri-gallium

# Update
RUN apk upgrade --available

# Set environment variables for VA-API
ENV LIBVA_DRIVERS_PATH=/usr/lib/dri
ENV LIBVA_DRIVER_NAME=iHD
ENV GST_VAAPI_ALL_DRIVERS=1

# Create necessary symlinks for VA-API drivers
RUN mkdir -p /usr/lib/dri && \
    ln -s /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so /usr/lib/dri/ || true && \
    ln -s /usr/lib/x86_64-linux-gnu/dri/i965_drv_video.so /usr/lib/dri/ || true

# Set the working directory for the application
WORKDIR /usr/src/app

# Copy all other application files to the container
COPY . .

# Copy Node.js application and dependencies from the build stage
COPY --from=builder /usr/src/app/node /usr/src/app/node

# Create a virtual environment for Python packages
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies in the virtual environment
COPY requirements.txt /tmp/
RUN /opt/venv/bin/pip install -r /tmp/requirements.txt

# Install PIL (Pillow) for image processing within the virtual environment
RUN /opt/venv/bin/pip install Pillow

# Remove build dependencies to reduce image size
RUN apk del gcc musl-dev linux-headers python3-dev

# Grant execution rights on the scripts
RUN chmod +x /usr/src/app/scripts/*.sh /usr/src/app/scripts/*.py

# Convert scripts to Unix format
RUN dos2unix /usr/src/app/scripts/*.sh

# Command to run Node.js app
CMD ["sh", "-c", "node /usr/src/app/node/app.mjs --max-old-space-size=6144"]