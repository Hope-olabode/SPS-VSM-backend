import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { runMaintenance } from "../utils/maintenance.js";

// Lets something outside the server (a cron service, Vercel Cron, a hosting scheduler) run the maintenance job.
// No login cookie: the caller sends  Authorization: Bearer <CRON_SECRET>  (Vercel Cron does this by itself when CRON_SECRET is set).
const router = Router();

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function run(req, res) {
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: "CRON_SECRET is not set on the server." });
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "Not allowed." });
  res.json({ ok: true, ...(await runMaintenance()) });
}

router.get("/run", run); // Vercel Cron only makes GET requests
router.post("/run", run);

export default router;
