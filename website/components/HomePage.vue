<script setup lang="ts">
import { withBase } from "vitepress";
import { onMounted, ref } from "vue";
import AgentOrbit from "./AgentOrbit.vue";
import { useSiteCopy } from "../.vitepress/theme/useSiteCopy";

const { copy, prefix } = useSiteCopy();

const codeWindow = ref<HTMLElement>();

onMounted(() => {
  // One-time subtle focus when the code window enters the viewport (skipped under reduced-motion)
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const el = codeWindow.value;
  if (!el || !("IntersectionObserver" in window)) return;

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        el.classList.add("is-focus");
        io.disconnect();
      }
    },
    { threshold: 0.55 },
  );

  io.observe(el);
});
</script>

<template>
  <main class="home-page">
    <section class="home-hero" aria-labelledby="home-title">
      <div class="home-copy">
        <h1 id="home-title">Learn Pi Agent</h1>

        <p class="home-tagline">
          Minimal core. Extensible by design.
        </p>

        <p>
          {{ copy.home.leadLine1 }}<br />
          {{ copy.home.leadLine2 }}
        </p>

        <a
          class="home-cta"
          :href="withBase(prefix + 'chapters/00-minimal-llm-call')"
        >
          {{ copy.home.cta }} <span aria-hidden="true">→</span>
        </a>
      </div>

      <AgentOrbit />
    </section>

    <section class="home-start" aria-labelledby="start-title">
      <header class="home-start-head">
        <h2 id="start-title">The Agent Loop</h2>
        <p class="home-start-desc">Call the model · Run its tools · Feed results back until it stops asking</p>
      </header>

      <div
        ref="codeWindow"
        class="home-code"
        :aria-label="copy.home.codeAriaLabel"
      >
        <div class="home-code-bar">
          <span class="home-code-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
          <span>agent-loop.ts</span>
        </div>

        <!-- No whitespace text nodes between spans: pre would render source newlines as phantom blank lines -->
        <pre><code><span class="line"><b>while</b> (<em>true</em>) {</span><span class="line">  <b>const</b> assistant = <em>await</em> callModel(context);</span><span class="line">  context.messages.push(assistant);</span><span class="line">  <b>if</b> (!hasToolCalls(assistant)) {</span><span class="line">    <em>break</em>;</span><span class="line">  }</span><span class="line">  <b>const</b> results = <em>await</em> executeTools(assistant.toolCalls);</span><span class="line">  context.messages.push(...results);</span><span class="line">}</span></code></pre>
      </div>
    </section>
  </main>
</template>

<style scoped>
.home-tagline {
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
  line-height: 1.5;
  font-weight: 500;
  letter-spacing: 0.01em;
  opacity: 0.72;
}
</style>