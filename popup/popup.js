/**
 * LLM Prompt Queue - Popup Script
 * Handles all popup UI interactions, queue management, and communication with service worker
 */

// =============================================================================
// Constants
// =============================================================================

const SUPPORTED_SITES = [
  { hostname: 'chatgpt.com', name: 'ChatGPT' },
  { hostname: 'chat.openai.com', name: 'ChatGPT' },
  { hostname: 'claude.ai', name: 'Claude' },
  { hostname: 'gemini.google.com', name: 'Gemini' },
  { hostname: 'aistudio.google.com', name: 'AI Studio' }
];

const STORAGE_KEYS = {
  QUEUE: 'promptQueue',
  SETTINGS: 'settings'
};

/**
 * Message types for communication with service worker
 * Must match service-worker.js PopupMessageType
 */
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

// =============================================================================
// Storage Functions (inline implementation for chrome.storage)
// =============================================================================

const storage = {
  /**
   * Get the current queue from storage
   * @returns {Promise<Array>} Array of queue items
   */
  async getQueue() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
      return result[STORAGE_KEYS.QUEUE] || [];
    } catch (error) {
      console.error('Error getting queue:', error);
      return [];
    }
  },

  /**
   * Save the queue to storage
   * @param {Array} queue - Array of queue items
   * @returns {Promise<void>}
   */
  async saveQueue(queue) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queue });
    } catch (error) {
      console.error('Error saving queue:', error);
      throw error;
    }
  },

  /**
   * Add a new item to the queue
   * @param {string} prompt - The prompt text
   * @returns {Promise<Object>} The newly created queue item
   */
  async addToQueue(prompt) {
    const queue = await this.getQueue();
    const newItem = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      prompt: prompt.trim(),
      createdAt: Date.now()
    };
    queue.push(newItem);
    await this.saveQueue(queue);
    return newItem;
  },

  /**
   * Remove an item from the queue by ID
   * @param {string} id - The item ID to remove
   * @returns {Promise<void>}
   */
  async removeFromQueue(id) {
    const queue = await this.getQueue();
    const filteredQueue = queue.filter(item => item.id !== id);
    await this.saveQueue(filteredQueue);
  },

  /**
   * Clear all items from the queue
   * @returns {Promise<void>}
   */
  async clearQueue() {
    await this.saveQueue([]);
  },

  /**
   * Get settings from storage
   * @returns {Promise<Object>} Settings object
   */
  async getSettings() {
    try {
      // Read autoSendEnabled directly to match service-worker.js
      const result = await chrome.storage.local.get('autoSendEnabled');
      return { autoSendEnabled: result.autoSendEnabled || false };
    } catch (error) {
      console.error('Error getting settings:', error);
      return { autoSendEnabled: false };
    }
  },

  /**
   * Save settings to storage
   * @param {Object} settings - Settings object
   * @returns {Promise<void>}
   */
  async saveSettings(settings) {
    try {
      // Save autoSendEnabled directly to match service-worker.js
      await chrome.storage.local.set({ autoSendEnabled: settings.autoSendEnabled });
    } catch (error) {
      console.error('Error saving settings:', error);
      throw error;
    }
  }
};

// =============================================================================
// DOM Elements
// =============================================================================

const elements = {
  statusIndicator: null,
  statusText: null,
  siteStatus: null,
  siteText: null,
  promptInput: null,
  addToQueueBtn: null,
  autoSendToggle: null,
  sendNextBtn: null,
  queueList: null,
  queueCount: null,
  queueEmpty: null,
  clearAllBtn: null,
  statusMessage: null
};

// =============================================================================
// State
// =============================================================================

let currentQueue = [];
let currentSettings = { autoSendEnabled: false };
let currentTabInfo = { url: null, isSupported: false, siteName: null };

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the popup when DOM is ready
 */
document.addEventListener('DOMContentLoaded', async () => {
  initializeElements();
  attachEventListeners();
  await loadInitialState();
  await checkCurrentTab();
  setupMessageListener();
});

/**
 * Cache DOM element references
 */
