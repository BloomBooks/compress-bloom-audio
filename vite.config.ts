import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    // Workspace mode: vp test / vp test watch at repo root discovers all projects.
    projects: ["packages/*"],
  },
});
