const CONFIG = {
  githubPagesOrigin:
    "https://giovannimet.github.io/kiro-community-repo",

  statePath:
    "/state/latest.json",

  metadataCacheTtl: 3600,

  stateCacheTtl: 300,

  negativeCacheTtl: 60,
};

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);

    console.log("[ENTRY]", request.method, requestUrl.pathname, requestUrl.search);

    if (!["GET", "HEAD"].includes(request.method)) {
      console.log("[ENTRY] rejected method:", request.method);
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
        },
      });
    }

    if (requestUrl.pathname.startsWith("/pool/")) {
      console.log("[ENTRY] routing to pool handler");
      return handlePoolRequest(request, requestUrl, ctx);
    }

    console.log("[ENTRY] routing to GitHub Pages proxy");
    return proxyGitHubPages(request, requestUrl, ctx);
  },
};

function buildUpstreamUrl(pathname, search) {
  const originUrl = new URL(CONFIG.githubPagesOrigin);
  const basePath = originUrl.pathname.replace(/\/$/, "");
  const fullUrl = originUrl.origin + basePath + pathname + search;
  return fullUrl;
}

async function handlePoolRequest(request, requestUrl, ctx) {
  const requestedFilename = getBasename(requestUrl.pathname);
  console.log("[POOL] requested filename:", JSON.stringify(requestedFilename));

  if (!requestedFilename || !requestedFilename.endsWith(".deb")) {
    console.log("[POOL] 404 — filename missing or not .deb");
    return new Response("Package not found", {
      status: 404,
      headers: {
        "Cache-Control": "public, max-age=60",
        "X-Kiro-Repository-Route": "pool",
      },
    });
  }

  const state = await getLatestState(ctx);

  if (!state) {
    console.log("[POOL] 502 — state unavailable (getLatestState returned null)");
    return new Response("Repository state unavailable", {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
        "X-Kiro-Repository-Route": "pool",
      },
    });
  }

  console.log("[POOL] state loaded:", JSON.stringify({
    filename: state.filename,
    url: state.url,
    version: state.version,
  }));

  if (
    typeof state.filename !== "string" ||
    typeof state.url !== "string" ||
    requestedFilename !== state.filename
  ) {
    console.log("[POOL] 404 — filename mismatch:", {
      requested: requestedFilename,
      stateFilename: state.filename,
    });
    return new Response("Package not found", {
      status: 404,
      headers: {
        "Cache-Control": "public, max-age=60",
        "X-Kiro-Repository-Route": "pool",
      },
    });
  }

  if (!isAllowedKiroUrl(state.url)) {
    console.log("[POOL] 502 — URL failed validation:", state.url);
    return new Response("Invalid upstream package URL", {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
        "X-Kiro-Repository-Route": "pool",
      },
    });
  }

  console.log("[POOL] 302 redirect to:", state.url);
  return new Response(null, {
    status: 302,
    headers: {
      Location: state.url,
      "Cache-Control": "public, max-age=300",
      "X-Kiro-Repository-Route": "official-package-redirect",
      "X-Kiro-Package-Version": String(state.version ?? "unknown"),
    },
  });
}

async function proxyGitHubPages(request, requestUrl, ctx) {
  const cache = caches.default;

  const cacheKey = new Request(requestUrl.toString(), {
    method: "GET",
  });

  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    console.log("[PROXY] cache HIT for:", requestUrl.pathname);
    return withDiagnosticHeaders(cachedResponse, {
      "X-Kiro-Repository-Cache": "HIT",
      "X-Kiro-Repository-Origin": "github-pages",
    });
  }

  const upstreamUrlStr = buildUpstreamUrl(requestUrl.pathname, requestUrl.search);
  console.log("[PROXY] cache MISS — fetching upstream:", upstreamUrlStr);

  const upstreamRequest = new Request(upstreamUrlStr, {
    method: request.method,
    headers: createUpstreamHeaders(request.headers),
    redirect: "follow",
  });

  const upstreamResponse = await fetch(upstreamRequest);

  console.log("[PROXY] upstream response status:", upstreamResponse.status, upstreamResponse.statusText);

  const response = new Response(upstreamResponse.body, upstreamResponse);

  sanitizeResponseHeaders(response.headers);

  const ttl = getCacheTtl(upstreamResponse.status);

  if (ttl > 0) {
    response.headers.set(
      "Cache-Control",
      `public, max-age=${ttl}, s-maxage=${ttl}`,
    );

    ctx.waitUntil(
      cache.put(
        cacheKey,
        response.clone(),
      ),
    );
  } else {
    response.headers.set("Cache-Control", "no-store");
  }

  return withDiagnosticHeaders(response, {
    "X-Kiro-Repository-Cache": "MISS",
    "X-Kiro-Repository-Origin": "github-pages",
  });
}

