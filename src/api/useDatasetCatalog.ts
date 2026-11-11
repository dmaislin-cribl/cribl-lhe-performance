/**
 * The workspace's dataset catalog, as a React hook, so the workbench and the
 * Test searches page classify and group datasets from the same read.
 *
 * Failure is not an error worth a banner: the classification it feeds is
 * advisory, and a run is filed from its job record whatever the catalog says.
 * So a failed or pending read is `null`, and callers treat every search as
 * unclassified until it arrives.
 */

import { useEffect, useState } from 'react';
import { apiUrl } from './cribl';
import { buildCatalog, type DatasetCatalog } from './federated';

export function useDatasetCatalog(searchGroup: string): DatasetCatalog | null {
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiUrl().replace(/\/$/, '')}/m/${encodeURIComponent(searchGroup)}/search/datasets`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { items?: unknown } | null) => setCatalog(body ? buildCatalog(body.items) : null))
      .catch(() => {
        if (!controller.signal.aborted) setCatalog(null);
      });
    return () => controller.abort();
  }, [searchGroup]);
  return catalog;
}