function initializeElements() {
  elements.statusIndicator = document.querySelector('.status-indicator');
  elements.statusText = document.querySelector('.status-text');
  elements.siteStatus = document.querySelector('.site-status');
  elements.siteText = document.querySelector('.site-text');
  elements.promptInput = document.getElementById('prompt-input');
  elements.addToQueueBtn = document.getElementById('add-to-queue-btn');
  elements.autoSendToggle = document.getElementById('auto-send-toggle');
  elements.sendNextBtn = document.getElementById('send-next-btn');
  elements.queueList = document.getElementById('queue-list');
  elements.queueCount = document.getElementById('queue-count');
  elements.queueEmpty = document.querySelector('.queue-empty');
  elements.clearAllBtn = document.getElementById('clear-all-btn');
  elements.statusMessage = document.getElementById('status-message');
}

/**
 * Attach event listeners to interactive elements
 */
function attachEventListeners() {
  // Add to queue button
  elements.addToQueueBtn.addEventListener('click', handleAddToQueue);

  // Keyboard shortcut for adding (Ctrl/Cmd + Enter)
  elements.promptInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleAddToQueue();
    }
  });

  // Auto-send toggle
  elements.autoSendToggle.addEventListener('change', handleToggleChange);

  // Send Next button (manual trigger when auto-send is OFF)
  if (elements.sendNextBtn) {
    elements.sendNextBtn.addEventListener('click', handleSendNext);
  }

  // Clear all button
  elements.clearAllBtn.addEventListener('click', handleClearAll);

  // Event delegation for queue item actions
  elements.queueList.addEventListener('click', handleQueueItemAction);
}

/**
 * Load initial state from storage
 */
async function loadInitialState() {
  try {
    // Load queue and settings in parallel
    const [queue, settings] = await Promise.all([
      storage.getQueue(),
      storage.getSettings()
    ]);

    currentQueue = queue;
    currentSettings = settings;

    // Update UI
    renderQueue();
    elements.autoSendToggle.checked = currentSettings.autoSendEnabled;
    elements.autoSendToggle.setAttribute('aria-checked', currentSettings.autoSendEnabled.toString());
  } catch (error) {
    console.error('Error loading initial state:', error);
    showStatusMessage('Failed to load data', 'error');
  }
}

// =============================================================================
// Tab Detection
// =============================================================================

/**
 * Check the current tab and determine if it's a supported LLM site
 */
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
      currentTabInfo = {
        url: tab.url,
        isSupported: true,
        siteName: supportedSite.name
      };
      updateSiteStatus(true, `Connected to: ${supportedSite.name}`);
    } else {
      currentTabInfo = {
        url: tab.url,
        isSupported: false,
        siteName: null
      };
      updateSiteStatus(false, 'Not on supported site');
    }

    // Update Send Next button state based on tab support
    updateSendNextButtonState();

    // Request current status from service worker
    requestCurrentStatus();
  } catch (error) {
    console.error('Error checking current tab:', error);
    updateSiteStatus(false, 'Cannot detect current site');
  }
}

/**
 * Request current status from service worker
 */
async function requestCurrentStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.GET_STATUS
    });

    if (response && response.success && response.data) {
      updateFromStatus(response.data);
    }
  } catch (error) {
    console.debug('Could not get status from service worker:', error);
  }
}

/**
 * Update the site connection status display
 * @param {boolean} connected - Whether connected to a supported site
 * @param {string} text - Status text to display
 */
function updateSiteStatus(connected, text) {
  elements.siteStatus.setAttribute('data-connected', connected.toString());
  elements.siteText.textContent = text;
}

// =============================================================================
// Queue Management
// =============================================================================

/**
 * Handle adding a new prompt to the queue
 */
