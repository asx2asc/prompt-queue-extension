/**
 * LLM Prompt Queue - Popup Script
 * Reactive architecture enforcing Single Source of Truth via chrome.storage
 */

// =============================================================================
// Encapsulated Storage Module (Bypasses ES Module pathing issues)
// =============================================================================

const STORAGE_KEYS = {
  QUEUE: 'promptQueue',
  SETTINGS: 'settings',
  LIBRARY: 'promptLibrary'
};

const DEFAULT_SETTINGS = {
  autoSendEnabled: false
};

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const storage = {
  async getQueue() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
      return result[STORAGE_KEYS.QUEUE] || [];
    } catch (error) {
      console.error('Error getting queue:', error);
      return[];
    }
  },

  async updateQueue(queue) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queue }, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error("Failed to update queue: " + chrome.runtime.lastError.message));
        }
        resolve(queue);
      });
    });
  },

  async addToQueue(prompt) {
    const queue = await this.getQueue();
    const extractedVariables = [...prompt.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1].trim());
    const uniqueVariables = [...new Set(extractedVariables)];
    const newItem = { 
      id: generateUUID(), 
      prompt: prompt, 
      variables: uniqueVariables,
      createdAt: Date.now() 
    };
    queue.push(newItem);
    await this.updateQueue(queue);
    return queue;
  },

  async removeFromQueue(id) {
    const queue = await this.getQueue();
    const updatedQueue = queue.filter(item => item.id !== id);
    await this.updateQueue(updatedQueue);
    return updatedQueue;
  },

  async clearQueue() {
    return await this.updateQueue([]);
  },

  async getLibrary() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.LIBRARY);
      return result[STORAGE_KEYS.LIBRARY] ||[];
    } catch (error) {
      console.error('Error getting library:', error);
      return[];
    }
  },

  async checkStorageQuota(estimatedBytesToAdd) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        // Chrome's default QUOTA_BYTES for local is 5,242,880 (5MB)
        const QUOTA_LIMIT = 5242880;
        if (bytesInUse + estimatedBytesToAdd > QUOTA_LIMIT) {
          reject(new Error("Storage quota exceeded. Please delete old saved chains."));
        } else {
          resolve();
        }
      });
    });
  },

  async saveToLibrary(name, queueItems) {
    const library = await this.getLibrary();
    if (!Array.isArray(queueItems) || queueItems.some(item => typeof item.prompt !== 'string')) {
      throw new Error("Invalid queue data format.");
    }
    const newChain = {
      id: generateUUID(),
      name: name,
      createdAt: Date.now(),
      prompts: queueItems.map(item => ({ 
        prompt: item.prompt,
        variables: Array.isArray(item.variables) ? item.variables :[]
      }))
    };

    const estimatedSize = JSON.stringify(newChain).length * 2;
    await this.checkStorageQuota(estimatedSize);
    library.push(newChain);

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({[STORAGE_KEYS.LIBRARY]: library }, () => {
        if (chrome.runtime.lastError) return reject(new Error("Failed to write to storage: " + chrome.runtime.lastError.message));
        resolve(library);
      });
    });
  },

  async removeFromLibrary(id) {
    const library = await this.getLibrary();
    const updatedLibrary = library.filter(chain => chain.id !== id);
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY]: updatedLibrary }, () => {
        if (chrome.runtime.lastError) return reject(new Error("Failed to remove from library: " + chrome.runtime.lastError.message));
        resolve(updatedLibrary);
      });
    });
  },

  async loadChainToQueue(chainId, append = false) {
    const library = await this.getLibrary();
    const chain = library.find(c => c.id === chainId);
    if (!chain || !Array.isArray(chain.prompts)) throw new Error("Chain data is corrupted or missing.");

    const newItems = chain.prompts.map(p => ({
      id: generateUUID(),
      prompt: p.prompt,
      variables: Array.isArray(p.variables) ? p.variables :[],
      createdAt: Date.now()
    }));

    const currentQueue = append ? await this.getQueue() : [];
    const combinedQueue = [...currentQueue, ...newItems];
    return await this.updateQueue(combinedQueue);
  },

  async getSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
    } catch (error) {
      console.error('Error getting settings:', error);
      return DEFAULT_SETTINGS;
    }
  },

  async saveSettings(settings) {
    const currentSettings = await this.getSettings();
    const updatedSettings = { ...currentSettings, ...settings };
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({[STORAGE_KEYS.SETTINGS]: updatedSettings }, () => {
        if (chrome.runtime.lastError) return reject(new Error("Failed to save settings: " + chrome.runtime.lastError.message));
        resolve(updatedSettings);
      });
    });
  },

  async exportLibraryData() {
    try {
      const library = await this.getLibrary();
      return JSON.stringify(library, null, 2);
    } catch (error) {
      throw new Error("Failed to serialize library for export.");
    }
  },

  async importLibraryData(jsonData, append = false) {
    let importedData;
    try {
      importedData = JSON.parse(jsonData);
    } catch (error) {
      throw new Error("Invalid file format: The file does not contain valid JSON.");
    }

    if (!Array.isArray(importedData)) {
      throw new Error("Invalid file format: Expected an array of prompt chains.");
    }

    const validatedChains =[];
    for (const chain of importedData) {
      if (typeof chain !== 'object' || chain === null) continue;
      
      if (typeof chain.name !== 'string' || chain.name.trim() === '') {
        throw new Error("Invalid schema: One or more chains are missing a valid 'name' property.");
      }

      if (!Array.isArray(chain.prompts)) {
        throw new Error(`Invalid schema: Chain '${chain.name}' is missing a valid 'prompts' array.`);
      }

      const validPrompts = chain.prompts.filter(p => typeof p === 'object' && p !== null && typeof p.prompt === 'string');
      if (validPrompts.length === 0) {
         throw new Error(`Invalid schema: Chain '${chain.name}' contains no valid text prompts.`);
      }

      validatedChains.push({
        id: (typeof chain.id === 'string' && chain.id.trim() !== '') ? chain.id : generateUUID(),
        name: chain.name.trim(),
        createdAt: (typeof chain.createdAt === 'number') ? chain.createdAt : Date.now(),
        prompts: validPrompts.map(p => ({ 
          prompt: p.prompt,
          variables: Array.isArray(p.variables) ? p.variables.filter(v => typeof v === 'string') :[]
        }))
      });
    }

    if (validatedChains.length === 0) {
      throw new Error("Import failed: No valid prompt chains were found in the file.");
    }

    let currentLibrary = append ? await this.getLibrary() : [];
    const mergedLibrary =[...currentLibrary];

    for (const newChain of validatedChains) {
      const existingIndex = mergedLibrary.findIndex(existing => existing.id === newChain.id);
      if (existingIndex >= 0) {
        mergedLibrary[existingIndex] = newChain;
      } else {
        mergedLibrary.push(newChain);
      }
    }

    const estimatedSize = JSON.stringify(mergedLibrary).length * 2;
    await this.checkStorageQuota(estimatedSize);

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({[STORAGE_KEYS.LIBRARY]: mergedLibrary }, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error("Failed to write imported library to storage: " + chrome.runtime.lastError.message));
        }
        resolve(mergedLibrary);
      });
    });
  }
};

