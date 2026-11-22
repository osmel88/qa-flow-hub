/**
 * The product's visible identity, in one place. The name is a working title
 * until a brand is chosen: replacing it, or the logo file under
 * `public/brand/`, changes every screen that shows the brand.
 */
export const BRANDING = {
  name: 'qa-flow-hub',
  /** Served from the Web origin, so the `img-src 'self'` policy allows it. */
  logoUrl: '/brand/logo.svg',
  /** Browser tab icon; `index.html` gets it at build time from `vite.config.ts`. */
  faviconUrl: '/brand/logo.svg',
  description: 'QA management for software teams',
} as const;
