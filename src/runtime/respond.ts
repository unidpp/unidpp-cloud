export function asOfStamp(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "x-as-of": asOfStamp(),
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}
