/**
 * Storage utility functions for LLM Prompt Queue extension
 * Uses chrome.storage.local for persistent storage
 */

const STORAGE_KEYS = {
  QUEUE: 'promptQueue',
  SETTINGS: 'settings',
  LIBRARY: 'promptLibrary'
};

const DEFAULT_SETTINGS = {
  autoSendEnabled: false
};

/**
 * Generates a UUID v4 string
 * @returns {string} A unique identifier
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// =============================================================================
// QUEUE OPERATIONS
// =============================================================================

async function getQueue() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
    return result[STORAGE_KEYS.QUEUE] ||[];
  } catch (error) {
    console.error('Error getting queue:', error);
    return[];
  }
}

async function addToQueue(prompt) {
  try {
    const queue = await getQueue();
    const newItem = {
      id: generateUUID(),
      prompt: prompt,
      createdAt: Date.now()
    };
    queue.push(newItem);
    await updateQueue(queue);
    return queue;
  } catch (error) {
    console.error('Error adding to queue:', error);
    throw error;
  }
}

async function removeFromQueue(id) {
  try {
    const queue = await getQueue();
    const updatedQueue = queue.filter(item => item.id !== id);
    await updateQueue(updatedQueue);
    return updatedQueue;
  } catch (error) {
    console.error('Error removing from queue:', error);
    throw error;
  }
}

async function clearQueue() {
  try {
    await updateQueue([]);
    return[];
  } catch (error) {
    console.error('Error clearing queue:', error);
    throw error;
  }
}

async function updateQueue(queue) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queue }, () => {
      if (chrome.runtime.lastError) {
        return reject(new Error("Failed to update queue: " + chrome.runtime.lastError.message));
      }
      resolve(queue);
    });
  });
}

// =============================================================================
// LIBRARY OPERATIONS
// =============================================================================

async function getLibrary() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.LIBRARY);
    return result[STORAGE_KEYS.LIBRARY] ||[];
  } catch (error) {
    console.error('Error getting library:', error);
    return[];
  }
}

async function checkStorageQuota(estimatedBytesToAdd) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      // Chrome's default QUOTA_BYTES for local is 5,242,880 (5MB)
      const QUOTA_LIMIT = 5242880;
      if (bytesInUse + estimatedBytesToAdd > QUOTA_LIMIT) {
        reject(new Error("Storage quota exceeded. Please delete old saved chains."));
      } else {
        resolve();
      }
    });
  });
}

async function saveToLibrary(name, queueItems) {
  const library = await getLibrary();

  // Validate schema to prevent corruption
  if (!Array.isArray(queueItems) || queueItems.some(item => typeof item.prompt !== 'string')) {
    throw new Error("Invalid queue data format.");
  }

  const newChain = {
    id: generateUUID(),
    name: name,
    createdAt: Date.now(),
    prompts: queueItems.map(item => ({ prompt: item.prompt }))
  };

  const estimatedSize = JSON.stringify(newChain).length * 2; // Rough byte size estimate
  await checkStorageQuota(estimatedSize);

  library.push(newChain);

  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY]: library }, () => {
      if (chrome.runtime.lastError) {
        return reject(new Error("Failed to write to storage: " + chrome.runtime.lastError.message));
      }
      resolve(library);
    });
  });
}

async function removeFromLibrary(id) {
  try {
    const library = await getLibrary();
    const updatedLibrary = library.filter(chain => chain.id !== id);

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY]: updatedLibrary }, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error("Failed to remove from library: " + chrome.runtime.lastError.message));
        }
        resolve(updatedLibrary);
      });
    });
  } catch (error) {
    console.error('Error removing from library:', error);
    throw error;
  }
}

async function loadChainToQueue(chainId, append = false) {
  const library = await getLibrary();
  const chain = library.find(c => c.id === chainId);

  if (!chain || !Array.isArray(chain.prompts)) {
    throw new Error("Chain data is corrupted or missing.");
  }

  const newItems = chain.prompts.map(p => ({
    id: generateUUID(),
    prompt: p.prompt,
    createdAt: Date.now()
  }));

  const currentQueue = append ? await getQueue() : [];
  const combinedQueue = [...currentQueue, ...newItems];

  return await updateQueue(combinedQueue);
}

// =============================================================================
// SETTINGS OPERATIONS
// =============================================================================

async function getSettings() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
  } catch (error) {
    console.error('Error getting settings:', error);
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(settings) {
  try {
    const currentSettings = await getSettings();
    const updatedSettings = { ...currentSettings, ...settings };

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updatedSettings }, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error("Failed to save settings: " + chrome.runtime.lastError.message));
        }
        resolve(updatedSettings);
      });
    });
  } catch (error) {
    console.error('Error saving settings:', error);
    throw error;
  }
}

export {
  getQueue,
  addToQueue,
  removeFromQueue,
  clearQueue,
  updateQueue,
  getLibrary,
  saveToLibrary,
  removeFromLibrary,
  loadChainToQueue,
  getSettings,
  saveSettings
};