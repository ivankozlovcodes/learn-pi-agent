<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useSiteCopy } from "../.vitepress/theme/useSiteCopy";

const { copy, prefix } = useSiteCopy();

/**
 * Above-the-fold orbit diagram: Agent Loop in the center, six core mechanisms actually orbiting along elliptical rings.
 * - Node positions are driven by rAF parametric equations (outer ring 46s, middle ring 38s per lap); hover pauses for easier clicking;
 * - Labels slide continuously around their nodes, always on the side facing the orbit center: no flip jumps, never touching the viewport edge;
 * - When the pointer moves over the orbit, stars/halo/nodes get layered parallax;
 * - prefers-reduced-motion: no animation starts; nodes stay at the static SSR position (the first frame), no flicker.
 */
/**
 * The three rings are assigned by "semantic distance from the Agent Loop":
 * inner ring Provider/Context (the model and data the loop calls directly),
 * middle ring Tool Runtime/Session (execution and persistence inside the loop),
 * outer ring Skills/Extensions (outer capability injection and extension).
 */
const nodes = [
  { key: "skills", label: "Skills", slug: "chapters/09-skills", ring: 0, angle: -100 },
  { key: "session", label: "Session", slug: "chapters/07-session-tree", ring: 1, angle: 155 },
  { key: "extensions", label: "Extensions", slug: "chapters/10-extension-runtime", ring: 0, angle: 25 },
  { key: "context", label: "Context", slug: "chapters/06-context-transform", ring: 2, angle: 20 },
  { key: "tools", label: "Tool Runtime", slug: "chapters/03-tool-runtime", ring: 1, angle: -25 },
  { key: "provider", label: "Provider", slug: "chapters/00-minimal-llm-call", ring: 2, angle: 200 },
];

/** Orbit geometry: same coordinate system as the SVG viewBox (720×280), converted to percentages when written to styles. */
const CENTER = { x: 360, y: 140 };
const RINGS = [
  { rx: 330, ry: 118, degPerSec: 360 / 46 },
  { rx: 258, ry: 88, degPerSec: 360 / 38 },
  { rx: 186, ry: 60, degPerSec: 360 / 30 },
];
const pointAt = (ring: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return {
    rad,
    x: ((CENTER.x + RINGS[ring].rx * Math.cos(rad)) / 720) * 100,
    y: ((CENTER.y + RINGS[ring].ry * Math.sin(rad)) / 280) * 100,
  };
};
/**
 * Label anchor: trails the node along the orbit tangent (opposite to the direction of motion),
 * so the label always stays within its own ring's height band: never covering the center text, never colliding across rings, continuous with no jumps.
 * SSR estimates label width from the character count; it is corrected by measurement after mount.
 */
const LABEL_GAP = 11;
const estimateLabelW = (label: string) => label.length * 7.4 + 4;
const labelAnchor = (rad: number, labelW: number, gap = LABEL_GAP) => {
  const dist = labelW / 2 + gap;
  return { lx: Math.sin(rad) * dist, ly: -Math.cos(rad) * dist };
};
const initial = nodes.map((n) => {
  const p = pointAt(n.ring, n.angle);
  const a = labelAnchor(p.rad, estimateLabelW(n.label));
  return { x: p.x, y: p.y, ...a };
});

/** Stars: fixed coordinates scattered in the gaps between rings, twinkling with their own delay in CSS. [x, y, r, delay(s)] */
const stars: [number, number, number, number][] = [
  [52, 36, 1.2, 0], [96, 78, 0.9, 1.2], [86, 210, 1.4, 0.6], [160, 250, 0.8, 2],
  [230, 30, 1.0, 1.6], [300, 14, 1.3, 0.3], [440, 14, 0.9, 2.4], [516, 34, 1.2, 1],
  [606, 58, 0.8, 1.8], [672, 108, 1.3, 0.9], [692, 198, 1.0, 2.2], [622, 246, 1.4, 0.4],
  [480, 258, 0.9, 1.4], [350, 264, 1.1, 2.6], [196, 184, 0.8, 0.2], [560, 160, 0.7, 1.9],
];

const orbitRoot = ref<HTMLElement>();
const orbitNav = ref<HTMLElement>();
/** Hovered node: used both to pause rAF and to drive the linked center text (reactive). */
const hovered = ref<string | null>(null);
const setHovered = (key: string | null) => { hovered.value = key; };
const centerLabel = computed(() => (hovered.value ? nodes.find((n) => n.key === hovered.value)?.label : null) ?? "Agent Loop");
const centerColor = computed(() => (hovered.value ? `var(--acc-${hovered.value})` : undefined));
/** Narrow screens (≤719px): labels face outward, depth contrast is relaxed (see tick). */
const compact = ref(false);
let dispose: () => void = () => {};