// =============================================================================
// Constants & State
// =============================================================================

const SUPPORTED_SITES =[
  { hostname: 'chatgpt.com', name: 'ChatGPT' },
  { hostname: 'chat.openai.com', name: 'ChatGPT' },
  { hostname: 'claude.ai', name: 'Claude' },
  { hostname: 'gemini.google.com', name: 'Gemini' },
  { hostname: 'aistudio.google.com', name: 'AI Studio' }
];

const MessageType = {
  GET_STATUS: 'GET_STATUS',
  QUEUE_UPDATED: 'QUEUE_UPDATED',
  TOGGLE_AUTO_SEND: 'TOGGLE_AUTO_SEND',
  START_PROCESSING: 'START_PROCESSING',
  SEND_NEXT: 'SEND_NEXT'
};

const STATUS_MESSAGES = {
  idle: 'Idle',
  waiting_for_response: 'Waiting for response...',
  sending_prompt: 'Sending prompt...',
  active: 'Active',
  paused: 'Paused (tab not focused)'
};

let currentSettings = { autoSendEnabled: false };
let currentTabInfo = { url: null, isSupported: false, siteName: null };

// =============================================================================
// DOM Elements Setup (Fail Fast)
// =============================================================================

const elements = {};

function getRequiredElement(selector) {
  const el = selector.startsWith('#')
    ? document.getElementById(selector.slice(1))
    : document.querySelector(selector);

  if (!el) throw new Error(`Critical DOM element missing: ${selector}`);
  return el;
}

