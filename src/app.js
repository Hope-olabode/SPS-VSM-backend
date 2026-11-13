import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.js";
import visitorRoutes from "./routes/visitors.js";
import tenantRoutes from "./routes/tenants.js";
import watchlistRoutes from "./routes/watchlist.js";
import auditRoutes from "./routes/audit.js";
import userRoutes from "./routes/users.js";
import locationRoutes from "./routes/locations.js";
import preRegistrationRoutes from "./routes/pre-registrations.js";
import eventRoutes from "./routes/events.js";
import publicEventRoutes from "./routes/public-events.js";
import documentRoutes from "./routes/documents.js";
import analyticsRoutes from "./routes/analytics.js";
import reportRoutes from "./routes/reports.js";
import smsRoutes from "./routes/sms.js";
import settingsRoutes from "./routes/settings.js";
import kioskRoutes from "./routes/kiosk.js";
import notificationRoutes from "./routes/notifications.js";
import jobRoutes from "./routes/jobs.js";
import oldRecordRoutes from "./routes/old-records.js";

const app = express();
// Behind the Next.js proxy (or a load balancer) req.ip would be the proxy's address. TRUST_PROXY is how many proxies to trust (default 1, the Next.js rewrite);
// the public registration limit counts per req.ip. Use 0 when the API is exposed directly.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

app.use(helmet());
// credentials: true lets the browser send the login cookie to this API
app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: "3mb" })); // check-in sends the photo and signature as data URLs (capped at 1 MB + 300 KB each in visitors.js)
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/visitors", visitorRoutes);
app.use("/api/tenants", tenantRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/notifications", notificationRoutes); // the bell and desktop notifications: one per audit event (see utils/notifications.js)
app.use("/api/users", userRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/pre-registrations", preRegistrationRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/public", publicEventRoutes); // no login: the registration link's secret is the key (see routes/public-events.js)
app.use("/api/documents", documentRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/kiosk", kioskRoutes); // token-authenticated, no login (see middleware/kiosk-auth.js)
app.use("/api/old-records", oldRecordRoutes); // global admins: records moved out by data retention
app.use("/api/jobs", jobRoutes); // CRON_SECRET-authenticated, no login (see routes/jobs.js)

// Express 5 passes errors from async routes to this handler automatically
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Something went wrong on the server." });
});

export default app;
