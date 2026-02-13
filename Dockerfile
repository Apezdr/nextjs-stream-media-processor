# Stage 1: Build Stage
FROM node:25.2.1-alpine AS builder

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
    g++ \
    make \
    musl-dev \
    linux-headers \
    python3-dev \
    cairo \
    cairo-dev \
    py3-cairo

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

FROM builder AS testing
# Use BuildKit secret mount for TMDB_API_KEY (does NOT leak into image history)
# Secret is only available during RUN commands that explicitly mount it

# Install Python test dependencies
COPY scripts/test-requirements.txt /tmp/
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/test-requirements.txt

# Run Python test suite (skip slow real API tests during build)
WORKDIR /usr/src/app/scripts
RUN echo "============================================" && \
    echo "Running Python Test Suite" && \
    echo "============================================" && \
    /opt/venv/bin/pytest -m "not slow" --cov=utils --cov-report=term-missing tests/ -v --tb=short && \
    echo "✓ Python tests passed!"

# Run Node.js test suite with secret mount (API key never stored in image layers)
WORKDIR /usr/src/app/node
RUN --mount=type=secret,id=tmdb_api_key \
    echo "" && \
    echo "============================================" && \
    echo "Running Node.js Test Suite" && \
    echo "============================================" && \
    if [ -f /run/secrets/tmdb_api_key ]; then \
        echo "✓ TMDB_API_KEY secret detected - Running ALL tests (including critical integration tests)..."; \
        export TMDB_API_KEY=$(cat /run/secrets/tmdb_api_key); \
        node --experimental-vm-modules node_modules/jest/bin/jest.js --verbose; \
    else \
        echo "⚠️  WARNING: No TMDB_API_KEY secret - skipping integration tests"; \
        echo "ℹ️  Build with: docker build --secret id=tmdb_api_key,env=TMDB_API_KEY ..."; \
        node --experimental-vm-modules node_modules/jest/bin/jest.js --verbose --testPathIgnorePatterns=cross-platform-metadata; \
    fi && \
    echo "✓ Node.js tests passed!"

# Mark testing complete
RUN echo "" && \
    echo "============================================" && \
    echo "✓ All Tests Passed - Build Validated!" && \
    echo "============================================" && \
    echo "" && \
    echo "🔒 Security Check: Verifying no secrets in this stage..." && \
    if printenv | grep -i "TMDB_API_KEY"; then \
        echo "⚠️  TMDB_API_KEY found in testing stage (OK - not in final image)"; \
    fi

# Stage 2: Production Stage
FROM node:25.2.1-alpine

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
# Copy test requirements to force the testing stage to run during build
COPY --from=testing /usr/src/app/scripts/test-requirements.txt /tmp/test-proof

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
    cairo \
    mesa-dri-gallium && \
    # Install libva-utils from the edge community repository explicitly
    apk add --no-cache libva-utils --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community

# Grant execution rights and convert scripts to Unix format
RUN chmod +x /usr/src/app/scripts/*.sh /usr/src/app/scripts/*.py && \
    dos2unix /usr/src/app/scripts/*.sh

# The default user of node:25.2.1-alpine is 'node' with UID/GID 1000
# Create the logs directory and set its ownership to the 'node' user
RUN mkdir -p /usr/src/app/logs && chown 1000:1000 /usr/src/app/logs
# ---------------------------------------------------------------------------

# Command to run your Node.js app
CMD ["sh", "-c", "node /usr/src/app/node/app.mjs --max-old-space-size=6144"]