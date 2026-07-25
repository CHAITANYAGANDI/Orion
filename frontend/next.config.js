/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  eslint: {
    // Do not fail the production build on lint errors (demo-friendly).
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
