import { fileURLToPath } from 'node:url';
import { compile } from '@vue/compiler-dom';
import { templatePlugin } from '../../packages/ui/vite-template.mjs';
// Templates are compiled at build time, so the page loads only the Vue runtime. Output: apps/aistudio/dist.
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
export default {
  root: here('./ui'),
  base: './',
  publicDir: here('./ui/public'),
  build: { outDir: here('./dist'), emptyOutDir: true },
  resolve: { alias: { vue: 'vue/dist/vue.runtime.esm-bundler.js' } },
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  plugins: [templatePlugin(/\/(apps\/aistudio\/ui|packages\/ui)\/[\w-]+\.ts$/, compile)],
};
