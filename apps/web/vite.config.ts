import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build target pinned to a conservative "modern evergreen" baseline so the
// emitted bundle never trips over a newer-than-expected syntax in Safari.
// Covers: Safari 14+ (iOS 14+), Chrome 90+, Edge 90+, Firefox 90+. All four
// support native ESM, optional chaining, nullish coalescing, BigInt, dynamic
// import, and the Unicode property escapes (\p{M}/u) used in the highlight
// helper. Anything fancier is down-levelled by esbuild.
export default defineConfig({
  plugins: [react()],
  build: {
    // Vite 8 drives the production transform/minify target from build.target
    // (the separate esbuild.target option was removed), so this one setting now
    // covers what the two used to.
    target: ['es2020', 'safari14', 'chrome90', 'firefox90', 'edge90']
  }
});
