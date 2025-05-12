# Stage 1: Build Stage
FROM node:18.17.0-alpine AS builder

# Install necessary build tools and runtime packages needed for building
RUN apk add --no-cache \
    python3 \
    py3-pip \
    curl \
    jq \
    bash \
    ffmpeg \
    mediainfo \
    sqlite \
    sudo \
    libavif \
    libavif-apps \
    gcc \
    musl-dev \
    linux-headers \
    python3-dev

# Set working directory for the build
WORKDIR /usr/src/app

# Copy the entire application source (including the node/ folder, scripts, etc.)
COPY . .

# Switch to the Node.js subdirectory to install dependencies
WORKDIR /usr/src/app/node
RUN npm install --include=optional

# Create Python virtual environment and install Python dependencies
WORKDIR /usr/src/app
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt /tmp/
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

# Stage 2: Production Stage
FROM node:18.17.0-alpine

# Set environment variables for VA-API
ENV LIBVA_DRIVERS_PATH=/usr/lib/dri
ENV LIBVA_DRIVER_NAME=iHD
ENV GST_VAAPI_ALL_DRIVERS=1

# Set working directory for the runtime
WORKDIR /usr/src/app

# Copy built assets and dependencies from the builder stage
COPY --from=builder /usr/src/app/node /usr/src/app/node
COPY --from=builder /usr/src/app/scripts /usr/src/app/scripts
COPY --from=builder /opt/venv /opt/venv

# Ensure the virtual environment's bin is in the PATH
ENV PATH="/opt/venv/bin:$PATH"

# Install runtime dependencies from the stable repositories
RUN apk add --no-cache \
    python3 \
    py3-pip \
    curl \
    jq \
    bash \
    ffmpeg \
    mediainfo \
    libavif \
    libavif-apps \
    libva \
    libva-intel-driver \
    intel-media-driver \
    mesa-va-gallium \
    pciutils \
    dos2unix \
    mesa-dri-gallium && \
    # Install libva-utils from the edge community repository explicitly
    apk add --no-cache libva-utils --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community

# Grant execution rights and convert scripts to Unix format
RUN chmod +x /usr/src/app/scripts/*.sh /usr/src/app/scripts/*.py && \
    dos2unix /usr/src/app/scripts/*.sh

# Command to run your Node.js app
CMD ["sh", "-c", "node /usr/src/app/node/app.mjs --max-old-space-size=6144"]
