import { useData } from "vitepress";
import { computed } from "vue";
import { en } from "../i18n/en";
import { zh, type SiteCopy } from "../i18n/zh";

const copyByLocale: Record<string, SiteCopy> = { root: zh, en };

/**
 * Locale-aware UI copy and link prefix for theme components.
 * `prefix` is "" for the root (zh) locale and "en/" for English; use it as `withBase("/" + prefix + "chapters/…")`.
 */
export function useSiteCopy() {
  const { localeIndex } = useData();
  const copy = computed(() => copyByLocale[localeIndex.value] ?? zh);
  const prefix = computed(() => (localeIndex.value === "root" ? "" : `${localeIndex.value}/`));
  return { copy, prefix };
}
