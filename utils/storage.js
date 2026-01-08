/**
 * Storage utility functions for LLM Prompt Queue extension
 * Uses chrome.storage.local for persistent storage
 */

const STORAGE_KEYS = {
  QUEUE: 'promptQueue',
  SETTINGS: 'settings'
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

/**
 * Retrieves the current queue from storage
 * @returns {Promise<Array>} Promise resolving to array of queue items
 */
async function getQueue() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
    return result[STORAGE_KEYS.QUEUE] || [];
  } catch (error) {
    console.error('Error getting queue:', error);
    return [];
  }
}

/**
 * Adds a prompt to the queue
 * @param {string} prompt - The prompt text to add
 * @returns {Promise<Array>} Promise resolving to updated queue array
 */
async function addToQueue(prompt) {
  try {
    const queue = await getQueue();
    const newItem = {
      id: generateUUID(),
      prompt: prompt,
      createdAt: Date.now()
    };
    queue.push(newItem);
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queue });
    return queue;
  } catch (error) {
    console.error('Error adding to queue:', error);
    throw error;
  }
}

/**
 * Removes an item from the queue by its ID
 * @param {string} id - The unique identifier of the item to remove
 * @returns {Promise<Array>} Promise resolving to updated queue array
 */
async function removeFromQueue(id) {
  try {
    const queue = await getQueue();
    const updatedQueue = queue.filter(item => item.id !== id);
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: updatedQueue });
    return updatedQueue;
  } catch (error) {
    console.error('Error removing from queue:', error);
    throw error;
  }
}

/**
 * Clears all items from the queue
 * @returns {Promise<Array>} Promise resolving to empty array
 */
async function clearQueue() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: [] });
    return [];
  } catch (error) {
    console.error('Error clearing queue:', error);
    throw error;
  }
}

/**
 * Retrieves settings from storage
 * @returns {Promise<Object>} Promise resolving to settings object
 */
async function getSettings() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
  } catch (error) {
    console.error('Error getting settings:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Saves settings to storage
 * @param {Object} settings - Settings object to save
 * @returns {Promise<Object>} Promise resolving to saved settings object
 */
async function saveSettings(settings) {
  try {
    const currentSettings = await getSettings();
    const updatedSettings = { ...currentSettings, ...settings };
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updatedSettings });
    return updatedSettings;
  } catch (error) {
    console.error('Error saving settings:', error);
    throw error;
  }
}

// Export functions for use in other scripts
export {
  getQueue,
  addToQueue,
  removeFromQueue,
  clearQueue,
  getSettings,
  saveSettings
};
