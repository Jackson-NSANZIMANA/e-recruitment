import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins:[react()],
  server:{port:5173,proxy:{"/edge":{target:process.env.VITE_EDGE_ORIGIN||"http://localhost:3000",changeOrigin:true,secure:false}}}
});