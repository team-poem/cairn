import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";

const directory = fileURLToPath(new URL(".", import.meta.url));
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mjs": "text/plain",
};
export const variants = ["original", "changed", "broken"];

// The same API contract is used by the local recording server and deployed demo.
// Orders are synthetic and ephemeral: no payment, account, or external service exists.
export function orderResponse(body, variant) {
  if (
    body?.product !== "field-notebook" ||
    body?.quantity !== 1 ||
    typeof body?.name !== "string" ||
    !body.name.trim() ||
    typeof body?.email !== "string" ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)
  ) {
    return {
      status: 400,
      body: { error: "One notebook, a name, and an email are required." },
    };
  }
  if (variant === "broken")
    return { status: 500, body: { error: "Order service unavailable." } };
  return {
    status: 200,
    body: {
      orderId: "DEMO-1042",
      product: body.product,
      quantity: 1,
      total: 18,
    },
  };
}

export async function startServer({
  port = 4319,
  host = "127.0.0.1",
  variant = "original",
  artifacts = resolve(directory, ".artifacts"),
} = {}) {
  if (!variants.includes(variant)) throw new Error("Unknown demo variant");
  const orders = [];
  const server = createServer(async (req, res) => {
    const send = (status, value, type = "application/json") => {
      res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(type === "application/json" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/config")
        return send(200, { variant });
      if (req.method === "POST" && url.pathname === "/api/order") {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8192) return send(413, { error: "Request too large" });
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return send(400, { error: "Invalid JSON" });
        }
        const requestedVariant = req.headers["x-demo-variant"];
        const result = orderResponse(
          body,
          variants.includes(requestedVariant) ? requestedVariant : variant,
        );
        orders.push({ status: result.status, product: body?.product });
        return send(result.status, result.body);
      }
      if (req.method !== "GET")
        return send(405, { error: "Method not allowed" });
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      const recording = url.pathname.startsWith("/recording/");
      const root = recording ? artifacts : resolve(directory, "public");
      let name = decodeURIComponent(
        recording
          ? url.pathname.slice("/recording/".length)
          : url.pathname.slice(1),
      );
      if (name === "") name = "index.html";
      if (name === "shop" || (name.startsWith("shop/") && !extname(name)))
        name = "shop/index.html";
      if (url.pathname === "/source/record.mjs")
        return send(
          200,
          await readFile(resolve(directory, "record.mjs")),
          "text/plain",
        );
      const path = resolve(root, name);
      if (!path.startsWith(root + sep))
        return send(403, { error: "Forbidden" });
      const content = await readFile(path);
      return send(
        200,
        content,
        types[extname(path)] ?? "application/octet-stream",
      );
    } catch (error) {
      if (error.code === "ENOENT") return send(404, { error: "Not found" });
      send(500, { error: "Demo server error" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({
      variant,
      orders: [...orders],
      completed: orders.some((order) => order.status === 200),
    }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await startServer({
    port: Number(process.env.PORT ?? 4319),
    host: process.env.HOST ?? "127.0.0.1",
    variant: process.env.DEMO_VARIANT ?? "original",
    artifacts: resolve(directory, process.env.DEMO_OUTPUT ?? ".artifacts"),
  });
  console.log(`cairn demo: ${server.origin}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
}
