import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

/**
 * Frontend variant of the shared warehouse-systems layout: no DDD pack, no API
 * reference (the web app has no bounded-context model or API of its own).
 */
const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Overview',
      collapsed: false,
      link: {type: 'doc', id: 'overview/introduction'},
      items: ['overview/architecture', 'overview/quickstart', 'overview/offline-and-idempotency', 'overview/receiving-flow', 'overview/station-flow'],
    },
    {
      type: 'category',
      label: 'Operations',
      items: ['operations/configuration', 'operations/runbook', 'operations/troubleshooting'],
    },
    {
      type: 'category',
      label: 'Development',
      items: ['development/testing'],
    },
    {
      type: 'category',
      label: 'Ecosystem',
      items: ['ecosystem/integration', 'ecosystem/api-contract'],
    },
  ],
};

export default sidebars;
