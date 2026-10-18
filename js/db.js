/*
 * db.js
 * -----
 * Saves stickers, layouts and settings in the browser's IndexedDB, so
 * everything is still there next time you open the page.
 *
 * If IndexedDB isn't available (some browsers block it for files opened
 * straight from disk), it falls back to keeping things in memory only and
 * the app shows a warning.
 */
(function () {
  'use strict';
  const SL = (window.SL = window.SL || {});

  const DB_NAME = 'laptop-sticker-planner';
  const DB_VERSION = 1;
  const STORES = ['stickers', 'layouts', 'kv'];

  let db = null;
  let memory = null; // fallback: { stickers: Map, layouts: Map, kv: Map }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const DB = {
    persistent: true,

    async open() {
      try {
        if (!('indexedDB' in window)) throw new Error('No IndexedDB');
        db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains('stickers')) d.createObjectStore('stickers', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('layouts')) d.createObjectStore('layouts', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('Database blocked'));
        });
        // Quick write test (Safari private mode can open but not write).
        await this.setKV('__probe', 1);
      } catch (err) {
        console.warn('Storage unavailable, using memory only:', err);
        db = null;
        memory = { stickers: new Map(), layouts: new Map(), kv: new Map() };
        this.persistent = false;
      }
    },

    async getAll(store) {
      if (!db) return [...memory[store].values()];
      const tx = db.transaction(store, 'readonly');
      return promisify(tx.objectStore(store).getAll());
    },

    async put(store, value) {
      if (!db) {
        memory[store].set(store === 'kv' ? value.key : value.id, value);
        return;
      }
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Save was aborted (storage may be full)'));
      });
    },

    async remove(store, key) {
      if (!db) {
        memory[store].delete(key);
        return;
      }
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getKV(key) {
      if (!db) {
        const v = memory.kv.get(key);
        return v ? v.value : undefined;
      }
      const tx = db.transaction('kv', 'readonly');
      const row = await promisify(tx.objectStore('kv').get(key));
      return row ? row.value : undefined;
    },

    async setKV(key, value) {
      return this.put('kv', { key, value });
    },

    async clearAll() {
      if (!db) {
        for (const s of STORES) memory[s].clear();
        return;
      }
      const tx = db.transaction(STORES, 'readwrite');
      for (const s of STORES) tx.objectStore(s).clear();
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };

  SL.DB = DB;
})();