async function handleAddToQueue() {
  const promptText = elements.promptInput.value.trim();

  // Validate input
  if (!promptText) {
    showStatusMessage('Please enter a prompt', 'error');
    elements.promptInput.focus();
    return;
  }

  try {
    // Disable button during operation
    elements.addToQueueBtn.disabled = true;

    // Add to storage
    const newItem = await storage.addToQueue(promptText);
    currentQueue.push(newItem);

    // Update UI
    renderQueue();
    elements.promptInput.value = '';
    elements.promptInput.focus();

    // Notify service worker
    notifyServiceWorker(MessageType.QUEUE_UPDATED, { queue: currentQueue });

    showStatusMessage('Prompt added to queue', 'success');
  } catch (error) {
    console.error('Error adding to queue:', error);
    showStatusMessage('Failed to add prompt', 'error');
  } finally {
    elements.addToQueueBtn.disabled = false;
  }
}

/**
 * Handle queue item actions (delete, reorder)
 * @param {Event} e - Click event
 */
async function handleQueueItemAction(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const itemId = target.closest('.queue-item')?.dataset.id;

  if (!itemId) return;

  switch (action) {
    case 'delete':
      await handleDeleteItem(itemId);
      break;
    case 'move-up':
      await handleReorderItem(itemId, -1);
      break;
    case 'move-down':
      await handleReorderItem(itemId, 1);
      break;
  }
}

/**
 * Delete an item from the queue
 * @param {string} id - Item ID to delete
 */
