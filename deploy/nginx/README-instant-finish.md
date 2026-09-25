# Instant Finish media cache rule

The `/media/` location carries a short-lived viewer grant in the query string (`?t=`). That URL must not be cached at the edge and must not be written to access logs.

## Nginx

`deploy/nginx/cap-media-location.conf` already sets:

- `access_log off` so `$request` / `$args` cannot record the bearer
- `Referrer-Policy: no-referrer` on every media response
- `proxy_cache off`, `proxy_no_cache`, `proxy_cache_bypass`
- `Cache-Control: private, no-store`

Do not add a `proxy_cache` zone for this location. Do not log `$request` or `$args` if access logging is re-enabled; use a `log_format` that omits both.

## Cloudflare (operator action, not applied by this change)

Add a cache rule for the `cap.styrir.com` zone before the owner flag is enabled:

- Match: hostname equals `cap.styrir.com` AND URI Path starts with `/media/`
- Cache eligibility: Bypass cache
- Browser TTL: respect origin (origin sends `private, no-store`)

Apply the same bypass to GET, HEAD, and Range requests. Do not enable Cloudflare Cache Reserve, Tiered Cache, or a custom Cache Key that includes the query string for `/media/*`. A captured `?t=` remains replayable until expiry or an epoch bump, so an edge hit would serve another viewer's media.

Confirm after the rule exists, from outside this host, that media GET/HEAD/Range responses include `CF-Cache-Status: BYPASS` or `DYNAMIC` and never `HIT`. This repository change does not call the Cloudflare API.
