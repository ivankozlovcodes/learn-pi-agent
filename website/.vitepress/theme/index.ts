import DefaultTheme from "vitepress/theme";
import HomePage from "../../components/HomePage.vue";
import Layout from "./Layout.vue";
import "./style.css";

/** Terminal-engineering theme: VitePress default theme with overridden colors/fonts/local layout (see style.css). */
export default {
  ...DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("HomePage", HomePage);
  },
};
