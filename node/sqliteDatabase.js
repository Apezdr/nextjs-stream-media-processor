const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const dbFilePath = path.join(__dirname, 'media.db');

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
            metadata_url TEXT
        );
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tv_shows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            metadata TEXT,
            urls TEXT
        );
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS missing_data_movies (
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

async function insertOrUpdateMovie(db, name, fileNames, lengths, dimensions, urls, metadataUrl) {
    const movie = {
      name,
      file_names: JSON.stringify(fileNames),
      lengths: JSON.stringify(lengths),
      dimensions: JSON.stringify(dimensions),
      urls: JSON.stringify(urls),
      metadata_url: metadataUrl
    };
  
    const existingMovie = await db.get('SELECT * FROM movies WHERE name = ?', [name]);
    if (existingMovie) {
      await db.run('UPDATE movies SET file_names = ?, lengths = ?, dimensions = ?, urls = ?, metadata_url = ? WHERE name = ?', [
        movie.file_names,
        movie.lengths,
        movie.dimensions,
        movie.urls,
        movie.metadata_url,
        name
      ]);
    } else {
      await db.run('INSERT INTO movies (name, file_names, lengths, dimensions, urls, metadata_url) VALUES (?, ?, ?, ?, ?, ?)', [
        name,
        movie.file_names,
        movie.lengths,
        movie.dimensions,
        movie.urls,
        movie.metadata_url
      ]);
    }
}

async function insertOrUpdateMissingDataMovie(db, name) {
  const now = new Date().toISOString();
  try {
      await db.run('INSERT INTO missing_data_movies (name, last_attempt) VALUES (?, ?)', [name, now]);
  } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT') {
          // If the entry already exists, update the last_attempt timestamp
          await db.run('UPDATE missing_data_movies SET last_attempt = ? WHERE name = ?', [now, name]);
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
        metadataUrl: movie.metadata_url
    }));
}

async function getMissingDataMovies(db) {
    const movies = await db.all('SELECT * FROM missing_data_movies');
    return movies.map(movie => ({
        id: movie.id,
        name: movie.name,
        lastAttempt: movie.last_attempt
    }));
}

async function isDatabaseEmpty(db, tableName = 'movies') {
    const row = await db.get(`SELECT COUNT(*) as count FROM ${tableName}`);
    return row.count === 0;
}

module.exports = {
    initializeDatabase,
    insertOrUpdateTVShow,
    insertOrUpdateMovie,
    insertOrUpdateMissingDataMovie,
    getMovies,
    getTVShows,
    getMissingDataMovies,
    isDatabaseEmpty
};
