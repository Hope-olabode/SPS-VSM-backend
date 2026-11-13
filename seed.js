// Creates Main Lobby and the first admin:  npm run seed
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { one, pool, query } from "./src/db.js";

let lobby = await one("SELECT id FROM locations WHERE name = 'Main Lobby'");
if (!lobby) {
  lobby = { id: randomUUID() };
  await query("INSERT INTO locations (id, name, is_primary) VALUES (?, 'Main Lobby', 1)", [lobby.id]);
}

if (!(await one("SELECT id FROM users WHERE email = 'admin@example.com'"))) {
  // change this password after your first login
  const hash = await bcrypt.hash("ChangeMe123!", 12);
  await query("INSERT INTO users (id, name, email, password_hash, role, location_id) VALUES (?, 'Admin', 'admin@example.com', ?, 'GLOBAL_ADMIN', ?)", [randomUUID(), hash, lobby.id]);
}

// resident companies (edit this list to match your building)
const tenants = [
  ["The Square Serviced Offices", "Ground Floor"],
  ["Ultimum Limited", "2nd Floor"],
  ["Tetra Pak West Africa", "3rd Floor"],
  ["Beiersdorf (NIVEA)", "4th Floor"],
];
for (const [name, floor] of tenants) {
  if (!(await one("SELECT id FROM tenants WHERE name = ? AND location_id = ?", [name, lobby.id]))) {
    await query("INSERT INTO tenants (id, location_id, name, floor) VALUES (?, ?, ?, ?)", [randomUUID(), lobby.id, name, floor]);
  }
}

console.log("Seeded: Main Lobby + 4 resident companies + + admin@example.com / ChangeMe123!");
await pool.end();
