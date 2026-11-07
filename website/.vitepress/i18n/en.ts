/** English (/en/ locale) UI copy. Same shape as zh.ts. */
import type { SiteCopy } from "./zh";

export const en: SiteCopy = {
  label: "English",
  lang: "en-US",
  description: "Start from a minimal LLM call and implement the core mechanisms of Pi Agent step by step.",
  meta: {
    ogTitle: "learn-pi-agent: a Pi Agent architecture tutorial",
    ogDescription: "Starting from a minimal LLM Loop, rebuild the Core, Harness, Extension and Coding Agent of Pi Agent step by step with TypeScript and offline tests",
    ogLocale: "en_US",
    keywords: "Pi Agent, LLM Agent tutorial, Agent Loop, Tool Calling, TypeScript, Session Tree, Context Compaction, Extension Runtime, Coding Agent",
    jsonLdDescription: "Start from a minimal LLM call and rebuild the Pi Agent Harness step by step.",
  },
  theme: {
    navChapters: "Chapters",
    outlineLabel: "On this page",
    docFooterPrev: "Previous chapter",
    docFooterNext: "Next chapter",
    lastUpdatedText: "Last updated",
    darkModeSwitchLabel: "Appearance",
    sidebarMenuLabel: "Menu",
    returnToTopLabel: "Return to top",
    langMenuLabel: "Change language",
  },
  search: {
    button: { buttonText: "Search", buttonAriaLabel: "Search" },
    modal: {
      displayDetails: "Display detailed list",
      resetButtonTitle: "Reset search",
      backButtonTitle: "Close search",
      noResultsText: "No results for",
      footer: {
        selectText: "to select",
        selectKeyAriaLabel: "enter",
        navigateText: "to navigate",
        navigateUpKeyAriaLabel: "up arrow",
        navigateDownKeyAriaLabel: "down arrow",
        closeText: "to close",
        closeKeyAriaLabel: "escape",
      },
    },
  },
  home: {
    leadLine1: "Start from a single LLM call,",
    leadLine2: "and rebuild the Agent Harness of Pi step by step.",
    cta: "Start reading",
    codeAriaLabel: "Agent loop example",
  },
  orbit: {
    navAriaLabel: "Jump to core mechanism chapters",
  },
};