function initializeElements() {
  elements.statusIndicator = getRequiredElement('.status-indicator');
  elements.statusText = getRequiredElement('.status-text');
  elements.siteStatus = getRequiredElement('.site-status');
  elements.siteText = getRequiredElement('.site-text');

  elements.promptInput = getRequiredElement('#prompt-input');
  elements.addToQueueBtn = getRequiredElement('#add-to-queue-btn');
  elements.autoSendToggle = getRequiredElement('#auto-send-toggle');
  elements.sendNextBtn = getRequiredElement('#send-next-btn');

  elements.queueList = getRequiredElement('#queue-list');
  elements.queueCount = getRequiredElement('#queue-count');
  elements.queueEmpty = getRequiredElement('.queue-empty');
  elements.saveQueueBtn = getRequiredElement('#save-queue-btn');
  elements.clearAllBtn = getRequiredElement('#clear-all-btn');

  elements.libraryList = getRequiredElement('#library-list');
  elements.statusMessage = getRequiredElement('#status-message');

  elements.importLibraryBtn = getRequiredElement('#import-library-btn');
  elements.exportLibraryBtn = getRequiredElement('#export-library-btn');
  elements.importFileInput = getRequiredElement('#import-file-input');
}

// =============================================================================
// Initialization & Reactive Storage Listener
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  initializeElements();
  attachEventListeners();

  // Initialize Drag-and-Drop Reordering
  if (typeof Sortable !== 'undefined') {
    Sortable.create(elements.queueList, {
      handle: '.queue-item-drag-handle',
      animation: 150,
      ghostClass: 'queue-item-ghost',
      onEnd: async function (evt) {
        if (evt.oldIndex === evt.newIndex) return;
        const queue = await storage.getQueue();
        const movedItem = queue.splice(evt.oldIndex, 1)[0];
        queue.splice(evt.newIndex, 0, movedItem);
        await storage.updateQueue(queue);
      }
    });
  }

  // Initialize Drag-and-Drop Reordering
  if (typeof Sortable !== 'undefined') {
    Sortable.create(elements.queueList, {
      handle: '.queue-item-drag-handle',
      animation: 150,
      ghostClass: 'queue-item-ghost',
      onEnd: async function (evt) {
        if (evt.oldIndex === evt.newIndex) return;
        const queue = await storage.getQueue();
        const movedItem = queue.splice(evt.oldIndex, 1)[0];
        queue.splice(evt.newIndex, 0, movedItem);
        await storage.updateQueue(queue);
      }
    });
  }

  // Initialize Drag-and-Drop Reordering
  if (typeof Sortable !== 'undefined') {
    Sortable.create(elements.queueList, {
      handle: '.queue-item-drag-handle',
      animation: 150,
      ghostClass: 'queue-item-ghost',
      onEnd: async function (evt) {
        if (evt.oldIndex === evt.newIndex) return;
        const queue = await storage.getQueue();
        const movedItem = queue.splice(evt.oldIndex, 1)[0];
        queue.splice(evt.newIndex, 0, movedItem);
        await storage.updateQueue(queue);
      }
    });
  }

  // Set up reactive UI updates based on storage changes (SSOT)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.promptQueue) renderQueue(changes.promptQueue.newValue ||[]);
      if (changes.promptLibrary) renderLibrary(changes.promptLibrary.newValue ||[]);
      if (changes.settings && changes.settings.newValue) updateSettingsUI(changes.settings.newValue);
    }
  });

  await loadInitialState();
  await checkCurrentTab();
  setupMessageListener();
});

async function loadInitialState() {
  try {
    const [queue, library, settings] = await Promise.all([
      storage.getQueue(),
      storage.getLibrary(),
      storage.getSettings()
    ]);

    currentSettings = settings;
    updateSettingsUI(settings);

    renderQueue(queue);
    renderLibrary(library);
  } catch (error) {
    showStatusMessage('Failed to load data', 'error');
  }
}

// =============================================================================
// Tab & View Management (DRY)
// =============================================================================

function attachEventListeners() {
  // Event Delegation for View Tabs
  document.querySelector('.tabs-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.target);
  });

  // Queue Actions
  elements.addToQueueBtn.addEventListener('click', handleAddToQueue);
  elements.promptInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleAddToQueue();
    }
  });

  elements.autoSendToggle.addEventListener('change', handleToggleChange);
  elements.sendNextBtn.addEventListener('click', handleSendNext);

  elements.saveQueueBtn.addEventListener('click', handleSaveQueue);
  elements.clearAllBtn.addEventListener('click', handleClearAll);

  // Event Delegation for Queue Items
  elements.queueList.addEventListener('click', handleQueueItemAction);
  elements.queueList.addEventListener('dblclick', handleQueueItemDoubleClick);

  // Event Delegation for Library Cards
  elements.libraryList.addEventListener('click', handleLibraryAction);

  // File I/O Actions
  elements.exportLibraryBtn.addEventListener('click', handleExportLibrary);
  elements.importLibraryBtn.addEventListener('click', () => elements.importFileInput.click());
  elements.importFileInput.addEventListener('change', handleImportLibrary);
}