async function getLatestState(ctx) {
  const publicStateUrl = new URL(
    CONFIG.statePath,
    "https://cache-key.kiro-community.invalid",
  );

  const cache = caches.default;
  const cacheKey = new Request(publicStateUrl.toString());

  let response = await cache.match(cacheKey);

  if (response) {
    console.log("[STATE] cache HIT");
  } else {
    console.log("[STATE] cache MISS — fetching from GitHub Pages");

    const upstreamUrlStr = buildUpstreamUrl(CONFIG.statePath, "");
    console.log("[STATE] fetching:", upstreamUrlStr);

    const upstreamResponse = await fetch(upstreamUrlStr, {
      headers: {
        Accept: "application/json",
        "User-Agent": "kiro-community-worker/1.0",
      },
      redirect: "follow",
    });

    console.log("[STATE] upstream status:", upstreamResponse.status, upstreamResponse.statusText);

    if (!upstreamResponse.ok) {
      console.log("[STATE] upstream not OK — returning null");
      return null;
    }

    response = new Response(upstreamResponse.body, upstreamResponse);

    sanitizeResponseHeaders(response.headers);

    response.headers.set(
      "Cache-Control",
      `public, max-age=${CONFIG.stateCacheTtl}, s-maxage=${CONFIG.stateCacheTtl}`,
    );

    ctx.waitUntil(
      cache.put(
        cacheKey,
        response.clone(),
      ),
    );
  }

  try {
    const parsed = await response.json();
    console.log("[STATE] parsed OK:", JSON.stringify(parsed));
    return parsed;
  } catch (err) {
    console.log("[STATE] JSON parse failed:", err.message);
    return null;
  }
}

function getBasename(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 0
    ? decodeURIComponent(parts[parts.length - 1])
    : "";
}

function isAllowedKiroUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.hostname === "prod.download.desktop.kiro.dev" &&
      url.pathname.startsWith("/releases/stable/") &&
      url.pathname.endsWith(".deb")
    );
  } catch {
    return false;
  }
}

function createUpstreamHeaders(originalHeaders) {
  const headers = new Headers();

  const accept = originalHeaders.get("Accept");
  const acceptEncoding = originalHeaders.get("Accept-Encoding");
  const ifNoneMatch = originalHeaders.get("If-None-Match");
  const ifModifiedSince = originalHeaders.get("If-Modified-Since");

  if (accept) {
    headers.set("Accept", accept);
  }

  if (acceptEncoding) {
    headers.set("Accept-Encoding", acceptEncoding);
  }

  if (ifNoneMatch) {
    headers.set("If-None-Match", ifNoneMatch);
  }

  if (ifModifiedSince) {
    headers.set("If-Modified-Since", ifModifiedSince);
  }

  headers.set("User-Agent", "kiro-community-worker/1.0");

  return headers;
}

function sanitizeResponseHeaders(headers) {
  headers.delete("Set-Cookie");
  headers.delete("Content-Security-Policy");
  headers.delete("X-Frame-Options");
}

function getCacheTtl(status) {
  if (status >= 200 && status < 300) {
    return CONFIG.metadataCacheTtl;
  }

  if (status === 404) {
    return CONFIG.negativeCacheTtl;
  }

  return 0;
}

function withDiagnosticHeaders(response, diagnosticHeaders) {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(diagnosticHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
