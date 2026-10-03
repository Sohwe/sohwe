const { createReadStream, realpathSync } = require("node:fs");
const { realpath, stat } = require("node:fs/promises");
const { createServer } = require("node:http");
const { extname, isAbsolute, join, relative, resolve, sep } = require("node:path");

const root = realpathSync(resolve(SOHWE_STATIC_ROOT));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

function insideRoot(path) {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function findFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const requested = resolve(root, `.${decoded}`);
  if (!insideRoot(requested)) return null;
  for (const candidate of [requested, `${requested}.html`, join(requested, "index.html")]) {
    try {
      const actual = await realpath(candidate);
      if (!insideRoot(actual)) continue;
      const info = await stat(actual);
      if (info.isFile()) return { path: actual, size: info.size };
    } catch {
      // Try the next static-export route shape.
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const found = await findFile(pathname);
    const file = found ?? await findFile("/404.html");
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(found ? 200 : 404, {
      "Content-Type": types[extname(file.path).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": file.size,
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    console.error("Static file request failed", error);
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy();
  }
});

server.listen(SOHWE_STATIC_PORT, "0.0.0.0", () => {
  console.log(`Sohwe static site serving ${root} on port ${SOHWE_STATIC_PORT}`);
});