async function handleDeleteItem(id) {
  try {
    // Find the item element for animation
    const itemElement = document.querySelector(`.queue-item[data-id="${id}"]`);

    if (itemElement) {
      // Add leaving animation
      itemElement.classList.add('leaving');

      // Wait for animation to complete
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Remove from storage
    await storage.removeFromQueue(id);
    currentQueue = currentQueue.filter(item => item.id !== id);

    // Update UI
    renderQueue();

    // Notify service worker
    notifyServiceWorker(MessageType.QUEUE_UPDATED, { queue: currentQueue });
  } catch (error) {
    console.error('Error deleting item:', error);
    showStatusMessage('Failed to delete item', 'error');
  }
}

/**
 * Reorder an item in the queue
 * @param {string} id - Item ID to move
 * @param {number} direction - -1 for up, 1 for down
 */
async function handleReorderItem(id, direction) {
  const currentIndex = currentQueue.findIndex(item => item.id === id);

  if (currentIndex === -1) return;

  const newIndex = currentIndex + direction;

  // Check bounds
  if (newIndex < 0 || newIndex >= currentQueue.length) return;

  try {
    // Swap items
    [currentQueue[currentIndex], currentQueue[newIndex]] =
    [currentQueue[newIndex], currentQueue[currentIndex]];

    // Save to storage
    await storage.saveQueue(currentQueue);

    // Update UI
    renderQueue();

    // Notify service worker
    notifyServiceWorker(MessageType.QUEUE_UPDATED, { queue: currentQueue });
  } catch (error) {
    console.error('Error reordering item:', error);
    showStatusMessage('Failed to reorder item', 'error');
  }
}

/**
 * Handle clearing all items from the queue
 */
async function handleClearAll() {
  if (currentQueue.length === 0) return;

  // Confirm action
  const confirmed = confirm('Are you sure you want to clear all prompts from the queue?');

  if (!confirmed) return;

  try {
    await storage.clearQueue();
    currentQueue = [];

    // Update UI
    renderQueue();

    // Notify service worker
    notifyServiceWorker(MessageType.QUEUE_UPDATED, { queue: currentQueue });

    showStatusMessage('Queue cleared', 'success');
  } catch (error) {
    console.error('Error clearing queue:', error);
    showStatusMessage('Failed to clear queue', 'error');
  }
}

// =============================================================================
// Settings Management
// =============================================================================

/**
 * Handle toggle switch state change
 */
async function handleToggleChange() {
  const isEnabled = elements.autoSendToggle.checked;

  try {
    currentSettings.autoSendEnabled = isEnabled;
    await storage.saveSettings(currentSettings);

    // Update ARIA attribute
    elements.autoSendToggle.setAttribute('aria-checked', isEnabled.toString());

    // Update Send Next button visibility
    updateSendNextButtonState();

    // Notify service worker using correct message type
    notifyServiceWorker(MessageType.TOGGLE_AUTO_SEND, { enabled: isEnabled });

    showStatusMessage(
      isEnabled ? 'Auto-send enabled' : 'Auto-send disabled',
      'info'
    );
  } catch (error) {
    console.error('Error saving settings:', error);
    // Revert toggle on error
    elements.autoSendToggle.checked = !isEnabled;
    showStatusMessage('Failed to save setting', 'error');
  }
}

/**
 * Handle Send Next button click (manual trigger)
 */
async function handleSendNext() {
  if (!currentTabInfo.isSupported) {
    showStatusMessage('Navigate to a supported LLM site first', 'error');
    return;
  }

  if (currentQueue.length === 0) {
    showStatusMessage('Queue is empty', 'info');
    return;
  }

  try {
    // Disable button during operation
    if (elements.sendNextBtn) {
      elements.sendNextBtn.disabled = true;
    }

    // Send the SEND_NEXT message to service worker
    const response = await chrome.runtime.sendMessage({
      type: MessageType.SEND_NEXT
    });

    if (response && response.success) {
      showStatusMessage('Sending next prompt...', 'info');
      updateStatusIndicator('sending_prompt');
    } else {
      showStatusMessage(response?.error || 'Failed to send prompt', 'error');
    }
  } catch (error) {
    console.error('Error sending next prompt:', error);
    showStatusMessage('Failed to send prompt', 'error');
  } finally {
    // Re-enable after a short delay to prevent rapid clicks
    setTimeout(() => {
      if (elements.sendNextBtn) {
        elements.sendNextBtn.disabled = false;
      }
    }, 1000);
  }
}

/**
 * Update Send Next button visibility based on auto-send state
 */
function updateSendNextButtonState() {
  if (!elements.sendNextBtn) return;

  const shouldShow = !currentSettings.autoSendEnabled &&
                     currentTabInfo.isSupported &&
                     currentQueue.length > 0;

  elements.sendNextBtn.style.display = shouldShow ? 'flex' : 'none';
  elements.sendNextBtn.disabled = !currentTabInfo.isSupported || currentQueue.length === 0;
}

// =============================================================================
// Rendering
// =============================================================================

/**
 * Render the queue list
 */
function renderQueue() {
  // Update count
  elements.queueCount.textContent = `(${currentQueue.length})`;

  // Update clear all button state
  elements.clearAllBtn.disabled = currentQueue.length === 0;

  // Update Send Next button state
  updateSendNextButtonState();

  // Show/hide empty state
  if (currentQueue.length === 0) {
    elements.queueEmpty.setAttribute('data-empty', 'true');
    // Remove any existing queue items
    const existingItems = elements.queueList.querySelectorAll('.queue-item');
    existingItems.forEach(item => item.remove());
    return;
  }

  elements.queueEmpty.setAttribute('data-empty', 'false');

  // Build queue items HTML
  const queueHTML = currentQueue.map((item, index) => {
    const truncatedPrompt = truncateText(item.prompt, 80);
    const isFirst = index === 0;
    const isLast = index === currentQueue.length - 1;

    return `
      <div class="queue-item entering" data-id="${escapeHtml(item.id)}" role="listitem">
        <span class="queue-item-number">${index + 1}</span>
        <div class="queue-item-content">
          <p class="queue-item-text" title="${escapeHtml(item.prompt)}">${escapeHtml(truncatedPrompt)}</p>
        </div>
        <div class="queue-item-actions">
          <div class="queue-item-reorder">
            <button
              class="btn btn-icon btn-reorder"
              data-action="move-up"
              title="Move up"
              ${isFirst ? 'disabled' : ''}
              aria-label="Move item up"
            >&#9650;</button>
            <button
              class="btn btn-icon btn-reorder"
              data-action="move-down"
              title="Move down"
              ${isLast ? 'disabled' : ''}
              aria-label="Move item down"
            >&#9660;</button>
          </div>
          <button
            class="btn btn-icon btn-delete"
            data-action="delete"
            title="Delete"
            aria-label="Delete item"
          >&#10005;</button>
        </div>
      </div>
    `;
  }).join('');

  // Keep empty state element, replace rest
  const emptyState = elements.queueEmpty;
  elements.queueList.innerHTML = queueHTML;
  elements.queueList.appendChild(emptyState);

  // Remove entering class after animation
  requestAnimationFrame(() => {
    const items = elements.queueList.querySelectorAll('.queue-item.entering');
    items.forEach(item => {
      setTimeout(() => item.classList.remove('entering'), 300);
    });
  });
}

/**
 * Truncate text to specified length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length before truncation
 * @returns {string} Truncated text
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + '...';
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// Status Updates
// =============================================================================

/**
 * Update the status indicator
 * @param {string} status - Status key (idle, waiting, sending, active)
 */
function updateStatusIndicator(status) {
  if (!STATUS_MESSAGES[status]) return;

  elements.statusIndicator.setAttribute('data-status', status);
  elements.statusText.textContent = STATUS_MESSAGES[status];
}

/** @type {number|null} Current toast timeout ID */
let toastTimeoutId = null;

/** @type {number} Toast display count for debouncing */
let toastCount = 0;

/**
 * Show a temporary status message toast
 * Supports queueing and debouncing of rapid messages
 *
 * @param {string} message - Message to display
 * @param {string} type - Message type (success, error, info, warning)
 * @param {Object} options - Additional options
 * @param {number} options.duration - Display duration in ms (default: 2500)
 * @param {boolean} options.persist - If true, don't auto-hide (default: false)
 */
function showStatusMessage(message, type = 'info', options = {}) {
  const { duration = 2500, persist = false } = options;

  // Clear any existing timeout
  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
    toastTimeoutId = null;
  }

  // Update toast content
  elements.statusMessage.textContent = message;
  elements.statusMessage.setAttribute('data-type', type);
  elements.statusMessage.hidden = false;

  // Track toast count for debugging
  toastCount++;
  console.debug(`[PromptQueue Popup] Toast ${toastCount}: ${type} - ${message}`);

  // Auto-hide after delay unless persist is true
  if (!persist) {
    toastTimeoutId = setTimeout(() => {
      hideStatusMessage();
    }, duration);
  }
}

