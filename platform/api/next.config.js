/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['typeorm', 'pg', 'mongoose'],
  },
}

module.exports = nextConfig
