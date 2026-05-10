/**
 * LLM Prompt Queue - Service Worker (Background Script)
 *
 * Central coordination hub for the Chrome extension that manages:
 * - State management for queue processing
 * - Message routing between popup and content scripts
 * - Queue processing coordination
 * - Tab tracking for supported LLM sites
 *
 * @version 1.0.0
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Supported LLM site configurations
 * Maps URL patterns to site identifiers
 */
const SUPPORTED_SITES = {
  'chat.openai.com': 'chatgpt',
  'chatgpt.com': 'chatgpt',
  'claude.ai': 'claude',
  'gemini.google.com': 'gemini',
  'aistudio.google.com': 'aistudio'
};

/**
 * Processing states for the queue coordinator
 */
const ProcessingState = {
  IDLE: 'idle',
  WAITING_FOR_RESPONSE: 'waiting_for_response',
  SENDING_PROMPT: 'sending_prompt',
  AWAITING_USER_INPUT: 'awaiting_user_input',
  PAUSED_FOR_ERROR: 'paused_for_error'
};

/**
 * Message types from popup
 */
const PopupMessageType = {
  GET_STATUS: 'GET_STATUS',
  QUEUE_UPDATED: 'QUEUE_UPDATED',
  TOGGLE_AUTO_SEND: 'TOGGLE_AUTO_SEND',
  START_PROCESSING: 'START_PROCESSING',
  SEND_NEXT: 'SEND_NEXT'
};

/**
 * Message types from content scripts
 */
const ContentMessageType = {
  GENERATION_COMPLETE: 'GENERATION_COMPLETE',
  GENERATION_STARTED: 'GENERATION_STARTED',
  SITE_READY: 'SITE_READY',
  ERROR: 'ERROR'
};

/**
 * Message types sent to content scripts
 */
const OutgoingMessageType = {
  INJECT_PROMPT: 'INJECT_PROMPT'
};

/**
 * Storage keys
 */
const StorageKey = {
  QUEUE: 'promptQueue',
  AUTO_SEND: 'autoSendEnabled',
  SETTINGS: 'settings'
};

/**
 * Logging levels
 */
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// =============================================================================
// LOGGER
// =============================================================================

/**
 * Logger utility with configurable log levels
 */
class Logger {
  constructor(prefix = '[PromptQueue]', level = LogLevel.DEBUG) {
    this.prefix = prefix;
    this.level = level;
  }

  /**
   * Set the logging level
   * @param {number} level - Log level from LogLevel enum
   */
  setLevel(level) {
    this.level = level;
  }

  /**
   * Format a log message with timestamp
   * @param {string} levelStr - Level string
   * @param {...any} args - Arguments to log
   * @returns {string[]} Formatted message parts
   */
  _format(levelStr, ...args) {
    const timestamp = new Date().toISOString();
    return [`${this.prefix} [${timestamp}] [${levelStr}]`, ...args];
  }

  debug(...args) {
    if (this.level <= LogLevel.DEBUG) {
      console.log(...this._format('DEBUG', ...args));
    }
  }

  info(...args) {
    if (this.level <= LogLevel.INFO) {
      console.info(...this._format('INFO', ...args));
    }
  }

  warn(...args) {
    if (this.level <= LogLevel.WARN) {
      console.warn(...this._format('WARN', ...args));
    }
  }

  error(...args) {
    if (this.level <= LogLevel.ERROR) {
      console.error(...this._format('ERROR', ...args));
    }
  }
}

const logger = new Logger();

// =============================================================================
// STATE MANAGER
// =============================================================================

/**
 * Centralized state management with persistence and reactive updates
 */
class StateManager {
  constructor() {
    /** @type {Map<string, any>} In-memory state cache */
    this._state = new Map();

    /** @type {Map<string, Set<Function>>} Subscribers for state changes */
    this._subscribers = new Map();

    /** @type {Set<string>} Keys pending persistence */
    this._pendingPersist = new Set();

    /** @type {number|null} Debounce timer for batch persistence */
    this._persistTimer = null;

    /** @type {number} Debounce delay in ms */
    this._persistDelay = 100;
  }

  /**
   * Initialize state from storage
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      const stored = await chrome.storage.local.get(null);

      // Load persisted values into memory
      for (const [key, value] of Object.entries(stored)) {
        this._state.set(key, value);
      }

      // Unify Settings Data Model: Map popup's settings object to background state
      if (stored.settings && typeof stored.settings.autoSendEnabled === 'boolean') {
        this._state.set('autoSendEnabled', stored.settings.autoSendEnabled, false);
      }

      // Set defaults for required state
      if (!this._state.has('processingState')) {
        this._state.set('processingState', ProcessingState.IDLE);
      }
      if (!this._state.has('currentTabId')) {
        this._state.set('currentTabId', null);
      }
      if (!this._state.has('autoSendEnabled')) {
        this._state.set('autoSendEnabled', false);
      }
      if (!this._state.has('promptQueue')) {
        this._state.set('promptQueue', []);
      }
      if (!this._state.has('tabSiteMap')) {
        this._state.set('tabSiteMap', {});
      }
      if (!this._state.has('runtimeVariables')) {
        this._state.set('runtimeVariables', {});
      }
      if (!this._state.has('runtimeVariables')) {
        this._state.set('runtimeVariables', {});
      }

      logger.info('State initialized', Object.fromEntries(this._state));
    } catch (error) {
      logger.error('Failed to initialize state from storage:', error);
      throw error;
    }
  }

  /**
   * Get a state value
   * @param {string} key - State key
   * @returns {any} State value
   */
  get(key) {
    return this._state.get(key);
  }

  /**
   * Set a state value with optional persistence
   * @param {string} key - State key
   * @param {any} value - State value
   * @param {boolean} persist - Whether to persist to storage
   */
  set(key, value, persist = true) {
    const oldValue = this._state.get(key);
    this._state.set(key, value);

    logger.debug(`State updated: ${key}`, { oldValue, newValue: value });

    // Notify subscribers
    this._notifySubscribers(key, value, oldValue);

    // Schedule persistence
    if (persist) {
      this._schedulePersist(key);
    }
  }

