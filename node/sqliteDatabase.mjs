import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbDirectory = join(__dirname, 'db');
const dbFilePath = join(dbDirectory, 'media.db');

var hasInitialized = false

export async function initializeDatabase() {
  // Create the db directory if it doesn't exist
  await fs.mkdir(dbDirectory, { recursive: true })
  const db = await open({ filename: dbFilePath, driver: sqlite3.Database })
  if (!hasInitialized) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS movies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            file_names TEXT,
            lengths TEXT,
            dimensions TEXT,
            urls TEXT,
            metadata_url TEXT,
            directory_hash TEXT,
            hdr TEXT,
            additional_metadata TEXT,
            _id TEXT
        );
    `)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tv_shows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            metadata TEXT,
            metadata_path TEXT,
            poster TEXT,
            posterBlurhash TEXT,
            logo TEXT,
            logoBlurhash TEXT,
            backdrop TEXT,
            backdropBlurhash TEXT,
            seasons TEXT,
            directory_hash TEXT
        );
    `)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS missing_data_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            last_attempt TEXT
        );
    `)
    await db.exec(`
      CREATE TABLE IF NOT EXISTS process_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_key TEXT UNIQUE,
        process_type TEXT,
        total_steps INTEGER,
        current_step INTEGER,
        status TEXT,
        message TEXT,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `)
    hasInitialized = true
  }
  return db
}

export async function releaseDatabase(db) {
  return await db.close()
}

export async function insertOrUpdateTVShow(
  db,
  showName,
  metadata,
  metadataPath,
  poster,
  posterBlurhash,
  logo,
  logoBlurhash,
  backdrop,
  backdropBlurhash,
  seasonsObj
) {
  const seasonsStr = JSON.stringify(seasonsObj);
  const existingShow = await db.get('SELECT * FROM tv_shows WHERE name = ?', [showName]);

  if (existingShow) {
    await db.run(
      `UPDATE tv_shows 
       SET metadata = ?, metadata_path = ?, poster = ?, posterBlurhash = ?, logo = ?, logoBlurhash = ?, backdrop = ?, backdropBlurhash = ?, seasons = ? 
       WHERE name = ?`,
      [metadata, metadataPath, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasonsStr, showName]
    );
  } else {
    await db.run(
      `INSERT INTO tv_shows (name, metadata, metadata_path, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasons) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [showName, metadata, metadataPath, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasonsStr]
    );
  }
}

