export function viewerHeaders(viewerUrl, extra = {}) {
  return { "X-IFC-Viewer-Token": new URL(viewerUrl).hash.slice(1), ...extra };
}

// Avoid reusing a pooled connection when a test restarts the viewer on the same port.
export function httpFetch(input, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Connection", "close");
  return fetch(input, { ...options, headers });
}

export function viewerFetch(viewerUrl, pathname, options = {}) {
  const headers = new Headers(viewerHeaders(viewerUrl));
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  return httpFetch(new URL(pathname, viewerUrl), { ...options, headers });
}