  /**
   * Subscribe to state changes for a key
   * @param {string} key - State key to watch
   * @param {Function} callback - Callback function (newValue, oldValue)
   * @returns {Function} Unsubscribe function
   */
  subscribe(key, callback) {
    if (!this._subscribers.has(key)) {
      this._subscribers.set(key, new Set());
    }
    this._subscribers.get(key).add(callback);

    return () => {
      this._subscribers.get(key)?.delete(callback);
    };
  }

  /**
   * Notify subscribers of state change
   * @param {string} key - Changed key
   * @param {any} newValue - New value
   * @param {any} oldValue - Previous value
   * @private
   */
  _notifySubscribers(key, newValue, oldValue) {
    const subscribers = this._subscribers.get(key);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(newValue, oldValue);
        } catch (error) {
          logger.error(`Subscriber error for key ${key}:`, error);
        }
      }
    }
  }

  /**
   * Schedule batched persistence
   * @param {string} key - Key to persist
   * @private
   */
  _schedulePersist(key) {
    this._pendingPersist.add(key);

    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
    }

    this._persistTimer = setTimeout(() => this._persist(), this._persistDelay);
  }

  /**
   * Persist pending state to storage
   * @private
   */
  async _persist() {
    if (this._pendingPersist.size === 0) return;

    const toStore = {};
    for (const key of this._pendingPersist) {
      toStore[key] = this._state.get(key);
    }

    try {
      await chrome.storage.local.set(toStore);
      logger.debug('State persisted:', Object.keys(toStore));
      this._pendingPersist.clear();
    } catch (error) {
      logger.error('Failed to persist state:', error);
    }
  }

  /**
   * Get all state as an object (for debugging)
   * @returns {Object}
   */
  getAll() {
    return Object.fromEntries(this._state);
  }
}

const stateManager = new StateManager();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Extract site type from URL
 * @param {string} url - Full URL to check
 * @returns {string|null} Site type identifier or null if not supported
 */
function getSiteFromUrl(url) {
  if (!url) return null;

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Check each supported site
    for (const [pattern, siteType] of Object.entries(SUPPORTED_SITES)) {
      if (hostname === pattern || hostname.endsWith('.' + pattern)) {
        return siteType;
      }
    }

    return null;
  } catch (error) {
    logger.warn('Invalid URL:', url);
    return null;
  }
}

/**
 * Check if a tab is on a supported site
 * @param {number} tabId - Tab ID to check
 * @returns {Promise<boolean>} True if tab is on supported site
 */
async function isTabSupported(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return getSiteFromUrl(tab.url) !== null;
  } catch (error) {
    logger.warn(`Could not check tab ${tabId}:`, error);
    return false;
  }
}

/**
 * Wake up a background tab to ensure content script is responsive
 * Chrome throttles inactive tabs, so we need to "ping" them first
 * @param {number} tabId - Tab ID to wake up
 */
async function wakeUpTab(tabId) {
  try {
    // Execute a minimal script to wake up the tab's JavaScript context
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // This empty function execution wakes up the tab
        return true;
      }
    });
    logger.debug(`Tab ${tabId} woken up`);
  } catch (error) {
    // Tab might not be accessible (e.g., chrome:// pages), ignore
    logger.debug(`Could not wake up tab ${tabId}:`, error.message);
  }
}

/**
 * Send a message to a content script in a specific tab
 * Includes wake-up mechanism for background tabs
 * @param {number} tabId - Target tab ID
 * @param {Object} message - Message to send
 * @returns {Promise<any>} Response from content script
 */
async function sendToContentScript(tabId, message) {
  try {
    logger.debug(`Sending to content script (tab ${tabId}):`, message);

    // Wake up the tab first to combat Chrome's background tab throttling
    await wakeUpTab(tabId);

    // Small delay to let the tab's JS context fully wake up
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await chrome.tabs.sendMessage(tabId, {
      ...message,
      source: 'background',
      timestamp: Date.now()
    });

    logger.debug(`Response from content script (tab ${tabId}):`, response);
    return response;
  } catch (error) {
      if (error.message && error.message.includes('Receiving end does not exist')) {
        logger.debug(`Could not establish connection to tab ${tabId} (Content script not ready)`);
      } else {
        logger.error(`Failed to send message to tab ${tabId}:`, error);
      }
      throw error;
  }
}

/**
 * Notify popup of state changes
 * @param {Object} data - Data to send to popup
 */
async function notifyPopup(data) {
  try {
    await chrome.runtime.sendMessage({
      type: 'STATE_UPDATE',
      payload: data,
      source: 'background',
      timestamp: Date.now()
    });
  } catch (error) {
    // Popup may not be open, this is expected
    logger.debug('Could not notify popup (may be closed):', error.message);
  }
}

/**
 * Get current status object for popup
 * @returns {Object} Current status
 */
function getCurrentStatus() {
  const currentTabId = stateManager.get('currentTabId');
  const tabSiteMap = stateManager.get('tabSiteMap') || {};

  return {
    processingState: stateManager.get('processingState'),
    autoSendEnabled: stateManager.get('autoSendEnabled'),
    currentTabId: currentTabId,
    connectedSite: currentTabId ? tabSiteMap[currentTabId] || null : null,
    queueLength: (stateManager.get('promptQueue') || []).length
  };
}

// =============================================================================
// QUEUE PROCESSOR
// =============================================================================

/**
 * Queue processing coordinator
 * Manages the flow of prompts from queue to content scripts
 */
class QueueProcessor {
  constructor() {
    this._processing = false;
  }

  /**
   * Start processing the queue
   * Called when auto-send is enabled or manually triggered
   */
  async startProcessing() {
    if (this._processing) {
      logger.debug('Queue processing already in progress');
      return;
    }

    // Removed asynchronous storage fetch to prevent race conditions.
    // Relying strictly on the synchronous in-memory stateManager as the Single Source of Truth.

    const autoSendEnabled = stateManager.get('autoSendEnabled');
    if (!autoSendEnabled) {
      logger.debug('Auto-send is disabled, not starting processing');
      return;
    }

    const currentState = stateManager.get('processingState');
    if (currentState !== ProcessingState.IDLE) {
      logger.debug('Not in idle state, cannot start processing');
      return;
    }

    await this.processNextItem();
  }

