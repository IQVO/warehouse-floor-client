import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import type * as OpenApiPlugin from 'docusaurus-plugin-openapi-docs';

const config: Config = {
  title: 'Warehouse Floor Client',
  tagline:
    'Warehouse Floor Client: the Experience web application of warehouse-systems.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
    faster: true,
  },

  url: 'https://iqvo.github.io',
  baseUrl: '/warehouse-floor-client/',

  organizationName: 'IQVO',
  projectName: 'warehouse-floor-client',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  markdown: {
    mermaid: true,
    // ADR bodies are immutable and were written before this site existed: parse
    // them as CommonMark (a stray `<name>` or `{x}` is not MDX there) and do not
    // fail the build on their links to files outside the docs tree. Every other
    // page is MDX and a broken link in it still throws.
    parseFrontMatter: async (params) => {
      const isAdr = /[\\/]docs[\\/]adr[\\/]/.test(params.filePath);
      let result;
      try {
        result = await params.defaultParseFrontMatter(params);
      } catch (e) {
        if (!isAdr) {
          throw e;
        }
        // An ADR whose front matter is not valid YAML (an unquoted colon in the
        // title): keep it readable, with the id taken from the file name.
        result = {frontMatter: {}, content: params.fileContent};
      }
      if (isAdr) {
        result.frontMatter.mdx = {...(result.frontMatter.mdx as object), format: 'md'};
      }
      return result;
    },
    hooks: {
      onBrokenMarkdownLinks: ({sourceFilePath, url}) => {
        if (/[\\/]docs[\\/]adr[\\/]/.test(sourceFilePath)) {
          return;
        }
        throw new Error(`Broken markdown link in ${sourceFilePath}: ${url}`);
      },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/IQVO/warehouse-floor-client/tree/main/docs/docs/',
          
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
  ],

  themes: ['docusaurus-theme-openapi-docs', '@docusaurus/theme-mermaid'],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Warehouse Floor Client',
      logo: {
        alt: 'Warehouse Floor Client',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          href: 'https://github.com/IQVO/warehouse-floor-client',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {label: 'Introduction', to: '/docs/overview/introduction'},
            {label: 'Quickstart', to: '/docs/overview/quickstart'},
            {label: 'Testing', to: '/docs/development/testing'},
          ],
        },
        {
          title: 'Source',
          items: [
            {label: 'GitHub repository', href: 'https://github.com/IQVO/warehouse-floor-client'},
          ],
        },
      ],
      copyright: `Warehouse Floor Client — a warehouse-systems application. Built ${new Date().getFullYear()}.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'go', 'json', 'yaml', 'sql'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
