# Stage 1: Build Stage
FROM node:25-alpine AS builder

# Whisper.cpp GPU backend selection. "none" (default) builds a CPU-only binary;
# "vulkan" enables the Vulkan compute backend for ~3-5x speedup on Intel ARC,
# AMD, and NVIDIA GPUs. CUDA support lives in Dockerfile.cuda (separate base
# image required).
ARG WHISPER_GPU=none

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

# Build whisper.cpp (whisper-cli binary) for on-demand caption generation.
# Model files are downloaded lazily at runtime, not baked into the image.
RUN set -e && \
    apk add --no-cache cmake git && \
    if [ "$WHISPER_GPU" = "vulkan" ]; then \
        echo "[whisper.cpp] building with Vulkan backend"; \
        apk add --no-cache vulkan-headers vulkan-loader-dev shaderc spirv-headers spirv-tools-dev; \
        GPU_FLAGS="-DGGML_VULKAN=ON"; \
    else \
        echo "[whisper.cpp] building CPU-only (WHISPER_GPU=$WHISPER_GPU)"; \
        GPU_FLAGS=""; \
    fi && \
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /tmp/whisper.cpp && \
    cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON \
        $GPU_FLAGS && \
    cmake --build /tmp/whisper.cpp/build --target whisper-cli -j && \
    install -m755 /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli && \
    rm -rf /tmp/whisper.cpp

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
#
# NOTE: The Python pytest suite that used to run here was removed when the
# TMDB image-download workflow was migrated from `scripts/download_tmdb_images.py`
# to the in-process Node MetadataGenerator. All TMDB business-logic tests now
# live in `node/tests/` and are exercised by the Jest run below.

# Run Node.js test suite with secret mount (API key never stored in image layers)
WORKDIR /usr/src/app/node
RUN --mount=type=secret,id=tmdb_api_key \
    echo "" && \
    echo "============================================" && \
    echo "Running Node.js Test Suite" && \
    echo "============================================" && \
    if [ -f /run/secrets/tmdb_api_key ]; then \
        echo "✓ TMDB_API_KEY secret detected - Running ALL tests (including critical integration tests)..."; \
        # Disable OpenTelemetry during tests
        export OTEL_ENABLED=false; \
        export TMDB_API_KEY=$(cat /run/secrets/tmdb_api_key); \
        node --experimental-vm-modules node_modules/jest/bin/jest.js --verbose --forceExit; \
    else \
        echo "⚠️  WARNING: No TMDB_API_KEY secret - skipping integration tests"; \
        echo "ℹ️  Build with: docker build --secret id=tmdb_api_key,env=TMDB_API_KEY ..."; \
        # Disable OpenTelemetry during tests
        export OTEL_ENABLED=false; \
        node --experimental-vm-modules node_modules/jest/bin/jest.js --verbose --forceExit --testPathIgnorePatterns=cross-platform-metadata; \
    fi && \
    echo "✓ Node.js tests passed!"

# Mark testing complete. The production stage COPY's this marker file
# from the testing stage so that if any RUN above fails, the production
# build fails too (you can't COPY from a stage that didn't build).
RUN echo "" && \
    echo "============================================" && \
    echo "✓ All Tests Passed - Build Validated!" && \
    echo "============================================" && \
    echo "" && \
    echo "🔒 Security Check: Verifying no secrets in this stage..." && \
    if printenv | grep -i "TMDB_API_KEY"; then \
        echo "⚠️  TMDB_API_KEY found in testing stage (OK - not in final image)"; \
    fi && \
    echo "node-tests-passed" > /tmp/tests-passed.marker

# Stage 2: Production Stage
FROM node:25.2.1-alpine

# Re-declare so the production stage can install matching runtime libraries
# and surface the choice via env. Must be passed at build time:
#   docker build --build-arg WHISPER_GPU=vulkan ...
ARG WHISPER_GPU=none

# Set environment variables for VA-API
ENV LIBVA_DRIVERS_PATH=/usr/lib/dri
ENV LIBVA_DRIVER_NAME=iHD
ENV GST_VAAPI_ALL_DRIVERS=1

# Set default OpenTelemetry environment variables (can be overridden at runtime)
# These variables control the OpenTelemetry SDK behavior
ENV OTEL_ENABLED=false
ENV OTEL_SERVICE_NAME=nextjs-stream-media-processor
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
ENV OTEL_EXPORTER_OTLP_PROTOCOL=grpc
ENV OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.namespace=media-processor,service.version=1.0.0
ENV OTEL_PROPAGATORS=tracecontext,baggage
ENV OTEL_TRACES_SAMPLER=always_on
ENV OTEL_LOG_LEVEL=info

# Pin whisper-cli paths for the container so the Node process doesn't fall back
# to its host-OS-relative defaults (which target local development setups).
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODELS_DIR=/usr/src/app/whisper-models
# Surface the GPU backend choice to the running app (read by /api/captions/health).
ENV WHISPER_GPU_BACKEND=$WHISPER_GPU

# Set working directory for the runtime
WORKDIR /usr/src/app

# Copy built assets and dependencies from the builder stage
COPY --from=builder /usr/src/app/node /usr/src/app/node
COPY --from=builder /usr/src/app/scripts /usr/src/app/scripts
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
# Copy a marker file produced only by the testing stage to force it to run
# during build (if any test fails, the stage doesn't produce this file and
# this COPY fails the whole build).
COPY --from=testing /tmp/tests-passed.marker /tmp/tests-passed.marker

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

# Vulkan runtime: loader + Mesa drivers. NVIDIA users get their driver injected
# by the NVIDIA Container Toolkit at runtime, so no Mesa NVIDIA driver is
# needed here. Skipped entirely for CPU builds.
#   mesa-vulkan-intel  - ANV (Intel ARC + iGPU)
#   mesa-vulkan-ati    - RADV (AMD Radeon) -- alpine package name preserves
#                        the original upstream "ati" name
RUN if [ "$WHISPER_GPU" = "vulkan" ]; then \
        echo "[runtime] installing Vulkan loader + Mesa GPU drivers"; \
        apk add --no-cache vulkan-loader mesa-vulkan-intel mesa-vulkan-ati; \
    fi

# Grant execution rights to remaining Python scripts. Shell scripts under
# scripts/ were removed when the TMDB workflow moved to Node; nothing is left
# that needs dos2unix.
RUN chmod +x /usr/src/app/scripts/*.py

# The default user of node:25.2.1-alpine is 'node' with UID/GID 1000
# Create the logs and whisper-models directories and set ownership to the 'node' user.
# whisper-models holds whisper.cpp ggml model files, downloaded lazily at runtime.
RUN mkdir -p /usr/src/app/logs /usr/src/app/whisper-models && \
    chown 1000:1000 /usr/src/app/logs /usr/src/app/whisper-models
# ---------------------------------------------------------------------------

# Command to run your Node.js app
CMD ["sh", "-c", "node /usr/src/app/node/app.mjs --max-old-space-size=6144"]