onMounted(() => {
  // Reduced motion: keep the static SSR position, start no loop
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const root = orbitRoot.value;
  const els = Array.from(orbitNav.value?.querySelectorAll<HTMLElement>(".orbit-node") ?? []);
  if (!root || els.length !== nodes.length) return;

  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointerMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    parallax.tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    parallax.ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
  };
  const onPointerLeave = () => { parallax.tx = 0; parallax.ty = 0; };
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerleave", onPointerLeave);

  // Narrow-screen mode: labels face outward, tighter spacing
  const mq = window.matchMedia("(max-width: 719px)");
  compact.value = mq.matches;
  const onMqChange = (e: MediaQueryListEvent) => { compact.value = e.matches; };
  mq.addEventListener("change", onMqChange);

  // Measure label widths (they change with breakpoint font sizes) to compute label anchor distances
  let labelW = els.map((el) => el.querySelector<HTMLElement>(".node-label")?.getBoundingClientRect().width ?? 0);
  const onResize = () => {
    labelW = els.map((el) => el.querySelector<HTMLElement>(".node-label")?.getBoundingClientRect().width ?? 0);
  };
  window.addEventListener("resize", onResize);
  // Hand opacity/scale control back after the entrance animation (otherwise fill:both keeps overriding the inline values)
  els.forEach((el) => el.addEventListener("animationend", () => { el.style.animation = "none"; }, { once: true }));

  let raf = 0;
  let last = 0;
  const tick = (now: number) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    parallax.x += (parallax.tx - parallax.x) * 0.06;
    parallax.y += (parallax.ty - parallax.y) * 0.06;
    root.style.setProperty("--px", parallax.x.toFixed(4));
    root.style.setProperty("--py", parallax.y.toFixed(4));
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (hovered.value !== n.key) n.angle += RINGS[n.ring].degPerSec * dt;
      const { rad, x, y } = pointAt(n.ring, n.angle);
      const { lx, ly } = labelAnchor(rad, labelW[i], compact.value ? 8 : LABEL_GAP);
      const el = els[i];
      el.style.left = `${x + parallax.x * 1.1}%`;
      el.style.top = `${y + parallax.y * 2.2}%`;
      el.style.setProperty("--lx", `${lx.toFixed(1)}px`);
      el.style.setProperty("--ly", `${ly.toFixed(1)}px`);
      // Depth cue: the top is the far side (small, dim, behind the core glow), the bottom is the near side (large, bright, in front);
      // narrow screens relax the contrast to stay readable
      const depth = (Math.sin(rad) + 1) / 2;
      if (compact.value) {
        el.style.scale = (0.94 + depth * 0.1).toFixed(3);
        el.style.opacity = (0.75 + depth * 0.25).toFixed(3);
      } else {
        el.style.scale = (0.88 + depth * 0.18).toFixed(3);
        el.style.opacity = (0.5 + depth * 0.5).toFixed(3);
      }
      el.style.zIndex = depth < 0.45 ? "1" : "4";
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  dispose = () => {
    cancelAnimationFrame(raf);
    mq.removeEventListener("change", onMqChange);
    window.removeEventListener("resize", onResize);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onPointerLeave);
  };
});
onBeforeUnmount(() => dispose());
</script>

<template>
  <div ref="orbitRoot" class="agent-orbit">
    <div class="orbit-aurora" aria-hidden="true"></div>
    <svg class="orbit-svg" viewBox="0 0 720 280" fill="none" aria-hidden="true">
      <defs>
        <!-- Vertical gradient on ring strokes: dark at the top (far side) → bright at the bottom (near side), a lighting hint for the top-down view -->
        <linearGradient id="ring-depth" x1="0" y1="0" x2="0" y2="1">
          <stop class="stop-far" offset="0%" />
          <stop class="stop-near" offset="62%" />
        </linearGradient>
      </defs>
      <circle
        v-for="([x, y, r, d]) in stars"
        :key="`${x}-${y}`"
        class="star"
        :style="{ animationDelay: `${d}s` }"
        :cx="x"
        :cy="y"
        :r="r"
      />
      <ellipse class="ring ring-outer" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="ring ring-middle" cx="360" cy="140" rx="258" ry="88" pathLength="100" />
      <ellipse class="ring ring-inner" cx="360" cy="140" rx="186" ry="60" pathLength="100" />
      <ellipse class="ring-core" cx="360" cy="140" rx="104" ry="38" />
      <ellipse class="comet comet-one-tail" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="comet comet-one-mid" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="comet comet-one" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="comet comet-two" cx="360" cy="140" rx="258" ry="88" pathLength="100" />
      <ellipse class="comet comet-three" cx="360" cy="140" rx="186" ry="60" pathLength="100" />
    </svg>
    <div class="orbit-glow" aria-hidden="true"></div>
    <div class="orbit-core">
      <Transition name="core-fade" mode="out-in">
        <span :key="centerLabel" :style="centerColor ? { color: centerColor } : undefined">{{ centerLabel }}</span>
      </Transition>
    </div>
    <nav ref="orbitNav" class="orbit-nav" :aria-label="copy.orbit.navAriaLabel">
      <a
        v-for="(node, i) in nodes"
        :key="node.key"
        class="orbit-node"
        :class="`node-${node.key}`"
        :style="{
          left: `${initial[i].x}%`,
          top: `${initial[i].y}%`,
          '--lx': `${initial[i].lx.toFixed(1)}px`,
          '--ly': `${initial[i].ly.toFixed(1)}px`,
        }"
        :href="withBase(prefix + node.slug)"
        @mouseenter="setHovered(node.key)"
        @mouseleave="setHovered(null)"
        @focus="setHovered(node.key)"
        @blur="setHovered(null)"
      ><span class="node-dot" aria-hidden="true"></span><span class="node-label">{{ node.label }}</span></a>
    </nav>
  </div>
</template>
