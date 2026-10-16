export async function editorFieldCatalog(fetcher = fetch) {
  const origin = process.env.SITETILLER_CMS_URL || 'http://127.0.0.1:4310';
  try {
    const response = await fetcher(origin + '/api/field-catalog', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error('HTTP ' + response.status);
    const catalog = await response.json();
    if (
      !catalog ||
      catalog.version !== 1 ||
      !Array.isArray(catalog.types) ||
      !catalog.types.length ||
      catalog.types.some((type) => !type || typeof type.type !== 'string' || typeof type.label !== 'string') ||
      new Set(catalog.types.map((type) => type.type)).size !== catalog.types.length ||
      !catalog.aliases ||
      typeof catalog.aliases !== 'object' ||
      Array.isArray(catalog.aliases) ||
      Object.values(catalog.aliases).some((type) => typeof type !== 'string') ||
      ['commonProperties', 'collectionRules', 'limits'].some((key) => catalog[key] === undefined)
    )
      throw Error('Neplatný kontrakt katalogu.');
    return {
      version: catalog.version,
      types: catalog.types,
      aliases: catalog.aliases,
      commonProperties: catalog.commonProperties,
      collectionRules: catalog.collectionRules,
      limits: catalog.limits,
    };
  } catch (error: any) {
    throw Object.assign(
      Error(
        'Katalog typů polí Editoru obsahu není dostupný nebo platný. Zopakujte požadavek po obnovení spojení s Editorem.',
      ),
      { status: 502, cause: error },
    );
  }
}
