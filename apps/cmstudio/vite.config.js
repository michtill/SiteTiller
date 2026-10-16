import { defineConfig } from 'vite';
import { compile } from '@vue/compiler-dom';
import { templatePlugin } from '../../packages/ui/vite-template.mjs';
// Shared components in packages/ui import 'vue'; dedupe resolves it from this app's toolchain.
// Relative asset paths: the same build works at / and behind the Shell at /content/.
export default defineConfig({
  base: './',
  resolve: { dedupe: ['vue'] },
  // The Formatted content editor (Tiptap + Markdown) is one lazily loaded chunk of about 550 kB.
  build: { chunkSizeWarningLimit: 600 },
  plugins: [
    templatePlugin(/\/(apps\/cmstudio\/editor\/(main|architect|markdown-editor)|packages\/ui\/[\w-]+)\.ts$/, compile),
  ],
});
