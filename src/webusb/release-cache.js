import release from './release.json';

async function openCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('light-guide-releases', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('releases');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cachedRelease(operation, bytes, key = release.sha256) {
  const db = await openCache();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('releases', operation === 'read' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('releases');
      let request;
      if (operation === 'read') request = store.get(key);
      else if (operation === 'delete') request = store.delete(key);
      else request = store.put(bytes, key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
