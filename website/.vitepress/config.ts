/**
 * VitePress config for the learn-pi-agent docs site.
 * SEO essentials: stable URLs, unique descriptions, OG tags, JSON-LD, sitemap, chapter-map sidebar.
 * Locales: Chinese at the root (unchanged URLs), English at /en/. UI copy lives in ./i18n/{zh,en}.ts.
 *
 * Publishing: GitHub Actions builds and deploys to GitHub Pages.
 */
import { defineConfig, type DefaultTheme, type HeadConfig } from "vitepress";
import { en } from "./i18n/en";
import { zh, type SiteCopy } from "./i18n/zh";

/** GitHub Pages project-site path (repo name learn-pi-agent; adjust when moving to a custom domain or changing deployment). */
const BASE = "/learn-pi-agent/";
/** Actual GitHub Pages URL (keep in sync with sitemap.hostname). */
const SITE_URL = "https://yiz-hhh.github.io/learn-pi-agent/";

/**
 * Chinese sidebar. scripts/check-docs.mjs regex-reads these literal entries,
 * so they stay spelled out here; the English sidebar is derived from them.
 */
const zhSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "Part I · Agent Core",
    collapsed: false,
    items: [
      { text: "00 · Minimal LLM Call", link: "/chapters/00-minimal-llm-call" },
      { text: "01 · Tool-driven Agent", link: "/chapters/01-tool-driven-agent" },
      { text: "02 · Agent Runtime", link: "/chapters/02-agent-runtime" },
      { text: "03 · Tool Runtime", link: "/chapters/03-tool-runtime" },
      { text: "04 · Parallel Tool Execution", link: "/chapters/04-parallel-tools" },
      { text: "05 · Steering & Follow-up", link: "/chapters/05-steering-followup" },
      { text: "06 · Context Transformation", link: "/chapters/06-context-transform" },
    ],
  },
  {
    text: "Part II · Agent Harness",
    collapsed: false,
    items: [
      { text: "07 · Session Tree", link: "/chapters/07-session-tree" },
      { text: "08 · Context Compaction", link: "/chapters/08-context-compaction" },
      { text: "09 · Skills", link: "/chapters/09-skills" },
    ],
  },
  {
    text: "Part III · Extensibility",
    collapsed: false,
    items: [
      { text: "10 · Extension Runtime", link: "/chapters/10-extension-runtime" },
      { text: "11 · Extension Composition", link: "/chapters/11-extension-composition" },
    ],
  },
  {
    text: "Part IV · Product",
    collapsed: false,
    items: [{ text: "12 · Coding Agent", link: "/chapters/12-coding-agent" }],
  },
];

/** English sidebar: same (already English) titles, links prefixed with /en. */
const enSidebar: DefaultTheme.SidebarItem[] = zhSidebar.map((group) => ({
  ...group,
  items: group.items?.map((item) => ({ ...item, link: `/en${item.link}` })),
}));

/** Per-locale head: OG/keywords/JSON-LD text comes from the locale copy. */
function localeHead(copy: SiteCopy, pageUrl: string, ogImage: string): HeadConfig[] {
  return [
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "learn-pi-agent" }],
    ["meta", { property: "og:url", content: pageUrl }],
    ["meta", { name: "twitter:card", content: "summary" }],
    ["meta", { property: "og:title", content: copy.meta.ogTitle }],
    ["meta", { property: "og:description", content: copy.meta.ogDescription }],
    ["meta", { property: "og:locale", content: copy.meta.ogLocale }],
    ["meta", { name: "keywords", content: copy.meta.keywords }],
    ["meta", { property: "og:image", content: `${SITE_URL}${ogImage}` }],
    ["link", { rel: "icon", href: "/learn-pi-agent/favicon.svg", type: "image/svg+xml" }],
    ["script", { type: "application/ld+json" }, JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "learn-pi-agent",
      url: pageUrl,
      description: copy.meta.jsonLdDescription,
    })],
  ];
}

/** Per-locale theme labels and navigation. */
function localeThemeConfig(
  copy: SiteCopy,
  chaptersPath: string,
  githubUrl: string,
  sidebar: DefaultTheme.SidebarItem[],
): DefaultTheme.Config {
  return {
    outline: { label: copy.theme.outlineLabel, level: [2, 3] },
    docFooter: { prev: copy.theme.docFooterPrev, next: copy.theme.docFooterNext },
    lastUpdated: { text: copy.theme.lastUpdatedText, formatOptions: { dateStyle: "short", timeStyle: "short" } },
    darkModeSwitchLabel: copy.theme.darkModeSwitchLabel,
    sidebarMenuLabel: copy.theme.sidebarMenuLabel,
    returnToTopLabel: copy.theme.returnToTopLabel,
    langMenuLabel: copy.theme.langMenuLabel,
    nav: [
      { text: copy.theme.navChapters, link: `${chaptersPath}00-minimal-llm-call`, activeMatch: chaptersPath },
      { text: "GitHub", link: githubUrl },
    ],
    sidebar,
  };
}

export default defineConfig({
  title: "Learn Pi Agent",
  description: zh.description,
  lang: zh.lang,
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  markdown: {
    // Code block background is dark in both themes (--vp-code-block-bg);
    // the default dual-theme Shiki would apply light tokens in light mode (dark text on dark background, unreadable).
    theme: "github-dark",
  },
  sitemap: {
    // Actual GitHub Pages URL (adjust when deployment changes)
    hostname: SITE_URL,
  },
  locales: {
    root: {
      label: zh.label,
      lang: zh.lang,
      title: "Learn Pi Agent",
      description: zh.description,
      head: localeHead(zh, SITE_URL, "og-cover.svg"),
      themeConfig: localeThemeConfig(zh, "/chapters/", "https://github.com/yiz-hhh/learn-pi-agent", zhSidebar),
    },
    en: {
      label: en.label,
      lang: en.lang,
      link: "/en/",
      title: "Learn Pi Agent",
      description: en.description,
      head: localeHead(en, `${SITE_URL}en/`, "og-cover-en.svg"),
      themeConfig: localeThemeConfig(en, "/en/chapters/", "https://github.com/ivankozlovcodes/learn-pi-agent", enSidebar),
    },
  },
  themeConfig: {
    search: {
      provider: "local",
      options: {
        locales: {
          root: { translations: zh.search },
          en: { translations: en.search },
        },
      },
    },
    footer: {
      message: "MIT License · yiz-hhh",
    },
  },
});