function switchTab(targetId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.dataset.target === targetId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive.toString());
  });

  document.querySelectorAll('.view-section').forEach(view => {
    const isTargetView = view.id === `view-${targetId}`;
    view.hidden = !isTargetView;
    view.classList.toggle('active-view', isTargetView);
  });
}

// =============================================================================
// Active Queue Actions
// =============================================================================

async function handleAddToQueue() {
  const promptText = elements.promptInput.value.trim();
  if (!promptText) {
    showStatusMessage('Please enter a prompt', 'error');
    elements.promptInput.focus();
    return;
  }

  try {
    elements.addToQueueBtn.disabled = true;
    await storage.addToQueue(promptText);

    elements.promptInput.value = '';
    elements.promptInput.focus();
    showStatusMessage('Prompt added to queue', 'success');
  } catch (error) {
    showStatusMessage('Failed to add prompt', 'error');
  } finally {
    elements.addToQueueBtn.disabled = false;
  }
}

async function handleQueueItemAction(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const itemId = target.closest('.queue-item')?.dataset.id;
  if (!itemId) return;

  if (action === 'delete') {
    const itemElement = document.querySelector(`.queue-item[data-id="${itemId}"]`);
    if (itemElement) {
      itemElement.classList.add('leaving');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await storage.removeFromQueue(itemId);
  }
}



async function handleClearAll() {
  const queue = await storage.getQueue();
  if (queue.length === 0) return;

  if (!confirm('Are you sure you want to clear all prompts from the active queue?')) return;

  try {
    await storage.clearQueue();
    showStatusMessage('Queue cleared', 'success');
  } catch (error) {
    showStatusMessage('Failed to clear queue', 'error');
  }
}

// =============================================================================
// Library Actions (SLAP Implemented)
// =============================================================================

async function handleSaveQueue() {
  const queue = await storage.getQueue();
  if (queue.length === 0) return;

  let chainName = prompt("Enter a name to save this Prompt Chain:", `Chain - ${new Date().toLocaleDateString()}`);
  if (chainName === null) return;

  chainName = chainName.trim().substring(0, 80);
  if (chainName.length === 0) {
    showStatusMessage('Chain name cannot be empty', 'warning');
    return;
  }

  try {
    await storage.saveToLibrary(chainName, queue);
    showStatusMessage('Queue saved to library!', 'success');
  } catch (error) {
    showStatusMessage(error.message, 'error');
  }
}

function generateLibraryCardHTML(chain) {
  const dateStr = new Date(chain.createdAt).toLocaleDateString();
  const promptCount = `${chain.prompts.length} prompt${chain.prompts.length !== 1 ? 's' : ''}`;

  return `
    <div class="library-chain-card" data-id="${escapeHtml(chain.id)}">
      <div class="library-chain-header">
        <span class="library-chain-title">${escapeHtml(chain.name)}</span>
        <span class="library-chain-date">${escapeHtml(dateStr)}</span>
      </div>
      <div class="library-chain-meta">${escapeHtml(promptCount)}</div>
      <div class="library-chain-actions">
        <button class="btn btn-primary btn-small" data-action="load-overwrite" title="Replace current queue" style="display: flex; align-items: center; justify-content: center; gap: 6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"></path><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M3 22v-6h6"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg>
          Overwrite
        </button>
        <button class="btn btn-secondary btn-small" data-action="load-append" title="Add to end of current queue" style="display: flex; align-items: center; justify-content: center; gap: 6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          Append
        </button>
        <button class="btn btn-danger btn-small btn-icon" data-action="delete" title="Delete chain">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </div>
    </div>
  `;
}

function renderLibrary(libraryData) {
  if (!Array.isArray(libraryData) || libraryData.length === 0) {
    elements.libraryList.innerHTML = `
      <div class="library-empty-state">
        <div class="empty-icon">📁</div>
        <p class="empty-title">No saved chains</p>
        <p class="empty-hint">Build a queue and click "Save" to reuse it later.</p>
      </div>`;
    return;
  }

  const sortedLibrary = libraryData.sort((a, b) => b.createdAt - a.createdAt);
  elements.libraryList.innerHTML = sortedLibrary.map(generateLibraryCardHTML).join('');
}

async function handleLibraryAction(e) {
  const target = e.target.closest('button[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const chainId = target.closest('.library-chain-card').dataset.id;

  if (action === 'delete') {
    if (confirm("Are you sure you want to delete this saved chain?")) {
      try {
        await storage.removeFromLibrary(chainId);
        showStatusMessage('Chain deleted', 'success');
      } catch (error) {
        showStatusMessage(error.message, 'error');
      }
    }
  } else if (action === 'load-overwrite') {
    const queue = await storage.getQueue();
    if (queue.length > 0 && !confirm('This will overwrite your current active queue. Continue?')) return;
    await processLoadChainRequest(chainId, false);
  } else if (action === 'load-append') {
    await processLoadChainRequest(chainId, true);
  }
}

async function processLoadChainRequest(chainId, append) {
  try {
    if (currentSettings.autoSendEnabled) {
      currentSettings.autoSendEnabled = false;
      await storage.saveSettings(currentSettings);
      notifyServiceWorker(MessageType.TOGGLE_AUTO_SEND, { enabled: false });
      showStatusMessage('Auto-send paused to safely load chain', 'info');
    }

    if (!append) {
      notifyServiceWorker('CLEAR_RUNTIME_VARIABLES', {});
    }

    const updatedQueue = await storage.loadChainToQueue(chainId, append);

    switchTab('queue');
    showStatusMessage(append ? 'Chain appended' : 'Chain loaded', 'success');
    notifyServiceWorker(MessageType.QUEUE_UPDATED, { queue: updatedQueue });

  } catch (error) {
    showStatusMessage(error.message, 'error');
  }
}

async function handleExportLibrary() {
  try {
    elements.exportLibraryBtn.disabled = true;
    const jsonData = await storage.exportLibraryData();
    
    if (jsonData === "[]") {
      showStatusMessage('Library is empty, nothing to export', 'warning');
      elements.exportLibraryBtn.disabled = false;
      return;
    }

    const base64Data = btoa(unescape(encodeURIComponent(jsonData)));
    const dataUri = `data:application/json;base64,${base64Data}`;
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `llm-prompt-library-export-${timestamp}.json`;

    chrome.downloads.download({
      url: dataUri,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      elements.exportLibraryBtn.disabled = false;
      if (chrome.runtime.lastError) {
        showStatusMessage('Download failed: ' + chrome.runtime.lastError.message, 'error');
      } else {
        showStatusMessage('Library exported successfully', 'success');
      }
    });
  } catch (error) {
    elements.exportLibraryBtn.disabled = false;
    showStatusMessage('Failed to prepare export data', 'error');
  }
}

async function handleImportLibrary(event) {
  const file = event.target.files[0];
  if (!file) {
    return; // User cancelled file picker
  }

  // Pre-validate file size (e.g., hard limit of 6MB to prevent memory exhaustion before reading)
  if (file.size > 6291456) {
    showStatusMessage('File is too large to process', 'error');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  
  reader.onload = async (e) => {
    try {
      const append = confirm("Do you want to append this data to your existing library?\n\nSelect 'OK' to append to current chains, or 'Cancel' to permanently overwrite the library.");
      
      showStatusMessage('Importing library data...', 'info', { persist: true });
      const updatedLibrary = await storage.importLibraryData(e.target.result, append);
      
      renderLibrary(updatedLibrary);
      showStatusMessage('Library imported successfully', 'success');
    } catch (error) {
      showStatusMessage(error.message, 'error', { duration: 5000 });
    } finally {
      event.target.value = ''; // Reset input to allow re-importing the same file if needed
    }
  };

  reader.onerror = () => {
    showStatusMessage('Error reading file from disk', 'error');
    event.target.value = '';
  };

  reader.readAsText(file, 'UTF-8');
}

// =============================================================================
// Settings & Site Validation
// =============================================================================

async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      updateSiteStatus(false, 'Cannot detect current site');
      return;
    }

    const url = new URL(tab.url);
    const supportedSite = SUPPORTED_SITES.find(site =>
      url.hostname === site.hostname || url.hostname.endsWith('.' + site.hostname)
    );

    if (supportedSite) {
      currentTabInfo = { url: tab.url, isSupported: true, siteName: supportedSite.name };
      updateSiteStatus(true, `Connected to: ${supportedSite.name}`);
    } else {
      currentTabInfo = { url: tab.url, isSupported: false, siteName: null };
      updateSiteStatus(false, 'Not on supported site');
    }

    const queue = await storage.getQueue();
    updateSendNextButtonState(queue.length);
    requestCurrentStatus();
  } catch (error) {
    updateSiteStatus(false, 'Cannot detect current site');
  }
}