  /**
   * Process the next item in the queue
   */
  async processNextItem() {
    logger.info('processNextItem called');

    const autoSendEnabled = stateManager.get('autoSendEnabled');
    const processingTabId = focusManager.getProcessingTab();
    const tabSiteMap = stateManager.get('tabSiteMap') || {};
    const queue = stateManager.get('promptQueue') ||[];

    if (!autoSendEnabled) {
      stateManager.set('processingState', ProcessingState.IDLE);
      focusManager.clearProcessingTab();
      notifyPopup({ type: 'PROCESSING_STOPPED', reason: 'auto_send_disabled' });
      return;
    }

    if (!processingTabId || !tabSiteMap[processingTabId]) {
      stateManager.set('processingState', ProcessingState.IDLE);
      focusManager.clearProcessingTab();
      notifyPopup({ type: 'PROCESSING_STOPPED', reason: 'unsupported_site' });
      return;
    }

    if (queue.length === 0) {
      stateManager.set('processingState', ProcessingState.IDLE);
      stateManager.set('autoSendEnabled', false);
      
      // Sync disable back to popup settings
      chrome.storage.local.get('settings').then(stored => {
        const updatedSettings = stored.settings || {};
        updatedSettings.autoSendEnabled = false;
        chrome.storage.local.set({ settings: updatedSettings });
      });
      
      stateManager.set('runtimeVariables', {}, false); // Clear context
      focusManager.clearProcessingTab();
      notifyPopup({ type: 'QUEUE_EMPTY', autoSendDisabled: true });
      return;
    }

    // BATCH SCAN: Aggregate missing variables scoping directly to prompt IDs
    const runtimeVars = stateManager.get('runtimeVariables') || {};
    const neededPrompts =[];
    
    queue.forEach(item => {
      let vars = item.variables;
      if (!vars || !Array.isArray(vars)) {
        const matches = [...item.prompt.matchAll(/\{\{([^}]+)\}\}/g)];
        vars = matches.map(match => match[1].trim());
      }
      
      if (vars && vars.length > 0) {
        const missingForThisPrompt = vars.filter(v => !runtimeVars[item.id] || !runtimeVars[item.id][v] || runtimeVars[item.id][v].trim() === '');
        if (missingForThisPrompt.length > 0) {
           neededPrompts.push({ id: item.id, prompt: item.prompt, variables: missingForThisPrompt });
        }
      }
    });

    if (neededPrompts.length > 0) {
      logger.info('Manual execution requires user input, yielding thread');
      stateManager.set('processingState', ProcessingState.AWAITING_USER_INPUT);
      stateManager.set('pendingResumeAction', 'manual', false);
      
      stateManager.set('lastNeededPrompts', neededPrompts, false);
      notifyPopup({ 
        type: 'PROMPT_NEEDS_INPUT', 
        neededPrompts: neededPrompts 
      });
      return { sent: false, pending: true };
    }

    delete queue[0].retryCount; // Purge stale retry data
    const nextItem = queue[0];
    let resolvedPromptText = nextItem.prompt;

