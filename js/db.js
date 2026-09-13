// Minimal promise-based IndexedDB wrapper for the puzzle lab.
const DB_NAME = 'chess-puzzle-lab';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('games')) {
        db.createObjectStore('games', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('puzzles')) {
        const store = db.createObjectStore('puzzles', { keyPath: 'id' });
        store.createIndex('gameId', 'gameId');
        store.createIndex('severity', 'severity');
        store.createIndex('bookmarked', 'bookmarked');
      }
      if (!db.objectStoreNames.contains('practice')) {
        db.createObjectStore('practice', { keyPath: 'puzzleId' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class Store {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }
  _tx(mode) {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }
  get(key) {
    return new Promise((resolve, reject) => {
      const r = this._tx('readonly').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  getAll() {
    return new Promise((resolve, reject) => {
      const r = this._tx('readonly').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  put(value) {
    return new Promise((resolve, reject) => {
      const r = this._tx('readwrite').put(value);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  putMany(values) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.name, 'readwrite');
      const store = tx.objectStore(this.name);
      values.forEach((v) => store.put(v));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  delete(key) {
    return new Promise((resolve, reject) => {
      const r = this._tx('readwrite').delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }
  clear() {
    return new Promise((resolve, reject) => {
      const r = this._tx('readwrite').clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }
}

const DB = {
  _db: null,
  async init() {
    this._db = await openDB();
    this.games = new Store(this._db, 'games');
    this.puzzles = new Store(this._db, 'puzzles');
    this.practice = new Store(this._db, 'practice');
    this.settings = new Store(this._db, 'settings');
    return this;
  },
  async getSetting(key, fallback) {
    const row = await this.settings.get(key);
    return row ? row.value : fallback;
  },
  async setSetting(key, value) {
    return this.settings.put({ key, value });
  },
};