async function handleToggleChange() {
  const isEnabled = elements.autoSendToggle.checked;
  try {
    currentSettings.autoSendEnabled = isEnabled;
    await storage.saveSettings(currentSettings);
    notifyServiceWorker(MessageType.TOGGLE_AUTO_SEND, { enabled: isEnabled });
    showStatusMessage(isEnabled ? 'Auto-send enabled' : 'Auto-send disabled', 'info');
  } catch (error) {
    elements.autoSendToggle.checked = !isEnabled;
    showStatusMessage('Failed to save setting', 'error');
  }
}

function updateSettingsUI(settings) {
  elements.autoSendToggle.checked = settings.autoSendEnabled;
  elements.autoSendToggle.setAttribute('aria-checked', settings.autoSendEnabled.toString());
}

async function handleSendNext() {
  const queue = await storage.getQueue();

  if (!currentTabInfo.isSupported) {
    showStatusMessage('Navigate to a supported LLM site first', 'error');
    return;
  }

  if (queue.length === 0) {
    showStatusMessage('Queue is empty', 'info');
    return;
  }

  try {
    if (elements.sendNextBtn) elements.sendNextBtn.disabled = true;

    const response = await chrome.runtime.sendMessage({ type: MessageType.SEND_NEXT });
    if (response && response.success) {
      // Prevent overwriting the 'waiting' UI if the service worker explicitly yielded for user input
      if (!(response.data && response.data.pending)) {
        showStatusMessage('Sending next prompt...', 'info');
        updateStatusIndicator('sending_prompt');
      }
    } else {
      showStatusMessage(response?.error || 'Failed to send prompt', 'error');
    }
  } catch (error) {
    showStatusMessage('Failed to send prompt', 'error');
  } finally {
    setTimeout(() => {
      if (elements.sendNextBtn) elements.sendNextBtn.disabled = false;
    }, 1000);
  }
}

