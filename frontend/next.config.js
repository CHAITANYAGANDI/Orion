/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,

  /**
   * Stop announcing what this is built with.
   *
   * Next sets `X-Powered-By: Next.js` on every response by default. It tells an
   * attacker which framework's advisories to go and read, and it does nothing
   * for anybody else.
   */
  poweredByHeader: false,
  eslint: {
    // Do not fail the production build on lint errors (demo-friendly).
    ignoreDuringBuilds: true,
  },

  /**
   * Folders used to live at /projects.
   *
   * The app calls them folders everywhere a person can read, and the URL was
   * the last place still saying project — so /projects/prj_1 is now
   * /folder/prj_1 and the list is /folders. These keep every link that was made
   * before that working: a bookmark, a tab left open since yesterday, a path
   * pasted into a chat.
   *
   * `permanent: false` on purpose. A 308 is cached by the browser more or less
   * forever, and a wrong one is remembered long after the config is fixed.
   * There is nothing depending on the SEO value of a permanent redirect here —
   * this is an app behind a login — so the recoverable one is the right trade.
   *
   * The API is untouched: /api/v1/projects is still the resource, and nothing
   * below rewrites it, because these run on the frontend's own routes only.
   */
  /**
   * Security headers.
   *
   * The app was serving none. The backend has Spring Security's defaults --
   * nosniff, X-Frame-Options: DENY -- but every one of these responses is a
   * page in somebody's browser, and the browser only enforces what it is told.
   *
   * No Content-Security-Policy here, deliberately. A CSP tight enough to be
   * worth having has to enumerate what Clerk loads and what Next injects, and
   * one written without measuring first is either so loose it changes nothing
   * or so tight it breaks sign-in in a way that only shows up in production.
   * It is worth doing properly, with report-only first, and it is not worth
   * guessing at during a rename. `frame-ancestors` is the exception: it has no
   * such coupling, so it is set below alongside X-Frame-Options.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            /*
             * Tell the browser never to come back over http. Render already
             * redirects, but a redirect is one round trip on a network where
             * somebody may be listening; HSTS removes the trip entirely.
             *
             * No `preload`. That submits the domain to a list baked into every
             * browser, and getting off it takes months -- a commitment worth
             * making deliberately, not as a side effect of a config edit.
             */
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            // Stop the browser second-guessing a Content-Type. Matters most on
            // anything user-supplied that gets served back.
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            // Clickjacking. Nothing here is meant to be embedded, and an app
            // that can be framed can be framed invisibly over a decoy.
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            // The modern spelling of the line above, for browsers that prefer
            // it. Both, because the old one is still what some proxies read.
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'",
          },
          {
            // Send the origin to other sites, never the path. Meeting URLs
            // carry ids, and a full Referer hands them to whatever a user
            // clicks through to.
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            /*
             * Microphone is `self` because recording is the product. Everything
             * else is denied outright -- this app has no reason to reach a
             * camera or a location, and saying so means an injected script
             * cannot either.
             */
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), interest-cohort=(), microphone=(self)",
          },
        ],
      },
    ];
  },

  async redirects() {
    return [
      { source: "/projects", destination: "/folders", permanent: false },
      { source: "/projects/:id", destination: "/folder/:id", permanent: false },
    ];
  },
};

module.exports = nextConfig;
