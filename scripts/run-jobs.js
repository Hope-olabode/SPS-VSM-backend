import { pool } from "../src/db.js";
import { runMaintenance } from "../src/utils/maintenance.js";

// npm run jobs: runs the maintenance job once and prints what it did (handy for testing, or for a server cron entry)
try {
  // npm run jobs -- --dry-run  only reports what data retention would move and anonymise, and changes nothing
console.log(JSON.stringify(await runMaintenance({ dryRun: process.argv.includes("--dry-run") }), null, 2));
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
