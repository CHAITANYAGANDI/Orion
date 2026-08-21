/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
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
  async redirects() {
    return [
      { source: "/projects", destination: "/folders", permanent: false },
      { source: "/projects/:id", destination: "/folder/:id", permanent: false },
    ];
  },
};

module.exports = nextConfig;
