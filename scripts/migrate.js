// Tiny migration runner.
//   npm run migrate                      apply every pending migration
//   npm run migrate:status               show what has / hasn't been applied
//   npm run migrate:rollback             undo the most recent migration (uses its .down.sql)
//   npm run migrate:make -- add_x_to_y   create the next numbered pair of files
//
// Files live in /migrations as  NNN_name.up.sql  and  NNN_name.down.sql.
// Applied migrations are recorded in the `schema_migrations` table.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const DIR = new URL("../migrations/", import.meta.url);
const command = process.argv[2] ?? "up";

async function listMigrations() {
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".up.sql")).sort();
  return files.map((f) => f.replace(/\.up\.sql$/, ""));
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

if (command === "make") {
  const name = process.argv[3]?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!name) {
    console.error("Give the migration a name:  npm run migrate:make -- add_notes_to_visits");
    process.exit(1);
  }
  const existing = await listMigrations();
  const next = String((Number(existing.at(-1)?.slice(0, 3)) || 0) + 1).padStart(3, "0");
  await writeFile(new URL(`${next}_${name}.up.sql`, DIR), "-- write the change here\n");
  await writeFile(new URL(`${next}_${name}.down.sql`, DIR), "-- write how to undo it here\n");
  console.log(`Created migrations/${next}_${name}.up.sql and .down.sql`);
  process.exit(0);
}

const dbName = process.env.DB_NAME;
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true,
});

try {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`);
  await conn.query(`USE \`${dbName}\``);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(190) PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  // stop two people / two servers running migrations at the same time
  const [[lock]] = await conn.query("SELECT GET_LOCK('vms_migrations', 10) AS ok");
  if (!lock.ok) throw new Error("Another migration is running. Try again in a moment.");

  const all = await listMigrations();
  const [rows] = await conn.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  if (command === "status") {
    for (const name of all) console.log(`${applied.has(name) ? "applied " : "PENDING "} ${name}`);
    for (const name of applied.keys()) if (!all.includes(name)) console.log(`MISSING  ${name} (applied, but the file is gone)`);
  } else if (command === "up") {
    let count = 0;
    for (const name of all) {
      const sql = await readFile(new URL(`${name}.up.sql`, DIR), "utf8");
      if (applied.has(name)) {
        if (applied.get(name) !== sha(sql)) {
          throw new Error(`${name} was changed after it was applied. Never edit an applied migration; make a new one instead.`);
        }
        continue;
      }
      console.log(`Applying ${name} ...`);
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)", [name, sha(sql)]);
      count++;
    }
    console.log(count ? `Done. Applied ${count} migration(s).` : "Nothing to apply. Database is up to date.");
  } else if (command === "rollback") {
    const last = [...applied.keys()].sort().at(-1);
    if (!last) {
      console.log("Nothing to roll back.");
    } else {
      console.log(`Rolling back ${last} ...`);
      await conn.query(await readFile(new URL(`${last}.down.sql`, DIR), "utf8"));
      await conn.query("DELETE FROM schema_migrations WHERE name = ?", [last]);
      console.log("Done.");
    }
  } else {
    throw new Error(`Unknown command "${command}". Use: up, status, rollback, make`);
  }

  await conn.query("SELECT RELEASE_LOCK('vms_migrations')");
} catch (err) {
  console.error(`\nMigration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await conn.end();
}
