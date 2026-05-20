import { defineConfig } from "aruna";

export default defineConfig({
  conventions: {
    client: ["**/client/**", "**/shared/**"],
    server: ["**/server/**"],
    shared: ["**/shared/**"],
  },
});
