/** Helpers for route handlers. */
export function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function readJson<T>(request: Request, maxBytes = 1 << 20): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new Error(`Request body larger than ${maxBytes} bytes`);
  const text = await request.text();
  if (text.length > maxBytes) throw new Error(`Request body larger than ${maxBytes} bytes`);
  return JSON.parse(text) as T;
}
