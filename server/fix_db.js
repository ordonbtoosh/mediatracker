import duckdb from "duckdb";

const db = new duckdb.Database("./mediatracker.duckdb");

db.run(`
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    title TEXT,
    category TEXT,
    rating DOUBLE,
    year TEXT,
    genre TEXT,
    description TEXT,
    myRank DOUBLE,
    posterPath TEXT,
    bannerPath TEXT
  );
`);

console.log("✅ Media table checked/created successfully!");
