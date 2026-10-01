export function GET() {
  return Response.json({ variant: "original" }, { headers: { "Cache-Control": "no-store" } });
}
