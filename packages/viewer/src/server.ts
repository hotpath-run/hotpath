import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkflow } from "@hotpathrun/compiler";

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(here, "..");

export interface ViewerOptions {
  port?: number;
  /** open the page in the default browser (default true) */
  open?: boolean;
}

export interface Viewer {
  url: string;
  close: () => Promise<void>;
}

/**
 * The viewer built to static files, as an installed hotpath ships it
 * (dist/hotpath.mjs next to viewer/). A checkout has none: it runs Vite.
 */
export function builtViewerDir(from: string = here): string | null {
  const dir = path.resolve(from, "../viewer");
  return existsSync(path.join(dir, "index.html")) &&
    existsSync(path.join(dir, "assets"))
    ? dir
    : null;
}

// `hotpath view <task>`: a local page + /api/workflow serving the compiled
// workflow (re-read on every request so a recompile shows up on refresh).
export async function startViewer(
  task: string,
  options: ViewerOptions = {},
): Promise<Viewer> {
  await loadWorkflow(task); // fail fast, with the "run hotpath compile" hint
  const built = builtViewerDir();
  const viewer = built
    ? await startStaticViewer(built, () => loadWorkflow(task), options.port)
    : await startDevViewer(task, options.port);
  if (options.open !== false) openBrowser(viewer.url);
  return viewer;
}

async function startDevViewer(task: string, port = 5173): Promise<Viewer> {
  const { createServer } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;

  const server = await createServer({
    root: viewerRoot,
    configFile: false,
    logLevel: "warn",
    plugins: [
      react(),
      {
        name: "hotpath-workflow-api",
        configureServer(s) {
          s.middlewares.use("/api/workflow", (_req, res) => {
            loadWorkflow(task).then(
              (workflow) => {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(workflow));
              },
              (err: unknown) => {
                res.statusCode = 500;
                res.end(err instanceof Error ? err.message : String(err));
              },
            );
          });
        },
      },
    ],
    server: { port, host: "127.0.0.1" },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return { url: `http://127.0.0.1:${actual}/`, close: () => server.close() };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/**
 * Serves a built viewer folder and /api/workflow on 127.0.0.1 only. Requests
 * are confined to `dir`: a path that leaves it gets a 404.
 */
export async function startStaticViewer(
  dir: string,
  workflow: () => Promise<unknown>,
  port = 5173,
): Promise<Viewer> {
  const root = path.resolve(dir);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/workflow") {
      workflow().then(
        (value) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(value));
        },
        (err: unknown) => {
          res.statusCode = 500;
          res.end(err instanceof Error ? err.message : String(err));
        },
      );
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      res.statusCode = 400;
      res.end("bad request");
      return;
    }
    const file = path.resolve(
      root,
      relative === "/" ? "index.html" : `.${relative}`,
    );
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    readFile(file).then(
      (body) => {
        res.setHeader(
          "content-type",
          CONTENT_TYPES[path.extname(file).toLowerCase()] ??
            "application/octet-stream",
        );
        res.end(body);
      },
      () => {
        res.statusCode = 404;
        res.end("not found");
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

// Best effort (the URL is printed anyway). An argv, never a shell string.
function openBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined); // no browser available
  child.unref();
}
