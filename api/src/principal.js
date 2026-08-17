/**
 * SWA Easy Auth principal from request headers. No secrets.
 * https://learn.microsoft.com/azure/static-web-apps/user-information
 */

function claimMap(principal) {
  const claims = {};
  (principal.claims || []).forEach((c) => {
    if (!c || c.typ == null) return;
    claims[c.typ] = c.val;
    const short = String(c.typ).split("/").pop();
    if (short && claims[short] == null) claims[short] = c.val;
  });
  return claims;
}

function decodePrincipalHeader(header) {
  if (!header) return null;
  try {
    const json = Buffer.from(String(header), "base64").toString("utf8");
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function principalFromRequest(request) {
  const headers = request.headers;
  const get = (name) => {
    if (!headers) return "";
    if (typeof headers.get === "function") return headers.get(name) || "";
    return headers[name] || headers[name.toLowerCase()] || "";
  };
  const raw = get("x-ms-client-principal");
  const decoded = decodePrincipalHeader(raw);
  if (!decoded) return null;
  const claims = claimMap(decoded);
  const entraId = String(
    decoded.userId || claims.oid || claims.objectidentifier || claims.sub || ""
  ).trim();
  const email = String(
    decoded.userDetails || claims.preferred_username || claims.email || claims.upn || ""
  ).trim();
  const displayName = String(claims.name || email || entraId || "").trim();
  if (!entraId && !email) return null;
  return {
    entraId: entraId || email.toLowerCase(),
    email,
    displayName,
    identityProvider: decoded.identityProvider || "aad"
  };
}

function docIdFor(principal) {
  const raw = String(principal.entraId || principal.email || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, "-")
    .slice(0, 120);
  return raw || null;
}

module.exports = { principalFromRequest, docIdFor };
