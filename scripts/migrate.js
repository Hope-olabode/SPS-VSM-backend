
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const DIR = new URL("../migrations/", import.meta.url);
const command = process.argv[2] ?? "up";

async function listMigrations() {
  const files = (await readdir(DIR))
    .filter((file) => file.endsWith(".up.sql"))
    .sort();

  return files.map((file) => file.replace(/\.up\.sql$/, ""));
}

const sha = (content) =>
  createHash("sha256").update(content).digest("hex");

// Create a migration file pair.
if (command === "make") {
  const name = process.argv[3]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  if (!name) {
    console.error(
      "Usage: npm run migrate:make -- add_notes_to_visits"
    );
    process.exit(1);
  }

  const existing = await listMigrations();

  const next = String(
    (Number(existing.at(-1)?.slice(0, 3)) || 0) + 1
  ).padStart(3, "0");

  await writeFile(
    new URL(`${next}_${name}.up.sql`, DIR),
    "-- Write the migration here\n"
  );

  await writeFile(
    new URL(`${next}_${name}.down.sql`, DIR),
    "-- Write the rollback here\n"
  );

  console.log(`Created migration ${next}_${name}`);
  process.exit(0);
}

// Validate environment variables.
const required = [
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
];

const missing = required.filter(
  (key) => !process.env[key]
);

if (missing.length) {
  console.error(
    `Missing environment variables: ${missing.join(", ")}`
  );
  process.exit(1);
}

const dbName = process.env.DB_NAME;

// Connect to the EXISTING Enzonic database.
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: dbName,

  // Enzonic requires TLS.
  ssl: {
    rejectUnauthorized: true,
  },

  multipleStatements: true,
});

let lockAcquired = false;

try {
  // Confirm which database we connected to.
  const [[database]] = await conn.query(
    "SELECT DATABASE() AS name"
  );

  if (database.name !== dbName) {
    throw new Error(
      `Connected to unexpected database: ${database.name}`
    );
  }

  console.log(`Connected to database: ${database.name}`);

  // Create migration tracking table if it does not exist.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Prevent simultaneous migration processes.
  const [[lock]] = await conn.query(
    "SELECT GET_LOCK('vms_migrations', 10) AS ok"
  );

  if (Number(lock.ok) !== 1) {
    throw new Error(
      "Another migration is running. Try again shortly."
    );
  }

  lockAcquired = true;

  const all = await listMigrations();

  const [rows] = await conn.query(
    "SELECT name, checksum FROM schema_migrations ORDER BY name"
  );

  const applied = new Map(
    rows.map((row) => [row.name, row.checksum])
  );

  // Show migration status.
  if (command === "status") {
    for (const name of all) {
      console.log(
        `${applied.has(name) ? "APPLIED " : "PENDING "} ${name}`
      );
    }

    for (const name of applied.keys()) {
      if (!all.includes(name)) {
        console.log(`MISSING ${name}`);
      }
    }
  }

  // Apply pending migrations.
  else if (command === "up") {
    let count = 0;

    for (const name of all) {
      const sql = await readFile(
        new URL(`${name}.up.sql`, DIR),
        "utf8"
      );

      if (applied.has(name)) {
        if (applied.get(name) !== sha(sql)) {
          throw new Error(
            `${name} has changed since it was applied. Create a new migration instead.`
          );
        }

        continue;
      }

      console.log(`Applying ${name} ...`);

      await conn.query(sql);

      await conn.query(
        `INSERT INTO schema_migrations (name, checksum)
         VALUES (?, ?)`,
        [name, sha(sql)]
      );

      count++;
    }

    console.log(
      count
        ? `Successfully applied ${count} migration(s).`
        : "Nothing to apply. Database is up to date."
    );
  }

  // Roll back the most recent migration.
  else if (command === "rollback") {
    const last = [...applied.keys()].sort().at(-1);

    if (!last) {
      console.log("Nothing to roll back.");
    } else {
      console.log(`Rolling back ${last} ...`);

      const sql = await readFile(
        new URL(`${last}.down.sql`, DIR),
        "utf8"
      );

      await conn.query(sql);

      await conn.query(
        "DELETE FROM schema_migrations WHERE name = ?",
        [last]
      );

      console.log("Rollback completed.");
    }
  }

  else {
    throw new Error(
      `Unknown command "${command}". Use: up, status, rollback, make`
    );
  }

} catch (error) {
  console.error(`\nMigration failed: ${error.message}`);
  process.exitCode = 1;

} finally {
  if (lockAcquired) {
    try {
      await conn.query(
        "SELECT RELEASE_LOCK('vms_migrations')"
      );
    } catch (error) {
      console.error(
        "Warning: Could not release migration lock:",
        error.message
      );
    }
  }

  await conn.end();
}