function updateSendNextButtonState(queueLength) {
  if (!elements.sendNextBtn) return;
  const shouldShow = !currentSettings.autoSendEnabled && currentTabInfo.isSupported && queueLength > 0;
  elements.sendNextBtn.style.display = shouldShow ? 'flex' : 'none';
  elements.sendNextBtn.disabled = !currentTabInfo.isSupported || queueLength === 0;
}

// =============================================================================
// Rendering Data
// =============================================================================

function renderQueue(queueData) {
  const qLen = queueData.length;
  elements.queueCount.textContent = `(${qLen})`;

  elements.clearAllBtn.disabled = qLen === 0;
  elements.saveQueueBtn.disabled = qLen === 0;

  updateSendNextButtonState(qLen);

  if (qLen === 0) {
    elements.queueEmpty.setAttribute('data-empty', 'true');
    const existingItems = elements.queueList.querySelectorAll('.queue-item');
    existingItems.forEach(item => item.remove());
    return;
  }

  elements.queueEmpty.setAttribute('data-empty', 'false');

  const queueHTML = queueData.map((item, index) => {
    const truncatedPrompt = truncateText(item.prompt, 80);
    const isFirst = index === 0;
    const isLast = index === qLen - 1;

    return `
      <div class="queue-item" data-id="${escapeHtml(item.id)}" role="listitem">
        <span class="queue-item-drag-handle" style="cursor: grab; font-size: 1.2rem; color: var(--color-text-tertiary); padding-right: 8px;" title="Drag to reorder">&#9776;</span>
        <span class="queue-item-number">${index + 1}</span>
        <div class="queue-item-content">
          <p class=\"queue-item-text\" title=\"Double-click to edit&#10;${escapeHtml(item.prompt)}\" style=\"cursor: text;\">${escapeHtml(truncatedPrompt)}</p>
        </div>
        <div class="queue-item-actions">
          <button class="btn btn-icon btn-delete" data-action="delete" title="Delete">&#10005;</button>
        </div>
      </div>
    `;
  }).join('');

  const emptyState = elements.queueEmpty;
  elements.queueList.innerHTML = queueHTML;
  elements.queueList.appendChild(emptyState);
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + '...';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// Status Messaging
// =============================================================================

function updateSiteStatus(connected, text) {
  elements.siteStatus.setAttribute('data-connected', connected.toString());
  elements.siteText.textContent = text;
}

function updateStatusIndicator(status) {
  if (!STATUS_MESSAGES[status]) return;
  elements.statusIndicator.setAttribute('data-status', status);
  elements.statusText.textContent = STATUS_MESSAGES[status];
}

let toastTimeoutId = null;

function showStatusMessage(message, type = 'info', options = {}) {
  const { duration = 2500, persist = false } = options;

  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
    toastTimeoutId = null;
  }

  elements.statusMessage.textContent = message;
  elements.statusMessage.setAttribute('data-type', type);
  elements.statusMessage.hidden = false;

  if (!persist) {
    toastTimeoutId = setTimeout(() => hideStatusMessage(), duration);
  }
}