    // EPHEMERAL COMPILATION
    let varsToCompile = nextItem.variables;
    if (!varsToCompile || !Array.isArray(varsToCompile)) {
      const matches =[...nextItem.prompt.matchAll(/\{\{([^}]+)\}\}/g)];
      varsToCompile = matches.map(match => match[1].trim());
    }

    if (varsToCompile && varsToCompile.length > 0) {
      for (const v of varsToCompile) {
        const safeKey = v.replace(/[-\/\^$*+?.()|[\]{}]/g, '\$&');
        const regex = new RegExp(`\{\{\s*${safeKey}\s*\}\}`, 'g');
        const replacementValue = (runtimeVars[nextItem.id] && runtimeVars[nextItem.id][v]) ? runtimeVars[nextItem.id][v] : '';
        resolvedPromptText = resolvedPromptText.replace(regex, replacementValue);
      }
    }

    try {
      stateManager.set('processingState', ProcessingState.SENDING_PROMPT);
      notifyPopup({ type: 'SENDING_PROMPT', prompt: { ...nextItem, prompt: resolvedPromptText } });

      const response = await sendToContentScript(processingTabId, {
        type: OutgoingMessageType.INJECT_PROMPT,
        payload: { prompt: resolvedPromptText, id: nextItem.id, formulationDelay: stateManager.get('settings')?.formulationDelay || 60000, executionDelay: stateManager.get('settings')?.executionDelay || 180000 }
      });

      if (response && response.success) {
        logger.info('Prompt injected successfully, holding in queue pending generation outcome');
        stateManager.set('processingState', ProcessingState.WAITING_FOR_RESPONSE);
        
        // Defer slicing the queue until verified completion. Pass current queue length.
        notifyPopup({ type: 'QUEUE_ITEM_SENT', item: nextItem, remainingCount: queue.length });
      } else {
        throw new Error(response?.error || 'Failed to inject prompt');
      }
    } catch (error) {
      logger.error('Error processing queue item:', error);
      stateManager.set('processingState', ProcessingState.IDLE);
      notifyPopup({ type: 'PROCESSING_ERROR', error: error.message, item: nextItem });
    }
  }

  /**
   * Handle generation complete - process next item if auto-send enabled
   */
  async onGenerationComplete(payload = {}) {
    logger.info('Generation complete, validating outcome', payload);

    const currentState = stateManager.get('processingState');
    const autoSendEnabled = stateManager.get('autoSendEnabled');

    logger.info('onGenerationComplete state:', { currentState, autoSendEnabled });

    if (currentState !== ProcessingState.WAITING_FOR_RESPONSE) {
      logger.debug('Not waiting for response, ignoring generation complete');
      return;
    }

    // Queue mutation happens ONLY on verified successful generation
    if (payload.reason === 'completed') {
      logger.info('Generation verified successful, mutating queue');
      const queue = stateManager.get('promptQueue') ||[];
      if (queue.length > 0) {
        const updatedQueue = queue.slice(1);
        stateManager.set('promptQueue', updatedQueue);
      }
    } else if (payload.reason === 'rate_limit') {
      logger.warn(`Rate limit intercepted. Queue slice aborted. Transitioning to PAUSED_FOR_ERROR.`);
      stateManager.set('processingState', ProcessingState.PAUSED_FOR_ERROR);
      
      // Temporarily toggle auto-send off visually, but preserve intent if needed, 
      // or simply rely on the PAUSED state to block execution.
      notifyPopup({ 
        type: 'PAUSED_FOR_ERROR', 
        errorType: 'rate_limit',
        message: "you've ran out of credits on 'aistudio.google.com' please tap the below ready button when you are ready to read attempt this prompt and continue"
      });
      return; // Halt execution completely
    } else {
      logger.warn(`Generation failed for unknown reason: ${payload.reason}. Queue slice aborted.`);
      stateManager.set('processingState', ProcessingState.IDLE);
      return;
    }

    if (!autoSendEnabled) {
      logger.info('Auto-send disabled, not processing next item');
      stateManager.set('processingState', ProcessingState.IDLE);
      notifyPopup({ type: 'PROCESSING_STOPPED', reason: 'auto_send_disabled' });
      return;
    }

    // Small delay before sending next prompt to avoid overwhelming the LLM
    await new Promise(resolve => setTimeout(resolve, 500));

    // Set to idle before processing next
    stateManager.set('processingState', ProcessingState.IDLE);

    // Only automatically process the next item if the current one was successful
    if (payload.reason === 'completed') {
      await this.processNextItem();
    }
  }

  /**
   * Stop processing
   */
  stop() {
    this._processing = false;
    stateManager.set('processingState', ProcessingState.IDLE);
    logger.info('Queue processing stopped');
  }

  /**
   * Send just the next item in the queue (manual trigger, does not enable auto-send)
   * @returns {Object} Result object with success status
   */
  async sendNextItem() {
    const currentState = stateManager.get('processingState');
    if (currentState !== ProcessingState.IDLE) return { sent: false, error: 'Currently processing another prompt' };

    const currentTabId = stateManager.get('currentTabId');
    const tabSiteMap = stateManager.get('tabSiteMap') || {};
    if (!currentTabId || !tabSiteMap[currentTabId]) return { sent: false, error: 'Navigate to a supported LLM site' };

    const queue = stateManager.get('promptQueue') ||[];
    if (queue.length === 0) return { sent: false, error: 'Queue is empty' };

    focusManager.setProcessingTab(currentTabId);

    // BATCH SCAN: Aggregate missing variables scoping directly to prompt IDs
    const runtimeVars = stateManager.get('runtimeVariables') || {};
    const neededPrompts =[];
    
    queue.forEach(item => {
      let vars = item.variables;
      if (!vars || !Array.isArray(vars)) {
        const matches = [...item.prompt.matchAll(/\{\{([^}]+)\}\}/g)];
        vars = matches.map(match => match[1].trim());
      }
      
      if (vars && vars.length > 0) {
        const missingForThisPrompt = vars.filter(v => !runtimeVars[item.id] || !runtimeVars[item.id][v] || runtimeVars[item.id][v].trim() === '');
        if (missingForThisPrompt.length > 0) {
           neededPrompts.push({ id: item.id, prompt: item.prompt, variables: missingForThisPrompt });
        }
      }
    });

    if (neededPrompts.length > 0) {
      logger.info('Manual execution requires user input, yielding thread');
      stateManager.set('processingState', ProcessingState.AWAITING_USER_INPUT);
      stateManager.set('pendingResumeAction', 'manual', false);
      
      stateManager.set('lastNeededPrompts', neededPrompts, false);
      notifyPopup({ 
        type: 'PROMPT_NEEDS_INPUT', 
        neededPrompts: neededPrompts 
      });
      return { sent: false, pending: true };
    }

    delete queue[0].retryCount; // Purge stale retry data
    const nextItem = queue[0];
    let resolvedPromptText = nextItem.prompt;

    // EPHEMERAL COMPILATION
    let varsToCompile = nextItem.variables;
    if (!varsToCompile || !Array.isArray(varsToCompile)) {
      const matches =[...nextItem.prompt.matchAll(/\{\{([^}]+)\}\}/g)];
      varsToCompile = matches.map(match => match[1].trim());
    }

    if (varsToCompile && varsToCompile.length > 0) {
      for (const v of varsToCompile) {
        const safeKey = v.replace(/[-\/\^$*+?.()|[\]{}]/g, '\$&');
        const regex = new RegExp(`\{\{\s*${safeKey}\s*\}\}`, 'g');
        const replacementValue = (runtimeVars[nextItem.id] && runtimeVars[nextItem.id][v]) ? runtimeVars[nextItem.id][v] : '';
        resolvedPromptText = resolvedPromptText.replace(regex, replacementValue);
      }
    }

    try {
      stateManager.set('processingState', ProcessingState.SENDING_PROMPT);
      notifyPopup({ type: 'SENDING_PROMPT', prompt: { ...nextItem, prompt: resolvedPromptText } });

      const response = await sendToContentScript(currentTabId, {
        type: OutgoingMessageType.INJECT_PROMPT,
        payload: { prompt: resolvedPromptText, id: nextItem.id, formulationDelay: stateManager.get('settings')?.formulationDelay || 60000, executionDelay: stateManager.get('settings')?.executionDelay || 180000 }
      });

      if (response && response.success) {
        logger.info('Prompt injected successfully (manual send)');
        stateManager.set('processingState', ProcessingState.WAITING_FOR_RESPONSE);
        
        const updatedQueue = queue.slice(1);
        stateManager.set('promptQueue', updatedQueue);
        
        notifyPopup({ type: 'QUEUE_ITEM_SENT', item: nextItem, remainingCount: updatedQueue.length });
        return { sent: true, item: nextItem };
      } else {
        throw new Error(response?.error || 'Failed to inject prompt');
      }
    } catch (error) {
      logger.error('Error sending next item:', error);
      stateManager.set('processingState', ProcessingState.IDLE);
      notifyPopup({ type: 'PROCESSING_ERROR', error: error.message, item: nextItem });
      return { sent: false, error: error.message };
    }
  }
}

