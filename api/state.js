// Shared state store for the Talavera outstanding-works status board.
// The mutable overlay (status + status-update notes, keyed by item id) lives
// as a JSON file committed to this repo, so every visitor reads/writes the
// same source of truth via the GitHub Contents API.

const OWNER = process.env.GITHUB_OWNER || "liliksugiyono100";
const REPO = process.env.GITHUB_REPO || "coba1";
const BRANCH = process.env.GITHUB_BRANCH || "claude/online-status-board-yslcal";
const FILE_PATH = process.env.GITHUB_DATA_PATH || "data/board-state.json";
const API_URL = "https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + FILE_PATH;

function ghHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "talavera-status-board",
  };
}

async function readState(token) {
  const r = await fetch(API_URL + "?ref=" + encodeURIComponent(BRANCH), { headers: ghHeaders(token) });
  if (r.status === 404) return { overrides: {}, sha: null };
  if (!r.ok) {
    const err = new Error("github_read_failed:" + r.status);
    err.status = r.status;
    throw err;
  }
  const json = await r.json();
  let overrides = {};
  try {
    overrides = JSON.parse(Buffer.from(json.content, "base64").toString("utf-8"));
  } catch (e) {
    overrides = {};
  }
  return { overrides, sha: json.sha };
}

async function writeState(token, overrides, sha, message) {
  const body = {
    message: message,
    content: Buffer.from(JSON.stringify(overrides, null, 1), "utf-8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch(API_URL, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders(token)),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error("github_write_failed:" + r.status + ":" + text);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e.status === 409 || e.status === 422) continue; // sha race, retry once
      throw e;
    }
  }
  throw lastErr;
}

module.exports = async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(503).json({
      error: "server_not_configured",
      message: "GITHUB_TOKEN belum diatur di Vercel Environment Variables. Papan berjalan dalam mode baca-saja sampai token ditambahkan.",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const { overrides } = await readState(token);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ overrides: overrides, syncedAt: new Date().toISOString() });
      return;
    }

    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
      const id = body.id;
      const status = body.status;
      const statusupdate = body.statusupdate;
      const pic = body.pic;
      const actor = body.actor;
      if (!id || typeof id !== "string") {
        res.status(400).json({ error: "bad_request", message: "id wajib diisi." });
        return;
      }
      if (status !== undefined && status !== "Open" && status !== "Close") {
        res.status(400).json({ error: "bad_request", message: "status harus Open atau Close." });
        return;
      }
      if (statusupdate !== undefined && typeof statusupdate !== "string") {
        res.status(400).json({ error: "bad_request", message: "statusupdate harus berupa teks." });
        return;
      }
      if (pic !== undefined && typeof pic !== "string") {
        res.status(400).json({ error: "bad_request", message: "pic harus berupa teks." });
        return;
      }

      const result = await withRetry(async function () {
        const { overrides, sha } = await readState(token);
        const patch = Object.assign({}, overrides[id]);
        if (status !== undefined) patch.status = status;
        if (statusupdate !== undefined) patch.statusupdate = statusupdate;
        if (pic !== undefined) patch.pic = pic.slice(0, 60);
        patch.updatedAt = new Date().toISOString();
        if (actor && typeof actor === "string") patch.actor = actor.slice(0, 60);
        overrides[id] = patch;
        await writeState(token, overrides, sha, "Update " + id + (status !== undefined ? " -> " + status : ""));
        return overrides;
      });

      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true, overrides: result });
      return;
    }

    if (req.method === "DELETE") {
      const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
      const result = await withRetry(async function () {
        const { overrides, sha } = await readState(token);
        let next = overrides;
        if (body.all) {
          next = {};
        } else if (body.id) {
          next = Object.assign({}, overrides);
          delete next[body.id];
        } else {
          const err = new Error("bad_request");
          err.status = 400;
          throw err;
        }
        await writeState(token, next, sha, body.all ? "Reset semua status ke data asli" : "Reset " + body.id + " ke data asli");
        return next;
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true, overrides: result });
      return;
    }

    res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    res.status(502).json({ error: "github_error", message: String((e && e.message) || e) });
  }
};