function hideStatusMessage() {
  if (elements.statusMessage) elements.statusMessage.hidden = true;
  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
    toastTimeoutId = null;
  }
}

// =============================================================================
// Service Worker Synchronization
// =============================================================================

async function requestCurrentStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MessageType.GET_STATUS });
    if (response && response.success && response.data) {
      if (response.data.processingState) updateStatusIndicator(response.data.processingState);
      if (typeof response.data.autoSendEnabled === 'boolean') {
        currentSettings.autoSendEnabled = response.data.autoSendEnabled;
        updateSettingsUI(currentSettings);
      }
    }
  } catch (error) {
    console.debug('Could not get status from service worker:', error);
  }
}

function notifyServiceWorker(type, data = {}) {
  try {
    chrome.runtime.sendMessage({ type, payload: data }, (response) => {
      if (chrome.runtime.lastError) {
        console.debug('Service worker not available:', chrome.runtime.lastError.message);
      }
    });
  } catch (error) {
    console.debug('Error sending message to service worker:', error);
  }
}

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATE_UPDATE') {
      handleStateUpdate(message.payload);
      sendResponse({ received: true });
      return true;
    }

    switch (message.type) {
      case 'STATUS_UPDATE':
        updateStatusIndicator(message.status);
        break;
      case 'PROMPT_SENT':
      case 'SENDING_PROMPT':
      case 'QUEUE_EMPTY':
        if (message.type === 'QUEUE_EMPTY') {
          updateStatusIndicator('idle');
          showStatusMessage('Queue complete! All prompts sent.', 'success');
          currentSettings.autoSendEnabled = false;
          storage.saveSettings(currentSettings);
        } else if (message.type === 'PROMPT_SENT' || message.type === 'SENDING_PROMPT') {
          showStatusMessage('Prompt sent successfully', 'success');
        }
        break;
      case 'GENERATION_STARTED':
        updateStatusIndicator('waiting_for_response');
        showStatusMessage('LLM is generating response...', 'info');
        break;
      case 'PROCESSING_STOPPED':
        updateStatusIndicator('idle');
        if (message.reason === 'tab_navigated_away') showStatusMessage('Processing paused - tab navigated away', 'info');
        else if (message.reason === 'tab_closed') showStatusMessage('Processing stopped - tab closed', 'info');
        else if (message.reason === 'auto_send_disabled') showStatusMessage('Auto-send disabled', 'info');
        break;
      case 'PROCESSING_ERROR':
      case 'CONTENT_SCRIPT_ERROR':
      case 'ERROR':
        updateStatusIndicator('idle');
        showStatusMessage(message.error || 'An error occurred', 'error');
        break;
      case 'SITE_CONNECTED':
      case 'TAB_CHANGED':
      case 'TAB_UPDATED':
        checkCurrentTab();
        break;
    }

    sendResponse({ received: true });
    return true;
  });
}

function handleStateUpdate(payload) {
  if (!payload) return;

  switch (payload.type) {
    case 'SENDING_PROMPT':
      updateStatusIndicator('sending_prompt');
      showStatusMessage('Sending prompt...', 'info');
      break;
    case 'QUEUE_ITEM_SENT':
      showStatusMessage(`Prompt sent (${payload.remainingCount} remaining)`, 'success');
      break;
    case 'GENERATION_STARTED':
      updateStatusIndicator('waiting_for_response');
      break;
    case 'PROMPT_NEEDS_INPUT':
      updateStatusIndicator('waiting');
      showStatusMessage('Waiting for your input...', 'warning');
      renderVariableModal(payload);
      break;
    case 'QUEUE_EMPTY':
      updateStatusIndicator('idle');
      showStatusMessage('All prompts sent!', 'success');
      currentSettings.autoSendEnabled = false;
      storage.saveSettings(currentSettings);
      break;
    case 'PROCESSING_STOPPED':
      updateStatusIndicator('idle');
      break;
    case 'PROCESSING_ERROR':
      updateStatusIndicator('idle');
      showStatusMessage(payload.error || 'Processing error', 'error');
      break;
    case 'SITE_CONNECTED':
    case 'TAB_CHANGED':
    case 'TAB_UPDATED':
      checkCurrentTab();
      if (payload.status) {
        if (payload.status.processingState) updateStatusIndicator(payload.status.processingState);
        if (typeof payload.status.autoSendEnabled === 'boolean') {
          currentSettings.autoSendEnabled = payload.status.autoSendEnabled;
          updateSettingsUI(currentSettings);
        }
      }
      break;
  }
}

