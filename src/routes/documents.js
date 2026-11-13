import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";

const router = Router();
router.use(requireAuth); // everyone signed in can read the list (check-in needs the active ones)

// Documents are shared by every location, so only admins may change them.
const canManage = requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN");

const fail = (res, status, error) => res.status(status).json({ ok: false, error });

// the labels the Documents page shows <-> what the database stores
const TYPE_TO_DB = { NDA: "NDA", "Safety Briefing": "SAFETY_BRIEFING", "Wi-Fi Policy": "WIFI_POLICY", Other: "OTHER" };
const TYPE_FROM_DB = Object.fromEntries(Object.entries(TYPE_TO_DB).map(([label, value]) => [value, label]));

const toApi = (row) => ({
  id: row.id,
  title: row.title,
  type: TYPE_FROM_DB[row.type],
  content: row.content,
  requireSignature: Boolean(row.require_signature),
  active: Boolean(row.active),
  createdAt: row.created_at,
});

/** GET /api/documents — newest first */
router.get("/", async (_req, res) => {
  const rows = await query("SELECT * FROM documents ORDER BY created_at DESC");
  res.json({ ok: true, items: rows.map(toApi) });
});

const Create = z.object({
  title: z.string().trim().min(1, "Enter a document title").max(160),
  type: z.enum(Object.keys(TYPE_TO_DB)).default("NDA"),
  content: z.string().trim().min(1, "Enter the text visitors will read").max(200000),
  requireSignature: z.boolean().default(true),
});

const firstProblem = (error) => Object.values(error.flatten().fieldErrors).flat()[0] ?? "Some details are missing or invalid.";

/** POST /api/documents — new documents start active */
router.post("/", canManage, async (req, res) => {
  const parsed = Create.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;

  const id = randomUUID();
  await query("INSERT INTO documents (id, title, type, content, require_signature, active) VALUES (?, ?, ?, ?, ?, 1)", [id, d.title, TYPE_TO_DB[d.type], d.content, d.requireSignature ? 1 : 0]);
  await audit("DOCUMENT_CREATED", "Security", req.user, { title: d.title });

  res.status(201).json({ ok: true, item: toApi(await one("SELECT * FROM documents WHERE id = ?", [id])) });
});

/** PATCH /api/documents/:id — turn a document on or off for check-in */
router.patch("/:id", canManage, async (req, res) => {
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Send { active: true } or { active: false }.");

  const row = await one("SELECT * FROM documents WHERE id = ?", [req.params.id]);
  if (!row) return fail(res, 404, "Document not found.");

  await query("UPDATE documents SET active = ? WHERE id = ?", [parsed.data.active ? 1 : 0, row.id]);
  await audit("DOCUMENT_UPDATED", "Security", req.user, { title: row.title, active: parsed.data.active });

  res.json({ ok: true, item: toApi(await one("SELECT * FROM documents WHERE id = ?", [row.id])) });
});

/** DELETE /api/documents/:id — a document visitors have already signed has to stay on record */
router.delete("/:id", canManage, async (req, res) => {
  const row = await one("SELECT id, title FROM documents WHERE id = ?", [req.params.id]);
  if (!row) return fail(res, 404, "Document not found.");

  try {
    await query("DELETE FROM documents WHERE id = ?", [row.id]);
  } catch (err) {
    if (err?.code === "ER_ROW_IS_REFERENCED_2") return fail(res, 409, "Visitors have already signed this document, so it can't be removed. Turn it off instead.");
    throw err;
  }
  await audit("DOCUMENT_REMOVED", "Security", req.user, { title: row.title });
  res.json({ ok: true });
});

export default router;
