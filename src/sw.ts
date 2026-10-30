/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

// App shell only. Household data is never served from this cache as if fresh;
// the app labels offline copies itself.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data: { title?: string; body?: string; tag?: string; url?: string } = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    data = { body: event.data?.text() }
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Liyana's Closet", {
      body: data.body,
      tag: data.tag, // same tag replaces instead of stacking duplicates
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: data.url ?? '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = self.registration.scope + '#/inventory'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          void (c as WindowClient).navigate(target)
          return (c as WindowClient).focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