export async function insertOrUpdateMovie(
  db,
  name,
  fileNames,
  lengths,
  dimensions,
  urls,
  metadata_url,
  hash,
  hdr,
  additionalMetadata,
  _id,
) {
  const movie = {
    name,
    file_names: JSON.stringify(fileNames),
    lengths: JSON.stringify(lengths),
    dimensions: JSON.stringify(dimensions),
    urls: JSON.stringify(urls),
    hash,
    hdr,
    additional_metadata: JSON.stringify(additionalMetadata),
    _id,
  }

  const existingMovie = await db.get('SELECT * FROM movies WHERE name = ?', [name])
  if (existingMovie) {
    if (existingMovie.directory_hash !== hash) {
      await db.run(
        `UPDATE movies 
         SET file_names = ?, lengths = ?, dimensions = ?, urls = ?, metadata_url = ?, directory_hash = ?, hdr = ?, additional_metadata = ?, _id = ?
         WHERE name = ?`,
        [
          movie.file_names,
          movie.lengths,
          movie.dimensions,
          movie.urls,
          metadata_url,
          hash,
          movie.hdr,
          movie.additional_metadata,
          _id,
          name
        ]
      )
    }
  } else {
    await db.run(
      `INSERT INTO movies (file_names, lengths, dimensions, urls, metadata_url, directory_hash, hdr, additional_metadata, _id, name) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        movie.file_names,
        movie.lengths,
        movie.dimensions,
        movie.urls,
        metadata_url,
        hash,
        movie.hdr,
        movie.additional_metadata,
        _id,
        name
      ]
    )
  }
}

export async function insertOrUpdateMissingDataMedia(db, name) {
  const now = new Date().toISOString()
  try {
    await db.run('INSERT INTO missing_data_media (name, last_attempt) VALUES (?, ?)', [name, now])
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      // If the entry already exists, update the last_attempt timestamp
      await db.run('UPDATE missing_data_media SET last_attempt = ? WHERE name = ?', [now, name])
    } else {
      throw error // Re-throw the error if it's not a unique constraint error
    }
  }
}

export async function getTVShows(db) {
  const shows = await db.all('SELECT * FROM tv_shows');
  return shows.map((show) => ({
    id: show.id,
    name: show.name,
    metadata: show.metadata,
    metadata_path: show.metadata_path,
    poster: show.poster,
    posterBlurhash: show.posterBlurhash,
    logo: show.logo,
    logoBlurhash: show.logoBlurhash,
    backdrop: show.backdrop,
    backdropBlurhash: show.backdropBlurhash,
    seasons: JSON.parse(show.seasons)
  }));
}

export async function getMovies(db) {
  const movies = await db.all('SELECT * FROM movies')
  return movies.map((movie) => ({
    id: movie.id,
    name: movie.name,
    fileNames: JSON.parse(movie.file_names),
    lengths: JSON.parse(movie.lengths),
    dimensions: JSON.parse(movie.dimensions),
    urls: JSON.parse(movie.urls),
    metadataUrl: movie.metadata_url,
    directory_hash: movie.directory_hash,
    hdr: movie.hdr,
    additional_metadata: JSON.parse(movie.additional_metadata),
    _id: movie._id
  }))
}

export async function getMissingDataMedia(db) {
  const media = await db.all('SELECT * FROM missing_data_media')
  return media.map((item) => ({
    id: item.id,
    name: item.name,
    lastAttempt: item.last_attempt,
  }))
}

export async function getMovieById(db, id) {
  const movie = await db.get('SELECT * FROM movies WHERE id = ?', [id])
  if (movie) {
    return {
      id: movie.id,
      name: movie.name,
      fileNames: JSON.parse(movie.file_names),
      lengths: JSON.parse(movie.lengths),
      dimensions: JSON.parse(movie.dimensions),
      urls: JSON.parse(movie.urls),
      metadataUrl: movie.metadata_url,
      directory_hash: movie.directory_hash,
      _id: movie._id,
    }
  }
  return null
}

export async function getMovieByName(db, name) {
  const movie = await db.get('SELECT * FROM movies WHERE name = ?', [name])
  if (movie) {
    return {
      id: movie.id,
      name: movie.name,
      fileNames: JSON.parse(movie.file_names),
      lengths: JSON.parse(movie.lengths),
      dimensions: JSON.parse(movie.dimensions),
      urls: JSON.parse(movie.urls),
      metadataUrl: movie.metadata_url,
      directory_hash: movie.directory_hash,
      _id: movie._id,
    }
  }
  return null
}

export async function getTVShowById(db, id) {
  const show = await db.get('SELECT * FROM tv_shows WHERE id = ?', [id]);
  if (show) {
    return {
      id: show.id,
      name: show.name,
      metadata: show.metadata,
      metadata_path: show.metadata_path,
      poster: show.poster,
      posterBlurhash: show.posterBlurhash,
      logo: show.logo,
      logoBlurhash: show.logoBlurhash,
      backdrop: show.backdrop,
      backdropBlurhash: show.backdropBlurhash,
      seasons: JSON.parse(show.seasons),
      directory_hash: show.directory_hash,
    };
  }
  return null;
}

export async function getTVShowByName(db, name) {
  const show = await db.get('SELECT * FROM tv_shows WHERE name = ?', [name]);
  if (show) {
    return {
      id: show.id,
      name: show.name,
      metadata: show.metadata,
      metadata_path: show.metadata_path,
      poster: show.poster,
      posterBlurhash: show.posterBlurhash,
      logo: show.logo,
      logoBlurhash: show.logoBlurhash,
      backdrop: show.backdrop,
      backdropBlurhash: show.backdropBlurhash,
      seasons: JSON.parse(show.seasons),
      directory_hash: show.directory_hash,
    };
  }
  return null;
}

export async function isDatabaseEmpty(db, tableName = 'movies') {
  const row = await db.get(`SELECT COUNT(*) as count FROM ${tableName}`)
  return row.count === 0
}

export async function deleteMovie(db, name) {
  await db.run('DELETE FROM movies WHERE name = ?', [name])
}

export async function deleteTVShow(db, name) {
  await db.run('DELETE FROM tv_shows WHERE name = ?', [name])
}
