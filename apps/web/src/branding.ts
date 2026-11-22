/**
 * The product's visible identity, in one place: the auth screens, the header,
 * `<title>`, the meta description and the favicon all read it (the last three
 * through the `brandingHtml` plugin in `vite.config.ts`). The images live in
 * `public/brand/` and are served from the Web origin, so `img-src 'self'`
 * allows them.
 */
export interface Branding {
  name: string;
  /** Full logo (symbol + wordmark), shown large on the public screens. */
  logoUrl: string | null;
  /** The symbol alone, next to the name in the app header. */
  markUrl: string | null;
  /** Browser tab icon. */
  faviconUrl: string;
  description: string;
}

export const BRANDING: Branding = {
  name: 'Veritest',
  logoUrl: '/brand/logo.png',
  markUrl: '/brand/mark.png',
  faviconUrl: '/brand/favicon.png',
  description: 'QA management for software teams',
};