const queueProcessor = new QueueProcessor();

// =============================================================================
// FOCUS MANAGER (Background processing mode)
// =============================================================================

/**
 * Manages tab tracking for background processing.
 *
 * IMPORTANT: This extension continues processing even when you switch tabs.
 * It remembers which LLM tab to send prompts to (processingTabId) separately
 * from which tab is currently active (currentTabId).
 */
class FocusManager {
  constructor() {
    /** @type {number|null} The tab ID where we're processing the queue */
    this._processingTabId = null;

    this._setupListeners();
  }

  /**
   * Setup focus-related event listeners
   * @private
   */
  _setupListeners() {
    // We still listen to window focus for logging purposes
    chrome.windows.onFocusChanged.addListener(this._onWindowFocusChanged.bind(this));

    logger.debug('Focus manager listeners initialized (background mode)');
  }

  /**
   * Handle window focus changes - just log, don't pause
   * @param {number} windowId - Focused window ID or -1 if no window focused
   * @private
   */
  async _onWindowFocusChanged(windowId) {
    logger.debug('Window focus changed:', windowId, '(processing continues in background)');
    // No pausing - we continue processing in background
  }

  /**
   * Set the tab ID to use for processing (called when auto-send is enabled)
   * @param {number|null} tabId - Tab ID to process on
   */
  setProcessingTab(tabId) {
    this._processingTabId = tabId;
    stateManager.set('processingTabId', tabId, false);
    logger.info('Processing tab set to:', tabId);
  }

  /**
   * Get the tab ID being used for processing
   * @returns {number|null}
   */
  getProcessingTab() {
    return this._processingTabId || stateManager.get('processingTabId');
  }

  /**
   * Clear the processing tab (called when queue is empty or auto-send disabled)
   */
  clearProcessingTab() {
    this._processingTabId = null;
    stateManager.set('processingTabId', null, false);
    logger.info('Processing tab cleared');
  }

  /**
   * Check if a processing tab is set and valid
   * @returns {boolean}
   */
  hasValidProcessingTab() {
    const tabId = this.getProcessingTab();
    if (!tabId) return false;

    const tabSiteMap = stateManager.get('tabSiteMap') || {};
    return !!tabSiteMap[tabId];
  }

  // Legacy methods for compatibility - these now do nothing
  isFocused() {
    return true; // Always "focused" for processing purposes
  }

  setFocused(focused) {
    // No-op - we don't pause on focus loss anymore
    logger.debug('setFocused called:', focused, '(ignored in background mode)');
  }
}

const focusManager = new FocusManager();

// =============================================================================
// TAB TRACKER
// =============================================================================

/**
 * Tab lifecycle and site tracking
 */
class TabTracker {
  constructor() {
    this._setupListeners();
  }

