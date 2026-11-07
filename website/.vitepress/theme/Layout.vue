<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import { useData } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Theme layout wrapper: injects a chapter reading progress bar (2px brand color at the top) into the default Layout.
 * Rendered on chapter pages only (both locales); not on the home page or list pages.
 */
const { Layout } = DefaultTheme;
const { page } = useData();
const isChapterPage = computed(() => /^(en\/)?chapters\//.test(page.value.relativePath));
const progress = ref(0);

let ticking = false;
const update = () => {
  ticking = false;
  const el = document.documentElement;
  const max = el.scrollHeight - el.clientHeight;
  progress.value = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
};
const onScroll = () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(update);
  }
};

onMounted(() => {
  window.addEventListener("scroll", onScroll, { passive: true });
  update();
});
onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));
</script>

<template>
  <Layout>
    <template #layout-top>
      <div
        v-if="isChapterPage"
        class="read-progress"
        :style="{ transform: `scaleX(${progress})` }"
        aria-hidden="true"
      />
    </template>
  </Layout>
</template>
