require("dotenv").config({ quiet: true });
const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

const mode = process.argv[2];
const isMigrations = mode === "migrations";
const isSeeders = mode === "seeders";

if (!isMigrations && !isSeeders) {
  console.error("Usage: node scripts/run-sql-batch.js <migrations|seeders>");
  process.exit(1);
}

if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
  console.error("Missing DB env vars. Required: DB_HOST, DB_USER, DB_NAME.");
  process.exit(1);
}

const dbName = process.env.DB_NAME;
const escapedDbName = `\`${dbName.replace(/`/g, "``")}\``;
const metaTable = isMigrations ? "schema_migrations" : "schema_seeders";
const metaColumn = isMigrations ? "migration_name" : "seeder_name";
const baseDir = path.join(__dirname, "..", "db", mode);

async function ensureMetaTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${metaTable} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ${metaColumn} VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    multipleStatements: true
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${escapedDbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    await connection.changeUser({ database: dbName });

    await ensureMetaTable(connection);

    const [executedRows] = await connection.query(
      `SELECT ${metaColumn} AS name FROM ${metaTable};`
    );
    const executed = new Set(executedRows.map((row) => row.name));

    const allFiles = (await fs.readdir(baseDir))
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    if (allFiles.length === 0) {
      console.log(`No ${mode} found in ${baseDir}`);
      return;
    }

    let ran = 0;
    for (const fileName of allFiles) {
      if (executed.has(fileName)) {
        console.log(`skip ${fileName}`);
        continue;
      }

      const fullPath = path.join(baseDir, fileName);
      const sql = await fs.readFile(fullPath, "utf8");

      if (!sql.trim()) {
        console.log(`skip empty ${fileName}`);
        continue;
      }

      await connection.query(sql);
      await connection.query(
        `INSERT INTO ${metaTable} (${metaColumn}) VALUES (?);`,
        [fileName]
      );
      ran += 1;
      console.log(`run ${fileName}`);
    }

    console.log(`Done. Executed ${ran} new ${mode}.`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
