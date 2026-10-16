// The published website must read frozen release content, never the working CMS root.
delete process.env.SITETILLER_CMS_ROOT;
await import('../aistudio/src/local-production-server.ts');
