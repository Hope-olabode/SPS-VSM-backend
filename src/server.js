import app from "./app.js";
import { startMaintenanceTimer } from "./utils/maintenance.js";

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`VMS API running on http://localhost:${port}`));
startMaintenanceTimer();