  /**
   * Setup Chrome tab event listeners
   * @private
   */
  _setupListeners() {
    // Track tab activation
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));

    // Track tab updates (URL changes, etc.)
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));

    // Cleanup on tab close
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));

    // Handle navigation completion (for SPAs)
    chrome.webNavigation.onCompleted.addListener(this._onNavigationCompleted.bind(this));

    logger.debug('Tab tracker listeners initialized');
  }

  /**
   * Handle tab activation
   * @param {Object} activeInfo - Tab activation info
   * @private
   */
  async _onTabActivated(activeInfo) {
    const { tabId, windowId } = activeInfo;
    logger.debug('Tab activated:', { tabId, windowId });

    const previousTabId = stateManager.get('currentTabId');
    stateManager.set('currentTabId', tabId, false); // Don't persist tab ID

    // Check if this tab is on a supported site
    try {
      const tab = await chrome.tabs.get(tabId);
      const siteType = getSiteFromUrl(tab.url);

      if (siteType) {
        const tabSiteMap = { ...stateManager.get('tabSiteMap') };
        tabSiteMap[tabId] = siteType;
        stateManager.set('tabSiteMap', tabSiteMap);
        logger.info(`Active tab ${tabId} is on supported site: ${siteType}`);

        // Notify focus manager that LLM tab is focused
        focusManager.setFocused(true);
      } else {
        // User switched to a non-LLM tab
        if (previousTabId && stateManager.get('tabSiteMap')?.[previousTabId]) {
          // Was on LLM tab, now switching away
          focusManager.setFocused(false);
        }
      }

      notifyPopup({
        type: 'TAB_CHANGED',
        tabId,
        siteType,
        status: getCurrentStatus()
      });
    } catch (error) {
      logger.warn('Could not get tab info:', error);
    }
  }

  /**
   * Handle tab updates
   * @param {number} tabId - Updated tab ID
   * @param {Object} changeInfo - Change information
   * @param {Object} tab - Tab object
   * @private
   */
  _onTabUpdated(tabId, changeInfo, tab) {
    // Only care about URL changes
    if (!changeInfo.url) return;

    logger.debug('Tab updated:', { tabId, url: changeInfo.url });

    const siteType = getSiteFromUrl(changeInfo.url);
    const tabSiteMap = { ...stateManager.get('tabSiteMap') };

    if (siteType) {
      tabSiteMap[tabId] = siteType;
      logger.info(`Tab ${tabId} navigated to supported site: ${siteType}`);
    } else {
      // Remove from map if navigated away from supported site
      if (tabSiteMap[tabId]) {
        delete tabSiteMap[tabId];
        logger.info(`Tab ${tabId} left supported site`);

        // If this was the current processing tab, stop processing
        const currentTabId = stateManager.get('currentTabId');
        if (tabId === currentTabId) {
          queueProcessor.stop();
          notifyPopup({ type: 'PROCESSING_STOPPED', reason: 'tab_navigated_away' });
        }
      }
    }

    stateManager.set('tabSiteMap', tabSiteMap);
    notifyPopup({ type: 'TAB_UPDATED', tabId, siteType });
  }

  /**
   * Handle tab removal
   * @param {number} tabId - Removed tab ID
   * @param {Object} removeInfo - Removal information
   * @private
   */
  _onTabRemoved(tabId, removeInfo) {
    logger.debug('Tab removed:', tabId);

    // Clean up tab from site map
    const tabSiteMap = { ...stateManager.get('tabSiteMap') };
    if (tabSiteMap[tabId]) {
      delete tabSiteMap[tabId];
      stateManager.set('tabSiteMap', tabSiteMap);
    }

    // If this was the current active tab, clear it
    const currentTabId = stateManager.get('currentTabId');
    if (tabId === currentTabId) {
      stateManager.set('currentTabId', null, false);
    }

    // If this was the processing tab, stop processing
    const processingTabId = focusManager.getProcessingTab();
    if (tabId === processingTabId) {
      queueProcessor.stop();
      focusManager.clearProcessingTab();
      notifyPopup({ type: 'PROCESSING_STOPPED', reason: 'tab_closed' });
    }
  }

  /**
   * Handle navigation completion (for SPA support)
   * @param {Object} details - Navigation details
   * @private
   */
  _onNavigationCompleted(details) {
    // Only care about main frame navigation
    if (details.frameId !== 0) return;

    logger.debug('Navigation completed:', { tabId: details.tabId, url: details.url });

    const siteType = getSiteFromUrl(details.url);
    if (siteType) {
      const tabSiteMap = { ...stateManager.get('tabSiteMap') };
      tabSiteMap[details.tabId] = siteType;
      stateManager.set('tabSiteMap', tabSiteMap);
    }
  }

  /**
   * Initialize with current active tab
   */
  async initialize() {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        stateManager.set('currentTabId', activeTab.id, false);

        const siteType = getSiteFromUrl(activeTab.url);
        logger.info('Initialized with active tab:', {
          tabId: activeTab.id,
          url: activeTab.url,
          siteType: siteType || 'not a supported site'
        });

        if (siteType) {
          const tabSiteMap = { ...stateManager.get('tabSiteMap') };
          tabSiteMap[activeTab.id] = siteType;
          stateManager.set('tabSiteMap', tabSiteMap);
          logger.info('Tab registered in tabSiteMap:', tabSiteMap);
        }
      }

      // Also scan all tabs to find any LLM sites already open
      const allTabs = await chrome.tabs.query({});
      const tabSiteMap = { ...stateManager.get('tabSiteMap') };
      let foundSites = 0;

      for (const tab of allTabs) {
        const siteType = getSiteFromUrl(tab.url);
        if (siteType && !tabSiteMap[tab.id]) {
          tabSiteMap[tab.id] = siteType;
          foundSites++;
          logger.info('Found LLM tab:', { tabId: tab.id, url: tab.url, siteType });
        }
      }

      if (foundSites > 0) {
        stateManager.set('tabSiteMap', tabSiteMap);
        logger.info('Scanned all tabs, found', foundSites, 'LLM sites');
      }
    } catch (error) {
      logger.error('Failed to initialize tab tracker:', error);
    }
  }
}

const tabTracker = new TabTracker();

// =============================================================================
// MESSAGE ROUTER
// =============================================================================

/**
 * Central message routing hub
 */
class MessageRouter {
  constructor() {
    this._setupListener();
  }

