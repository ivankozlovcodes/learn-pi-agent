/**
 * Chinese (root locale) UI copy: config labels, local search strings, head/meta text and component text.
 * en.ts has the same shape; keep both files in sync.
 */
export const zh = {
  label: "简体中文",
  lang: "zh-CN",
  description: "从一次最小的 LLM 调用开始，逐步实现 Pi Agent 的核心机制。",
  meta: {
    ogTitle: "learn-pi-agent：Pi Agent 架构中文教程",
    ogDescription: "从最小 LLM Loop 开始，用 TypeScript 和离线测试逐步重建 Pi Agent 的 Core、Harness、Extension 与 Coding Agent",
    ogLocale: "zh_CN",
    keywords: "Pi Agent, LLM Agent 教程, Agent Loop, Tool Calling, TypeScript, Session Tree, Context Compaction, Extension Runtime, Coding Agent, 中文教程",
    jsonLdDescription: "从最小 LLM 调用开始，逐步重建 Pi Agent Harness。",
  },
  theme: {
    navChapters: "章节",
    outlineLabel: "本章目录",
    docFooterPrev: "上一章",
    docFooterNext: "下一章",
    lastUpdatedText: "最后更新",
    darkModeSwitchLabel: "外观",
    sidebarMenuLabel: "菜单",
    returnToTopLabel: "回到顶部",
    langMenuLabel: "切换语言",
  },
  search: {
    button: { buttonText: "搜索", buttonAriaLabel: "搜索" },
    modal: {
      displayDetails: "显示详细列表",
      resetButtonTitle: "重置搜索",
      backButtonTitle: "关闭搜索",
      noResultsText: "没有找到相关结果",
      footer: {
        selectText: "选择",
        selectKeyAriaLabel: "回车",
        navigateText: "切换",
        navigateUpKeyAriaLabel: "上箭头",
        navigateDownKeyAriaLabel: "下箭头",
        closeText: "关闭",
        closeKeyAriaLabel: "Esc",
      },
    },
  },
  home: {
    leadLine1: "从一次 LLM 调用开始，",
    leadLine2: "逐步重建 Pi 的 Agent Harness。",
    cta: "开始阅读",
    codeAriaLabel: "Agent loop 示例",
  },
  orbit: {
    navAriaLabel: "核心机制直达章节",
  },
};

export type SiteCopy = typeof zh;
