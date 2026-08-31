import { createHash } from "node:crypto"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"

function serviceWorker(): Plugin {
  return {
    name: "rubato-service-worker",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map") && name !== "sw.js")
        .map((name) => `/rubato/${name}`)
      const cacheVersion = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12)
      const source = `const CACHE="rubato-shell-${cacheVersion}";
const ASSETS=${JSON.stringify(["/rubato/", "/rubato/index.html", "/rubato/manifest.webmanifest", ...assets])};
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{const request=event.request;if(request.method!=="GET"||new URL(request.url).pathname.includes("/api/"))return;if(request.mode==="navigate"){event.respondWith(fetch(request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put("/rubato/index.html",copy));return response}).catch(()=>caches.match("/rubato/index.html")));return}event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(new URL(request.url).origin===location.origin)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response})))});
self.addEventListener("push",event=>{const data=event.data?.json()||{};event.waitUntil(self.registration.showNotification(data.title||"Rubato",{body:data.body||"작업 상태가 바뀌었어요.",icon:"/rubato/icons/icon-192.png",data:{url:data.url||"/rubato/"}}).then(()=>self.registration.setAppBadge?.()))});
self.addEventListener("notificationclick",event=>{event.notification.close();const url=event.notification.data?.url||"/rubato/";event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(clients=>{const existing=clients.find(client=>new URL(client.url).pathname===url);return existing?existing.focus():self.clients.openWindow(url)}))});
self.addEventListener("message",event=>{if(event.data?.type==="SKIP_WAITING")self.skipWaiting()});`
      this.emitFile({ type: "asset", fileName: "sw.js", source })
    },
  }
}

export default defineConfig({
  base: "/rubato/",
  plugins: [react(), tailwindcss(), serviceWorker()],
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 500 },
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: "./src/test/setup.ts", css: true, globals: true },
})
