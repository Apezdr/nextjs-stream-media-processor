#!/bin/bash
set -e

# Variables for versions
ZENLIB_VERSION=0.4.41
MEDIAINFOLIB_VERSION=23.07
MEDIAINFO_VERSION=23.07

# Build and install ZenLib
cd /tmp
wget https://mediaarea.net/download/source/libzen/${ZENLIB_VERSION}/libzen_${ZENLIB_VERSION}.tar.gz
tar -xzf libzen_${ZENLIB_VERSION}.tar.gz
cd ZenLib/Project/GNU/Library
./autogen.sh
./configure --prefix=/usr
make
make install

# Build and install MediaInfoLib
cd /tmp
wget https://mediaarea.net/download/source/libmediainfo/${MEDIAINFOLIB_VERSION}/libmediainfo_${MEDIAINFOLIB_VERSION}.tar.gz
tar -xzf libmediainfo_${MEDIAINFOLIB_VERSION}.tar.gz
cd MediaInfoLib/Project/GNU/Library
./autogen.sh
./configure --prefix=/usr
make
make install

# Build and install MediaInfo CLI
cd /tmp
wget https://mediaarea.net/download/source/mediainfo/${MEDIAINFO_VERSION}/mediainfo_${MEDIAINFO_VERSION}.tar.gz
tar -xzf mediainfo_${MEDIAINFO_VERSION}.tar.gz
cd MediaInfo/Project/GNU/CLI
./autogen.sh
./configure --prefix=/usr
make
make install

# Clean up
rm -rf /tmp/*
