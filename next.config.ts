import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The container image runs `node server.js` from this folder, with no node_modules install.
  output: 'standalone',
  // client-node loads files and native sockets at run time; bundling it breaks those paths.
  serverExternalPackages: ['@kubernetes/client-node'],
  // netatlas serves no optimized images, so the image optimizer never loads sharp.
  images: { unoptimized: true },
  // next build still copies sharp and its native libraries (@img, about 18 MB) into .next/standalone,
  // through the trace of next-server itself. Next.js applies an exclude to that trace when its key
  // matches `next-server` (build/collect-build-traces.js), and the image is cross-built, so a native
  // library built for the build machine would be wrong in it anyway.
  outputFileTracingExcludes: { 'next-server': ['**/node_modules/sharp/**/*', '**/node_modules/@img/**/*'] },
  poweredByHeader: false,
  // The editor takes a token that may write, so no other site may frame the page, the browser never
  // guesses a type, and no address leaves in a Referer. React escapes all text and nothing sets HTML, so
  // these are defence in depth; a script policy would need nonces. The headers and the `/:path*` form,
  // which matches `/` too, are from Next's headers page (node_modules/next/dist/docs/01-app/
  // 03-api-reference/05-config/01-next-config-js/headers.md, "X-Content-Type-Options" and "Referrer-Policy").
  headers: () => [
    {
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    },
  ],
};

export default nextConfig;
