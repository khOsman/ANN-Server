import "dotenv/config";
import { setDefaultResultOrder } from "node:dns";
import cors from "cors";
import express from "express";
import selectionCommitteeRouter from "./routes/selectionCommittee.js";

// Render's network has no outbound IPv6 route. Node 18+ defaults DNS lookups
// to return whichever address family the OS resolver returns first, which
// can be IPv6 even when only IPv4 is reachable (e.g. smtp.gmail.com). This
// forces IPv4 results first for every outbound connection in this process.
setDefaultResultOrder("ipv4first");

const app = express();

const allowedOrigins = (process.env.FRONTEND_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/selection-committee", selectionCommitteeRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`ann-mis-server listening on port ${port}`);
});