  /**
   * Setup the runtime message listener
   * @private
   */
  _setupListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      ensureInitialized().then(() => {
        this._handleMessage(message, sender, sendResponse);
      });
      // Return true to indicate async response
      return true;
    });

    logger.debug('Message router initialized');
  }

  /**
   * Route incoming messages to appropriate handlers
   * @param {Object} message - Incoming message
   * @param {Object} sender - Message sender info
   * @param {Function} sendResponse - Response callback
   * @private
   */
  async _handleMessage(message, sender, sendResponse) {
    const { type, payload, source } = message;
    const senderTabId = sender.tab?.id;

    logger.debug('Message received:', { type, source, senderTabId, payload });

    try {
      let response;

      // Determine message source and route accordingly
      if (sender.tab) {
        // Message from content script
        response = await this._handleContentScriptMessage(type, payload, senderTabId);
      } else {
        // Message from popup or other extension context
        response = await this._handlePopupMessage(type, payload);
      }

      sendResponse({ success: true, data: response });
    } catch (error) {
      logger.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  }

  /**
   * Handle messages from popup
   * @param {string} type - Message type
   * @param {any} payload - Message payload
   * @returns {Promise<any>} Response data
   * @private
   */
  async _handlePopupMessage(type, payload) {
    switch (type) {
      case PopupMessageType.GET_STATUS:
        return getCurrentStatus();

      case PopupMessageType.QUEUE_UPDATED:
        // Popup notifies us that queue was modified
        if (payload && payload.queue) {
          stateManager.set('promptQueue', payload.queue);
        }
        logger.info('Queue updated from popup:', payload);
        return { acknowledged: true };

      case PopupMessageType.TOGGLE_AUTO_SEND:
        const newAutoSendState = payload?.enabled ?? !stateManager.get('autoSendEnabled');
        stateManager.set('autoSendEnabled', newAutoSendState);
        
        // Sync back to settings object so popup UI persists correctly
        chrome.storage.local.get('settings').then(stored => {
          const updatedSettings = stored.settings || {};
          updatedSettings.autoSendEnabled = newAutoSendState;
          chrome.storage.local.set({ settings: updatedSettings });
        });
        
        logger.info('Auto-send toggled:', newAutoSendState);

        if (newAutoSendState) {
          // Check if we should start processing
          const currentState = stateManager.get('processingState');
          logger.info('TOGGLE_AUTO_SEND - current state:', currentState);

          if (currentState === ProcessingState.IDLE) {
            // Get the current tab - try stored value first, then query directly
            let currentTabId = stateManager.get('currentTabId');
            let tabSiteMap = stateManager.get('tabSiteMap') || {};

            // If we don't have tab info, try to get it directly
            if (!currentTabId || !tabSiteMap[currentTabId]) {
              try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab) {
                  currentTabId = activeTab.id;
                  const siteType = getSiteFromUrl(activeTab.url);
                  if (siteType) {
                    tabSiteMap[currentTabId] = siteType;
                    stateManager.set('currentTabId', currentTabId, false);
                    stateManager.set('tabSiteMap', tabSiteMap);
                    logger.info('TOGGLE_AUTO_SEND - refreshed tab info:', { currentTabId, siteType });
                  }
                }
              } catch (e) {
                logger.warn('Could not query active tab:', e);
              }
            }

            logger.info('TOGGLE_AUTO_SEND - currentTabId:', currentTabId, 'tabSiteMap:', tabSiteMap);

            if (currentTabId && tabSiteMap[currentTabId]) {
              // IMPORTANT: Lock this tab as our processing target
              // This allows the user to switch tabs while processing continues
              focusManager.setProcessingTab(currentTabId);
              logger.info('TOGGLE_AUTO_SEND - processingTab set to:', currentTabId);

              try {
                const response = await sendToContentScript(currentTabId, {
                  type: 'CHECK_STATUS',
                  payload: {}
                });

                if (response && response.isGenerating) {
                  // Generation is happening (user sent manually), wait for it
                  logger.info('Generation in progress (manual send), waiting for completion');
                  stateManager.set('processingState', ProcessingState.WAITING_FOR_RESPONSE);
                  notifyPopup({ type: 'STATE_UPDATE', state: 'waiting_for_response' });

                  // Tell content script to start monitoring
                  await sendToContentScript(currentTabId, {
                    type: 'START_MONITORING',
                    payload: {}
                  });
                } else {
                  // Not generating, start processing queue
                  queueProcessor.startProcessing();
                }
              } catch (error) {
                logger.warn('Could not check generation status:', error);
                // Assume idle and start processing
                queueProcessor.startProcessing();
              }
            } else {
              // No active tab or not on supported site
              logger.warn('Auto-send enabled but cannot start:', {
                currentTabId,
                tabSiteMap,
                hasTab: !!currentTabId,
                hasSite: currentTabId ? !!tabSiteMap[currentTabId] : false
              });
            }
          } else if (currentState === ProcessingState.WAITING_FOR_RESPONSE) {
            // We're stuck in waiting_for_response state
            // This can happen if generation completed while auto-send was off
            // Reset and try to start processing
            logger.info('Auto-send enabled while stuck in waiting_for_response, resetting...');
            stateManager.set('processingState', ProcessingState.IDLE);

            // Now try to start processing
            let currentTabId = stateManager.get('currentTabId');
            let tabSiteMap = stateManager.get('tabSiteMap') || {};

            if (!currentTabId || !tabSiteMap[currentTabId]) {
              try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab) {
                  currentTabId = activeTab.id;
                  const siteType = getSiteFromUrl(activeTab.url);
                  if (siteType) {
                    tabSiteMap[currentTabId] = siteType;
                    stateManager.set('currentTabId', currentTabId, false);
                    stateManager.set('tabSiteMap', tabSiteMap);
                  }
                }
              } catch (e) {
                logger.warn('Could not query active tab:', e);
              }
            }

            if (currentTabId && tabSiteMap[currentTabId]) {
              focusManager.setProcessingTab(currentTabId);
              queueProcessor.startProcessing();
            }
          } else {
            logger.info('Auto-send enabled, already processing, state:', currentState);
          }
        } else {
          // Auto-send disabled - reset state
          // Clear the processing tab when disabled
          focusManager.clearProcessingTab();
          // Also reset processing state to idle
          stateManager.set('processingState', ProcessingState.IDLE);
          logger.info('Auto-send disabled, state reset to idle');
        }

        return { autoSendEnabled: newAutoSendState };

      case PopupMessageType.START_PROCESSING:
        logger.info('Manual start processing requested');
        // Temporarily enable auto-send for this session
        stateManager.set('autoSendEnabled', true);
        await queueProcessor.startProcessing();
        return { started: true };

      case PopupMessageType.STOP_PROCESSING:
        logger.info('Stop processing explicitly requested');
        queueProcessor.stop();
        stateManager.set('autoSendEnabled', false);
        chrome.storage.local.get('settings').then(stored => {
          const updatedSettings = stored.settings || {};
          updatedSettings.autoSendEnabled = false;
          chrome.storage.local.set({ settings: updatedSettings });
        });
        notifyPopup({ type: 'PROCESSING_STOPPED', reason: 'user_aborted' });
        return { stopped: true };

      case PopupMessageType.SEND_NEXT:
        logger.info('Manual send next requested');
        // Send just the next item without enabling auto-send
        return await queueProcessor.sendNextItem();

      case 'CLEAR_RUNTIME_VARIABLES':
        logger.info('Clearing runtime variables for fresh chain load');
        stateManager.set('runtimeVariables', {}, false);
        return { cleared: true };

      case 'SUBMIT_VARIABLES':
        logger.info('Received runtime variables, merging into nested runtime context');
        
        if (stateManager.get('processingState') !== ProcessingState.AWAITING_USER_INPUT) {
          return { error: 'Not currently awaiting input' };
        }
        
        // Push user's form submissions into the nested memory bank
        const currentVars = stateManager.get('runtimeVariables') || {};
        const incomingVars = payload.variables || {};
        const newVars = { ...currentVars };
        
        for (const promptId in incomingVars) {
           newVars[promptId] = { ...(newVars[promptId] || {}), ...incomingVars[promptId] };
        }
        
        stateManager.set('runtimeVariables', newVars, false);
        
        // Reset state and resume execution pipeline
        stateManager.set('processingState', ProcessingState.IDLE);
        
        const resumeAction = stateManager.get('pendingResumeAction');
        if (resumeAction === 'manual') {
          return await queueProcessor.sendNextItem();
        } else {
          // CRITICAL FIX: Use startProcessing() to correctly resume the automated queue loop
          queueProcessor.startProcessing(); 
          return { resumed: true };
        }

      case 'RESUME_FROM_ERROR':
        logger.info('Received RESUME_FROM_ERROR. Transitioning to IDLE and re-attempting prompt.');
        if (stateManager.get('processingState') !== ProcessingState.PAUSED_FOR_ERROR) {
          return { error: 'Not currently paused for an error' };
        }
        
        stateManager.set('processingState', ProcessingState.IDLE);
        
        // Since we deferred mutation, the prompt is safely at index 0.
        // We simply re-invoke the processing loop.
        queueProcessor.startProcessing();
        return { resumed: true };

      default:
        logger.warn('Unknown content script message type:', type);
        return { error: 'Unknown message type' };
    }
  }

  /**
   * Handle messages from content scripts
   * @param {string} type - Message type
   * @param {any} payload - Message payload
   * @param {number} tabId - Sender tab ID
   * @returns {Promise<any>} Response data
   * @private
   */
  async _handleContentScriptMessage(type, payload, tabId) {
    switch (type) {
      case 'SITE_READY':
        logger.info(`Site ready in tab ${tabId}:`, payload.siteType);
        const tabSiteMap = stateManager.get('tabSiteMap') || {};
        tabSiteMap[tabId] = payload.siteType;
        stateManager.set('tabSiteMap', tabSiteMap);

        // PAGE REFRESH RECOVERY
        if (stateManager.get('processingTabId') === tabId && stateManager.get('processingState') === ProcessingState.WAITING_FOR_RESPONSE) {
          logger.warn(`Tab ${tabId} reloaded mid-generation. Recovering.`);
          stateManager.set('processingState', ProcessingState.IDLE);
          const queue = stateManager.get('promptQueue') || [];
          if (queue.length > 0) {
            queue[0].retryCount = (queue[0].retryCount || 0) + 1;
            if (queue[0].retryCount > 3) {
              stateManager.set('processingState', ProcessingState.PAUSED_FOR_ERROR);
              notifyPopup({ type: 'PAUSED_FOR_ERROR', message: 'Page refreshed repeatedly. Queue paused to prevent loops.' });
              return { acknowledged: true };
            }
            stateManager.set('promptQueue', queue, false);
            notifyPopup({ type: 'STATE_UPDATE', payload: { type: 'RECOVERING_PAGE_REFRESH', retryCount: queue[0].retryCount } });
          }
          setTimeout(() => queueProcessor.startProcessing(), 3000);
        }
        return { acknowledged: true };
        
      case 'GENERATION_STARTED':
        logger.info('Generation started in tab', tabId);
        stateManager.set('processingState', ProcessingState.WAITING_FOR_RESPONSE);
        notifyPopup({ type: 'GENERATION_STARTED' });
        return { acknowledged: true };
        
      case 'GENERATION_COMPLETE':
        logger.info('Generation complete in tab', tabId, payload);
        await queueProcessor.onGenerationComplete(payload);
        return { acknowledged: true };
        
      case 'ERROR':
        logger.error(`Error from tab ${tabId}:`, payload.message, payload.error);
        if (stateManager.get('currentTabId') === tabId) {
          stateManager.set('processingState', ProcessingState.IDLE);
          notifyPopup({ type: 'PROCESSING_ERROR', error: payload.message });
        }
        return { acknowledged: true };
        
      default:
        logger.warn('Unknown content script message type:', type);
        return { error: 'Unknown message type' };
    }
  }
}

