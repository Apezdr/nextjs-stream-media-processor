# Use a compatible Node.js image as a parent image
FROM node:18.17.0-alpine AS builder

# Install necessary tools
RUN apk add --no-cache python3 py3-pip curl jq bash ffmpeg

# Set the working directory for Node.js dependencies
WORKDIR /usr/src/app/node

# Copy package.json and package-lock.json to the working directory
COPY node/package*.json ./

# Install Node.js dependencies including sharp with optional dependencies
RUN npm install --include=optional

# Copy all Node.js application files to the working directory
COPY node ./

# Build stage is complete, now create the final runtime stage
FROM node:18.17.0-alpine

# Install Python, pip, ffmpeg, and other necessary tools
RUN apk add --no-cache python3 py3-pip curl jq bash ffmpeg

# Install cronie and dos2unix
RUN apk add --no-cache cronie dos2unix

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

# Add crontab file in the cron directory
COPY crontab /etc/crontabs/root

# Ensure cron logs to stdout
RUN ln -sf /usr/src/app/cron_logs/cron.log /var/log/cron.log

# Grant execution rights on the scripts
RUN chmod +x /usr/src/app/scripts/*.sh /usr/src/app/scripts/*.py

# Convert scripts to Unix format
RUN dos2unix /usr/src/app/scripts/*.sh

# Set permissions for cron log
RUN touch /var/log/cron.log && chmod 777 /var/log/cron.log

# Command to run both Node.js app and cron
CMD ["sh", "-c", "printenv > /etc/environment && crond && node /usr/src/app/node/app.js"]
