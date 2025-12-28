export function jsonResponse(body, status = 200) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(status, message) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  const body = typeof message === "string" ? { error: message } : message;
  return new Response(JSON.stringify(body), { status, headers });
}