const messageRouter = new MessageRouter();

// =============================================================================
// LIFECYCLE HANDLERS
// =============================================================================

/**
 * Handle extension installation
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info('Extension installed/updated:', details.reason);

  // Initialize state
  await ensureInitialized();
  await tabTracker.initialize();

  // Set defaults on fresh install
  if (details.reason === 'install') {
    stateManager.set('promptQueue', []);
    stateManager.set('autoSendEnabled', false);
    stateManager.set('processingState', ProcessingState.IDLE);
    logger.info('Fresh install - defaults set');
  }
});

/**
 * Handle browser startup
 */
chrome.runtime.onStartup.addListener(async () => {
  logger.info('Browser started - initializing extension');

  await ensureInitialized();
  await tabTracker.initialize();

  // Reset processing state on startup (don't resume mid-process)
  stateManager.set('processingState', ProcessingState.IDLE);
});

/**
 * Handle service worker wake-up (for when it was terminated and restarted)
 */
/**
 * Handle service worker wake-up (Promise Latch)
 */
let swInitPromise = null;
function ensureInitialized() {
  if (!swInitPromise) {
    swInitPromise = (async () => {
      if (!stateManager.get('processingState')) {
        logger.info('Service worker bootstrapping state from storage...');
        await stateManager.initialize();
        await tabTracker.initialize();
      }
    })();
  }
  return swInitPromise;
}

/**
 * Listen for storage changes to keep state in sync
 * This handles cases where popup writes directly to storage
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  logger.debug('Storage changed:', Object.keys(changes));

  // Sync promptQueue changes
  if (changes.promptQueue) {
    const newQueue = changes.promptQueue.newValue || [];
    stateManager.set('promptQueue', newQueue, false); // Don't persist back (avoid loop)
    logger.info('Queue synced from storage:', newQueue.length, 'items');
  }

  // Sync autoSendEnabled changes
  if (changes.autoSendEnabled) {
    const newValue = changes.autoSendEnabled.newValue || false;
    stateManager.set('autoSendEnabled', newValue, false); // Don't persist back
    logger.info('Auto-send synced from storage:', newValue);
  }
});

// =============================================================================
// EXPORTS (for potential module usage)
// =============================================================================

// These are available globally in the service worker context
// Useful for debugging via the DevTools console
globalThis.promptQueueDebug = {
  stateManager,
  queueProcessor,
  tabTracker,
  focusManager,
  messageRouter,
  logger,
  getCurrentStatus,
  getSiteFromUrl,
  isTabSupported,
  ProcessingState,
  SUPPORTED_SITES
};

logger.info('LLM Prompt Queue service worker loaded');