/**
 * Hide the status message toast
 */
function hideStatusMessage() {
  if (elements.statusMessage) {
    elements.statusMessage.hidden = true;
  }
  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
    toastTimeoutId = null;
  }
}

/**
 * Show a progress notification (for long operations)
 * @param {string} message - Message to display
 */
function showProgressMessage(message) {
  showStatusMessage(message, 'info', { persist: true });
}

/**
 * Show queue completion notification
 * @param {number} sentCount - Number of prompts sent
 */
function showQueueCompleteNotification(sentCount = 0) {
  const message = sentCount > 0
    ? `Queue complete! ${sentCount} prompt${sentCount !== 1 ? 's' : ''} sent.`
    : 'Queue complete!';
  showStatusMessage(message, 'success', { duration: 4000 });
}

/**
 * Show error notification with optional retry hint
 * @param {string} message - Error message
 * @param {boolean} isRetryable - If true, hint that retry is possible
 */
function showErrorNotification(message, isRetryable = false) {
  const fullMessage = isRetryable
    ? `${message} (will retry...)`
    : message;
  showStatusMessage(fullMessage, 'error', { duration: isRetryable ? 2000 : 4000 });
}

// =============================================================================
// Service Worker Communication
// =============================================================================

/**
 * Set up listener for messages from service worker
 */
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.debug('[PromptQueue Popup] Received message:', message);

    // Handle STATE_UPDATE messages from service worker
    if (message.type === 'STATE_UPDATE') {
      handleStateUpdate(message.payload);
      sendResponse({ received: true });
      return true;
    }

    switch (message.type) {
      case 'STATUS_UPDATE':
        updateStatusIndicator(message.status);
        break;

      case 'QUEUE_CHANGED':
      case 'QUEUE_ITEM_SENT':
        // Reload queue from storage if changed externally
        loadQueueFromStorage();
        break;

      case 'PROMPT_SENT':
      case 'SENDING_PROMPT':
        showStatusMessage('Prompt sent successfully', 'success');
        loadQueueFromStorage();
        break;

      case 'GENERATION_STARTED':
        updateStatusIndicator('waiting_for_response');
        showStatusMessage('LLM is generating response...', 'info');
        break;

      case 'QUEUE_EMPTY':
        updateStatusIndicator('idle');
        showStatusMessage('Queue complete! All prompts sent.', 'success');
        loadQueueFromStorage();
        // Auto-send is disabled when queue is empty
        currentSettings.autoSendEnabled = false;
        elements.autoSendToggle.checked = false;
        updateSendNextButtonState();
        break;

      case 'PROCESSING_STOPPED':
        updateStatusIndicator('idle');
        if (message.reason === 'tab_navigated_away') {
          showStatusMessage('Processing paused - tab navigated away', 'info');
        } else if (message.reason === 'tab_closed') {
          showStatusMessage('Processing stopped - tab closed', 'info');
        } else if (message.reason === 'auto_send_disabled') {
          showStatusMessage('Auto-send disabled', 'info');
        }
        break;

      case 'PROCESSING_ERROR':
      case 'CONTENT_SCRIPT_ERROR':
        updateStatusIndicator('idle');
        showStatusMessage(message.error || 'An error occurred', 'error');
        break;

      case 'SITE_CONNECTED':
        checkCurrentTab();
        break;

      case 'TAB_CHANGED':
      case 'TAB_UPDATED':
        checkCurrentTab();
        break;

      case 'ERROR':
        showStatusMessage(message.error || 'An error occurred', 'error');
        break;
    }

    // Acknowledge receipt
    sendResponse({ received: true });
    return true;
  });
}

