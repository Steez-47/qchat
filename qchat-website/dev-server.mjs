// Zero-dependency local preview: serves public/ and runs the api/ handlers the way Vercel does.
// `npm run dev`, then open http://localhost:3000. (`vercel dev` works too if you use the CLI.)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 3000;
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const rewrites = { "/download": "/api/download" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = rewrites[url.pathname] ?? url.pathname;
  try {
    if (path.startsWith("/api/")) {
      const mod = await import(pathToFileURL(join(root, `${normalize(path).replace(/^[/\\]+/, "")}.js`)));
      return await mod.default(req, res);
    }
    const file = join(root, "public", normalize(path === "/" ? "/index.html" : path));
    if (!file.startsWith(join(root, "public"))) throw new Error("outside public");
    const data = await readFile(extname(file) ? file : `${file}.html`);
    res.writeHead(200, { "content-type": types[extname(file) || ".html"] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, () => console.log(`QChat site on http://localhost:${port}`));
