require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function loadSqlFiles() {
  const files = await fs.promises.readdir(MIGRATIONS_DIR);
  return files
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      path: path.join(MIGRATIONS_DIR, name),
    }));
}

async function runMigration() {
  const dbHost = process.env.DB_HOST || "localhost";
  const dbPort = Number(process.env.DB_PORT || 3306);
  const dbUser = process.env.DB_USER || process.env.DB_USERNAME || "root";
  const dbPassword = process.env.DB_PASSWORD || process.env.DB_PASS || "";
  const dbName = process.env.DB_NAME || process.env.DB_DATABASE || "payments";

  if (!dbName) {
    throw new Error("DB_NAME is required in environment variables.");
  }

  const migrationFiles = await loadSqlFiles();
  if (migrationFiles.length === 0) {
    console.log("No SQL migration files found in migrations/.");
    return;
  }

  console.log("Running migrations against:", {
    host: dbHost,
    port: dbPort,
    user: dbUser,
    database: dbName,
  });

  const connection = await mysql.createConnection({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    multipleStatements: true,
  });

  try {
    for (const file of migrationFiles) {
      console.log(`\n==> Executing migration: ${file.name}`);
      const sql = await fs.promises.readFile(file.path, "utf8");
      if (!sql.trim()) {
        console.log(`Skipping empty file ${file.name}`);
        continue;
      }
      await connection.query(sql);
      console.log(`✅ ${file.name} applied successfully.`);
    }
    console.log("All migrations executed.");
  } finally {
    await connection.end();
  }
}

runMigration().catch((error) => {
  console.error("Migration failed:", error.message || error);
  process.exit(1);
});