// =============================================================================
// Variable Injection Modal Logic
// =============================================================================

function renderVariableModal(payload) {
  const modal = getRequiredElement('#variable-modal');
  const container = getRequiredElement('#variable-inputs-container');
  const form = getRequiredElement('#variable-form');
  const cancelBtn = getRequiredElement('#cancel-variable-btn');

  if (!payload.neededPrompts || payload.neededPrompts.length === 0) return;

  container.innerHTML = payload.neededPrompts.map((p, index) => `
    <div class="prompt-group" style="margin-bottom: var(--spacing-lg); padding-bottom: var(--spacing-sm); border-bottom: ${index !== payload.neededPrompts.length - 1 ? '1px solid var(--color-border-light)' : 'none'};">
      <p class="input-hint" style="font-style: italic; color: var(--color-text-secondary); margin-bottom: var(--spacing-sm);">Snippet: "${escapeHtml(truncateText(p.prompt, 60))}"</p>
      ${p.variables.map(variable => `
        <div class="variable-input-group">
          <label for="var-${escapeHtml(p.id)}-${escapeHtml(variable)}" class="input-label" style="text-transform: capitalize;">${escapeHtml(variable)}</label>
          <input type="text" id="var-${escapeHtml(p.id)}-${escapeHtml(variable)}" name="${escapeHtml(p.id)}::${escapeHtml(variable)}" class="prompt-input" required autocomplete="off" style="min-height: 36px; padding: var(--spacing-sm) var(--spacing-md);">
        </div>
      `).join('')}
    </div>
  `).join('');

  modal.hidden = false;
  const firstInput = container.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 50);

  form.onsubmit = (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const structuredVariables = {};
    
    for (const [key, value] of formData.entries()) {
      const[promptId, varName] = key.split('::');
      if (!structuredVariables[promptId]) structuredVariables[promptId] = {};
      structuredVariables[promptId][varName] = value;
    }
    
    modal.hidden = true;
    notifyServiceWorker('SUBMIT_VARIABLES', { variables: structuredVariables });
    showStatusMessage('Compiling prompt and resuming...', 'info');
  };

  cancelBtn.onclick = () => {
    modal.hidden = true;
    if (elements.autoSendToggle.checked) {
      elements.autoSendToggle.checked = false;
      handleToggleChange();
    }
    showStatusMessage('Queue paused.', 'warning');
  };
}


// =============================================================================
// Inline Edit Mode Logic
// =============================================================================

async function handleQueueItemDoubleClick(e) {
  const textEl = e.target.closest('.queue-item-text');
  if (!textEl) return;

  const itemEl = textEl.closest('.queue-item');
  const itemId = itemEl.dataset.id;

  // Fetch the fresh, un-truncated prompt from the SSOT storage
  const queue = await storage.getQueue();
  const itemIndex = queue.findIndex(i => i.id === itemId);
  if (itemIndex === -1) return;
  const item = queue[itemIndex];

  // Create dynamic textarea
  const textarea = document.createElement('textarea');
  textarea.className = 'queue-item-edit-input';
  textarea.value = item.prompt;

  // Swap DOM elements
  textEl.style.display = 'none';
  textEl.parentNode.insertBefore(textarea, textEl.nextSibling);
  
  // Focus and move cursor to end
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  let isSaving = false;

  const saveEdit = async () => {
    if (isSaving) return;
    isSaving = true;

    const newText = textarea.value.trim();
    if (newText && newText !== item.prompt) {
      // Re-extract variables in case the user added or removed placeholders
      const extractedVariables = [...newText.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1].trim());
      const uniqueVariables =[...new Set(extractedVariables)];

      queue[itemIndex].prompt = newText;
      queue[itemIndex].variables = uniqueVariables;

      // Persisting to storage automatically triggers the reactive re-render
      await storage.updateQueue(queue);
      showStatusMessage('Prompt updated', 'success');
    } else {
      // No changes made or empty input, manually re-render to destroy textarea
      renderQueue(queue);
    }
  };

  // Commit changes on loss of focus
  textarea.addEventListener('blur', saveEdit);

  // Commit on Ctrl+Enter, Cancel on Escape
  textarea.addEventListener('keydown', (evt) => {
    if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
      evt.preventDefault();
      textarea.blur(); // Forces save Edit
    }
    if (evt.key === 'Escape') {
      isSaving = true;
      renderQueue(queue); // Revert to original UI
    }
  });
}
