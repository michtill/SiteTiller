// Pure protocol driver: before commit failures throw; after commit results are durable/pending.
export async function publisherTransaction(record: any, ops: any) {
  if (record.completed) return { state: 'published', ok: true, commit: record.commit, release: record.release };
  if (!record.committed) {
    const already = await ops.probeCommitted(record);
    if (already) record.committed = true;
    else {
      await ops.prepare(record);
      await ops.persist(record);
      try {
        await ops.commit(record);
      } catch (error) {
        if (!(await ops.probeCommitted(record))) throw error;
      }
      record.committed = true;
    }
  }
  try {
    await ops.persist(record);
    const release = await ops.finish(record);
    record.release = release;
    record.completed = true;
    await ops.persist(record);
    return { state: 'published', ok: true, commit: record.commit, release };
  } catch (error: any) {
    return {
      state: 'pending',
      ok: true,
      commit: record.commit,
      committed: true,
      pending: true,
      errorCode: error.code || error.name,
    };
  }
}