/**
 * Handle STATE_UPDATE payload from service worker
 * @param {Object} payload - State update payload
 */
function handleStateUpdate(payload) {
  if (!payload) return;

  switch (payload.type) {
    case 'SENDING_PROMPT':
      updateStatusIndicator('sending_prompt');
      showStatusMessage('Sending prompt...', 'info');
      break;

    case 'QUEUE_ITEM_SENT':
      showStatusMessage(`Prompt sent (${payload.remainingCount} remaining)`, 'success');
      loadQueueFromStorage();
      break;

    case 'GENERATION_STARTED':
      updateStatusIndicator('waiting_for_response');
      break;

    case 'QUEUE_EMPTY':
      updateStatusIndicator('idle');
      showStatusMessage('All prompts sent!', 'success');
      loadQueueFromStorage();
      // Auto-send is disabled when queue is empty
      currentSettings.autoSendEnabled = false;
      elements.autoSendToggle.checked = false;
      updateSendNextButtonState();
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
        updateFromStatus(payload.status);
      }
      break;

    default:
      console.debug('[PromptQueue Popup] Unhandled state update:', payload.type);
  }
}

/**
 * Update UI from status object
 * @param {Object} status - Status object from service worker
 */
function updateFromStatus(status) {
  if (status.processingState) {
    updateStatusIndicator(status.processingState);
  }
  if (typeof status.autoSendEnabled === 'boolean') {
    currentSettings.autoSendEnabled = status.autoSendEnabled;
    elements.autoSendToggle.checked = status.autoSendEnabled;
    updateSendNextButtonState();
  }
}

/**
 * Send a message to the service worker
 * @param {string} type - Message type
 * @param {Object} data - Message payload
 */
function notifyServiceWorker(type, data = {}) {
  try {
    // Wrap data in payload to match service worker's expected format
    chrome.runtime.sendMessage({ type, payload: data }, (response) => {
      if (chrome.runtime.lastError) {
        // Service worker might not be available, log but don't show error to user
        console.debug('Service worker not available:', chrome.runtime.lastError.message);
      }
    });
  } catch (error) {
    console.debug('Error sending message to service worker:', error);
  }
}

/**
 * Reload queue from storage (for external updates)
 */
async function loadQueueFromStorage() {
  try {
    currentQueue = await storage.getQueue();
    renderQueue();
  } catch (error) {
    console.error('Error reloading queue:', error);
  }
}

// =============================================================================
// Cleanup
// =============================================================================

/**
 * Clean up when popup closes
 */
window.addEventListener('unload', () => {
  // Any cleanup needed when popup closes
});
