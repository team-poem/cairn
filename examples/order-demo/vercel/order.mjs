import { orderResponse, variants } from "../server.mjs";

// Reuse the recording fixture's contract; hosted orders remain synthetic and ephemeral.
export async function POST(request) {
  const text = await request.text();
  if (Buffer.byteLength(text) > 8192)
    return Response.json({ error: "Request too large" }, { status: 413 });
  let body;
  try { body = JSON.parse(text); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const selected = request.headers.get("x-demo-variant");
  const result = orderResponse(body, variants.includes(selected) ? selected : "original");
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
