const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const dbFilePath = path.join(__dirname, 'db', 'media.db');

async function initializeDatabase() {
    const db = await open({ filename: dbFilePath, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS movies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            file_names TEXT,
            lengths TEXT,
            dimensions TEXT,
            urls TEXT,
            metadata_url TEXT,
            directory_hash TEXT
        );
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tv_shows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            metadata TEXT,
            urls TEXT,
            directory_hash TEXT
        );
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS missing_data_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            last_attempt TIMESTAMP
        );
    `);
    return db;
}

async function insertOrUpdateTVShow(db, showName, metadata, urls) {
    const existingShow = await db.get('SELECT * FROM tv_shows WHERE name = ?', [showName]);
    if (existingShow) {
      await db.run('UPDATE tv_shows SET metadata = ?, urls = ? WHERE name = ?', [JSON.stringify(metadata), JSON.stringify(urls), showName]);
    } else {
      await db.run('INSERT INTO tv_shows (name, metadata, urls) VALUES (?, ?, ?)', [showName, JSON.stringify(metadata), JSON.stringify(urls)]);
    }
}

async function insertOrUpdateMovie(db, name, fileNames, lengths, dimensions, urls, metadata_url, hash) {
  const movie = {
    name,
    file_names: JSON.stringify(fileNames),
    lengths: JSON.stringify(lengths),
    dimensions: JSON.stringify(dimensions),
    urls: JSON.stringify(urls),
    hash
  };

  const existingMovie = await db.get('SELECT * FROM movies WHERE name = ?', [name]);
  if (existingMovie) {
    if (existingMovie.directory_hash !== hash) {
      await db.run('UPDATE movies SET file_names = ?, lengths = ?, dimensions = ?, urls = ?, metadata_url = ?, directory_hash = ? WHERE name = ?', [
        movie.file_names,
        movie.lengths,
        movie.dimensions,
        movie.urls,
        metadata_url,
        hash,
        name
      ]);
    }
  } else {
    await db.run('INSERT INTO movies (file_names, lengths, dimensions, urls, metadata_url, directory_hash, name) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      movie.file_names,
      movie.lengths,
      movie.dimensions,
      movie.urls,
      metadata_url,
      hash,
      name
    ]);
  }
}

async function insertOrUpdateMissingDataMedia(db, name) {
  const now = new Date().toISOString();
  try {
      await db.run('INSERT INTO missing_data_media (name, last_attempt) VALUES (?, ?)', [name, now]);
  } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT') {
          // If the entry already exists, update the last_attempt timestamp
          await db.run('UPDATE missing_data_media SET last_attempt = ? WHERE name = ?', [now, name]);
      } else {
          throw error; // Re-throw the error if it's not a unique constraint error
      }
  }
}

async function getTVShows(db) {
  const shows = await db.all('SELECT * FROM tv_shows');
  return shows.map(show => ({
    id: show.id,
    name: show.name,
    metadata: JSON.parse(show.metadata),
    urls: JSON.parse(show.urls)
  }));
}

async function getMovies(db) {
    const movies = await db.all('SELECT * FROM movies');
    return movies.map(movie => ({
        id: movie.id,
        name: movie.name,
        fileNames: JSON.parse(movie.file_names),
        lengths: JSON.parse(movie.lengths),
        dimensions: JSON.parse(movie.dimensions),
        urls: JSON.parse(movie.urls),
        metadataUrl: movie.metadata_url,
        directory_hash: movie.directory_hash
    }));
}

async function getMissingDataMedia(db) {
  const media = await db.all('SELECT * FROM missing_data_media');
  return media.map(item => ({
      id: item.id,
      name: item.name,
      lastAttempt: item.last_attempt
  }));
}

async function getMovieById(db, id) {
  const movie = await db.get('SELECT * FROM movies WHERE id = ?', [id]);
  if (movie) {
      return {
          id: movie.id,
          name: movie.name,
          fileNames: JSON.parse(movie.file_names),
          lengths: JSON.parse(movie.lengths),
          dimensions: JSON.parse(movie.dimensions),
          urls: JSON.parse(movie.urls),
          metadataUrl: movie.metadata_url,
          directory_hash: movie.directory_hash
      };
  }
  return null;
}

async function getMovieByName(db, name) {
  const movie = await db.get('SELECT * FROM movies WHERE name = ?', [name]);
  if (movie) {
      return {
          id: movie.id,
          name: movie.name,
          fileNames: JSON.parse(movie.file_names),
          lengths: JSON.parse(movie.lengths),
          dimensions: JSON.parse(movie.dimensions),
          urls: JSON.parse(movie.urls),
          metadataUrl: movie.metadata_url,
          directory_hash: movie.directory_hash
      };
  }
  return null;
}

async function getTVShowById(db, id) {
  const show = await db.get('SELECT * FROM tv_shows WHERE id = ?', [id]);
  if (show) {
      return {
          id: show.id,
          name: show.name,
          metadata: JSON.parse(show.metadata),
          urls: JSON.parse(show.urls),
          directory_hash: show.directory_hash
      };
  }
  return null;
}

async function getTVShowByName(db, name) {
  const show = await db.get('SELECT * FROM tv_shows WHERE name = ?', [name]);
  if (show) {
      return {
          id: show.id,
          name: show.name,
          metadata: JSON.parse(show.metadata),
          urls: JSON.parse(show.urls),
          directory_hash: show.directory_hash
      };
  }
  return null;
}

async function isDatabaseEmpty(db, tableName = 'movies') {
    const row = await db.get(`SELECT COUNT(*) as count FROM ${tableName}`);
    return row.count === 0;
}

async function deleteMovie(db, name) {
  await db.run('DELETE FROM movies WHERE name = ?', [name]);
}

async function deleteTVShow(db, name) {
  await db.run('DELETE FROM tv_shows WHERE name = ?', [name]);
}

module.exports = {
    initializeDatabase,
    insertOrUpdateTVShow,
    insertOrUpdateMovie,
    insertOrUpdateMissingDataMedia,
    getMovies,
    getTVShows,
    getMissingDataMedia,
    getMovieById,
    getMovieByName,
    getTVShowById,
    getTVShowByName,
    isDatabaseEmpty,
    deleteMovie,
    deleteTVShow
};
