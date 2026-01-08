/**
 * LLM Prompt Queue - Common Content Script Utilities
 *
 * Shared functionality across all LLM site integrations.
 * This file must be loaded before any site-specific content scripts.
 *
 * @version 1.0.0
 */

// =============================================================================
// STATE
// =============================================================================

/** @type {string|null} Current site identifier */
let currentSite = null;

/** @type {boolean} Whether we're currently processing a prompt */
let isProcessing = false;

/** @type {MutationObserver|null} Active generation observer */
let generationObserver = null;

/** @type {number|null} Polling interval for generation detection */
let generationPollInterval = null;

// =============================================================================
// LOGGING
// =============================================================================

const LOG_PREFIX = '[PromptQueue]';

/**
 * Logger with consistent formatting
 */
const log = {
  debug: (...args) => console.log(LOG_PREFIX, '[DEBUG]', ...args),
  info: (...args) => console.info(LOG_PREFIX, '[INFO]', ...args),
  warn: (...args) => console.warn(LOG_PREFIX, '[WARN]', ...args),
  error: (...args) => console.error(LOG_PREFIX, '[ERROR]', ...args)
};

// =============================================================================
// DOM UTILITIES
// =============================================================================

/**
 * Wait for an element to appear in the DOM using MutationObserver
 *
 * @param {string|string[]} selectors - CSS selector(s) to find (tries in order if array)
 * @param {Object} options - Configuration options
 * @param {number} options.timeout - Maximum wait time in ms (default: 10000)
 * @param {Element} options.parent - Parent element to search within (default: document)
 * @param {boolean} options.visible - Whether element must be visible (default: false)
 * @returns {Promise<Element>} The found element
 * @throws {Error} If element not found within timeout
 */
function waitForElement(selectors, options = {}) {
  const {
    timeout = 10000,
    parent = document,
    visible = false
  } = options;

  const selectorList = Array.isArray(selectors) ? selectors : [selectors];

  return new Promise((resolve, reject) => {
    // Helper to check if element is visible
    const isVisible = (el) => {
      if (!visible) return true;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0'
      );
    };

    // Try to find element with any of the selectors
    const findElement = () => {
      for (const selector of selectorList) {
        try {
          const elements = parent.querySelectorAll(selector);
          for (const el of elements) {
            if (isVisible(el)) {
              return el;
            }
          }
        } catch (e) {
          log.warn(`Invalid selector: ${selector}`, e);
        }
      }
      return null;
    };

    // Check immediately
    const element = findElement();
    if (element) {
      resolve(element);
      return;
    }

    // Set up observer
    const observer = new MutationObserver(() => {
      const element = findElement();
      if (element) {
        observer.disconnect();
        clearTimeout(timeoutId);
        resolve(element);
      }
    });

    observer.observe(parent === document ? document.body : parent, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'disabled']
    });

    // Timeout handler
    const timeoutId = setTimeout(() => {
      observer.disconnect();
      reject(new Error(
        `Element not found within ${timeout}ms. Selectors: ${selectorList.join(', ')}`
      ));
    }, timeout);
  });
}

/**
 * Simulate user input on an element with proper event dispatching
 * Handles both regular inputs/textareas and contenteditable elements
 *
 * @param {Element} element - Target input element
 * @param {string} text - Text to input
 * @param {Object} options - Configuration options
 * @param {boolean} options.clear - Whether to clear existing content first (default: true)
 * @param {boolean} options.dispatchEvents - Whether to dispatch events (default: true)
 */
function simulateInput(element, text, options = {}) {
  const { clear = true, dispatchEvents = true } = options;

  // Focus the element
  element.focus();

  // Determine if this is a contenteditable element
  const isContentEditable = element.isContentEditable ||
    element.getAttribute('contenteditable') === 'true';

  if (isContentEditable) {
    // Handle contenteditable (ProseMirror, Quill, etc.)
    if (clear) {
      element.innerHTML = '';
    }

    // Try execCommand first (works better with React/ProseMirror)
    const success = document.execCommand('insertText', false, text);

    if (!success) {
      // Fallback: set textContent directly
      if (clear) {
        element.textContent = text;
      } else {
        element.textContent += text;
      }
    }
  } else {
    // Handle regular input/textarea
    if (clear) {
      element.value = '';
    }

    // Set value using native setter to bypass React controlled input issues
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, clear ? text : element.value + text);
    } else {
      element.value = clear ? text : element.value + text;
    }
  }

  // Dispatch events to trigger React/Vue/Angular state updates
  if (dispatchEvents) {
    // Input event (most important for React)
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));

    // Change event
    element.dispatchEvent(new Event('change', { bubbles: true }));

    // Keyboard events for frameworks that listen to them
    element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Unidentified'
    }));

    element.dispatchEvent(new KeyboardEvent('keyup', {
      bubbles: true,
      cancelable: true,
      key: 'Unidentified'
    }));
  }

  log.debug('Input simulated:', {
    isContentEditable,
    textLength: text.length,
    element: element.tagName
  });
}

/**
 * Click an element with proper event sequence
 *
 * @param {Element} element - Element to click
 * @param {Object} options - Configuration options
 * @param {boolean} options.force - Click even if element appears disabled (default: false)
 * @returns {boolean} Whether click was dispatched successfully
 */
function clickButton(element, options = {}) {
  const { force = false } = options;

  if (!element) {
    log.warn('clickButton: No element provided');
    return false;
  }

  // Check if element is disabled
  const isDisabled = element.disabled ||
    element.getAttribute('aria-disabled') === 'true' ||
    element.classList.contains('disabled');

  if (isDisabled && !force) {
    log.warn('clickButton: Element is disabled', element);
    return false;
  }

  // Focus first
  element.focus();

  // Dispatch mouse events in proper sequence
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0,
    buttons: 1
  };

  element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
  element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
  element.dispatchEvent(new MouseEvent('click', eventOptions));

  log.debug('Button clicked:', element);
  return true;
}

/**
 * Observe DOM changes with a simplified wrapper around MutationObserver
 *
 * @param {string|Element} target - Selector or element to observe
 * @param {Function} callback - Callback function (mutations, observer) => void
 * @param {Object} options - MutationObserver options
 * @returns {Object} Object with disconnect() method and observer reference
 */
function observeDOM(target, callback, options = {}) {
  const defaultOptions = {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
    ...options
  };

  // Resolve target to element
  let targetElement;
  if (typeof target === 'string') {
    targetElement = document.querySelector(target);
    if (!targetElement) {
      log.warn('observeDOM: Target not found:', target);
      return { disconnect: () => {}, observer: null };
    }
  } else {
    targetElement = target;
  }

  const observer = new MutationObserver((mutations, obs) => {
    try {
      callback(mutations, obs);
    } catch (error) {
      log.error('observeDOM callback error:', error);
    }
  });

  observer.observe(targetElement, defaultOptions);

  return {
    disconnect: () => observer.disconnect(),
    observer
  };
}

/**
 * Check if an element is visible in the viewport
 *
 * @param {Element} element - Element to check
 * @returns {boolean} Whether element is visible
 */
function isElementVisible(element) {
  if (!element) return false;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    style.opacity !== '0' &&
    !element.hidden
  );
}

/**
 * Find an element matching any of the given selectors
 *
 * @param {string[]} selectors - Array of CSS selectors to try
 * @param {Object} options - Configuration options
 * @param {Element} options.parent - Parent element to search within
 * @param {boolean} options.visible - Only return visible elements
 * @returns {Element|null} Found element or null
 */
function findElement(selectors, options = {}) {
  const { parent = document, visible = false } = options;

  for (const selector of selectors) {
    try {
      const elements = parent.querySelectorAll(selector);
      for (const el of elements) {
        if (!visible || isElementVisible(el)) {
          return el;
        }
      }
    } catch (e) {
      // Invalid selector, skip
    }
  }
  return null;
}

// =============================================================================
// MESSAGE HANDLING
// =============================================================================

/**
 * Send a message to the service worker (background script)
 *
 * @param {string} type - Message type
 * @param {Object} data - Message payload
 * @returns {Promise<Object>} Response from service worker
 */
async function sendToBackground(type, data = {}, options = {}) {
  const { retries = 0, retryDelay = 500 } = options;

  const message = {
    type,
    payload: data,
    source: 'content-script',
    site: currentSite,
    timestamp: Date.now()
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      log.debug('Sending to background:', message);

      const response = await chrome.runtime.sendMessage(message);

      log.debug('Response from background:', response);
      return response;
    } catch (error) {
      if (attempt < retries) {
        log.debug(`Retrying sendToBackground (attempt ${attempt + 1}/${retries}):`, error.message);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        log.error('Failed to send message to background:', error);
        throw error;
      }
    }
  }
}

/**
 * Send SITE_READY with retry logic to handle service worker initialization timing
 * @param {string} siteType - Site identifier
 * @returns {Promise<Object>} Response from background
 */
async function sendSiteReady(siteType) {
  // Retry a few times in case service worker is still initializing
  return sendToBackground('SITE_READY', {
    siteType,
    url: window.location.href
  }, { retries: 3, retryDelay: 500 });
}

/**
 * Set up message listener for messages from service worker
 *
 * @param {Function} handler - Message handler function (message, sender) => Promise<Object>
 * @returns {Function} Cleanup function to remove listener
 */
function setupMessageListener(handler) {
  const listener = (message, sender, sendResponse) => {
    // Only handle messages from our extension
    if (message.source !== 'background') {
      return false;
    }

    log.debug('Message received from background:', message);

    // Handle async response
    Promise.resolve()
      .then(() => handler(message, sender))
      .then(response => {
        sendResponse({ success: true, ...response });
      })
      .catch(error => {
        log.error('Message handler error:', error);
        sendResponse({ success: false, error: error.message });
      });

    // Return true to indicate async response
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);

  return () => chrome.runtime.onMessage.removeListener(listener);
}

// =============================================================================
// GENERATION MONITORING
// =============================================================================

/**
 * Start monitoring for generation completion
 * Uses both polling and DOM observation for reliability
 *
 * @param {Function} isGeneratingFn - Function that returns true if still generating
 * @param {Object} options - Configuration options
 * @param {number} options.pollInterval - Polling interval in ms (default: 500)
 * @param {number} options.timeout - Maximum time to wait in ms (default: 300000 = 5 minutes)
 * @param {string} options.observeTarget - Selector for DOM to observe
 */
function startGenerationMonitor(isGeneratingFn, options = {}) {
  const {
    pollInterval = 500,
    timeout = 300000,
    observeTarget = null
  } = options;

  // Clear any existing monitors
  stopGenerationMonitor();

  let consecutiveIdleChecks = 0;
  const REQUIRED_IDLE_CHECKS = 4; // Require 4 consecutive checks to confirm completion
  const startTime = Date.now();
  let hasSeenGenerating = false; // Track if we ever saw generation happening

  log.info('Starting generation monitor');

  // Polling check
  generationPollInterval = setInterval(async () => {
    try {
      // Check timeout
      if (Date.now() - startTime > timeout) {
        log.warn('Generation monitor timed out');
        stopGenerationMonitor();
        // Reset processing flag before sending completion message
        isProcessing = false;
        sendToBackground('GENERATION_COMPLETE', { reason: 'timeout' });
        return;
      }

      const generating = await Promise.resolve(isGeneratingFn());

      if (generating) {
        // We've confirmed generation is happening
        hasSeenGenerating = true;
        consecutiveIdleChecks = 0;
        log.debug('Generation in progress...');
      } else {
        consecutiveIdleChecks++;
        log.debug(`Generation idle check: ${consecutiveIdleChecks}/${REQUIRED_IDLE_CHECKS} (seen generating: ${hasSeenGenerating})`);

        // Only trigger completion if we've seen generation OR enough time has passed
        // This handles both normal completion and cases where generation finished very quickly
        const minWaitTime = 3000; // Wait at least 3 seconds before allowing completion
        const timeElapsed = Date.now() - startTime;
        const shouldAllowCompletion = hasSeenGenerating || timeElapsed > minWaitTime;

        if (consecutiveIdleChecks >= REQUIRED_IDLE_CHECKS && shouldAllowCompletion) {
          log.info('Generation complete detected');
          stopGenerationMonitor();
          // Reset processing flag before sending completion message
          isProcessing = false;
          sendToBackground('GENERATION_COMPLETE', { reason: 'completed' });
        }
      }
    } catch (error) {
      log.error('Error in generation monitor:', error);
    }
  }, pollInterval);

  // Also observe DOM for faster detection
  if (observeTarget) {
    const target = document.querySelector(observeTarget);
    if (target) {
      const { disconnect } = observeDOM(target, () => {
        // Reset idle counter on DOM changes (still generating)
        consecutiveIdleChecks = 0;
      }, { characterData: true, subtree: true });

      // Store for cleanup
      generationObserver = { disconnect };
    }
  }
}

/**
 * Stop the generation monitor
 */
function stopGenerationMonitor() {
  if (generationPollInterval) {
    clearInterval(generationPollInterval);
    generationPollInterval = null;
  }

  if (generationObserver) {
    generationObserver.disconnect();
    generationObserver = null;
  }

  log.debug('Generation monitor stopped');
}

// =============================================================================
// NAVIGATION DETECTION
// =============================================================================

/** @type {boolean} Track if navigation is in progress */
let navigationInProgress = false;

/** @type {Function|null} Cleanup callback for navigation */
let navigationCleanupCallback = null;

/**
 * Setup navigation interruption detection
 * Handles beforeunload, pagehide, and visibility changes
 */
function setupNavigationDetection() {
  // Handle page unload (navigation away)
  window.addEventListener('beforeunload', (event) => {
    navigationInProgress = true;
    log.info('Navigation detected (beforeunload)');

    // Notify background of navigation
    sendToBackground('ERROR', {
      message: 'User navigating away',
      type: 'navigation',
      isNavigating: true
    }).catch(() => {}); // Ignore errors

    // Run cleanup if registered
    if (navigationCleanupCallback) {
      try {
        navigationCleanupCallback();
      } catch (e) {
        log.error('Navigation cleanup error:', e);
      }
    }

    // Reset processing state
    if (isProcessing) {
      isProcessing = false;
      stopGenerationMonitor();
    }
  });

  // Handle page hide (tab switch, minimize, etc.)
  window.addEventListener('pagehide', () => {
    log.debug('Page hidden (pagehide)');
    if (isProcessing) {
      // Don't stop processing, but log it
      log.info('Page hidden while processing');
    }
  });

  // Handle visibility changes
  document.addEventListener('visibilitychange', () => {
    const isVisible = document.visibilityState === 'visible';
    log.debug('Visibility changed:', document.visibilityState);

    if (!isVisible && isProcessing) {
      log.info('Tab became hidden while processing');
      // Notify background that tab is hidden
      sendToBackground('ERROR', {
        message: 'Tab hidden during processing',
        type: 'visibility',
        isVisible: false
      }).catch(() => {});
    }
  });

  log.debug('Navigation detection initialized');
}

/**
 * Register a cleanup callback for navigation events
 * @param {Function} callback - Function to call on navigation
 */
function onNavigationCleanup(callback) {
  navigationCleanupCallback = callback;
}

/**
 * Check if navigation is in progress
 * @returns {boolean}
 */
function isNavigating() {
  return navigationInProgress;
}

// Initialize navigation detection
setupNavigationDetection();

// =============================================================================
// UTILITY HELPERS
// =============================================================================

/**
 * Wait for a specified duration
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff and jitter
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Configuration options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 500)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 5000)
 * @param {boolean} options.jitter - Add random jitter to prevent thundering herd (default: true)
 * @param {Function} options.shouldRetry - Function to determine if error is retryable (default: all errors)
 * @param {Function} options.onRetry - Callback on retry (attempt, error, delay)
 * @returns {Promise<any>} Result of successful function call
 */
async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 500,
    maxDelay = 5000,
    jitter = true,
    shouldRetry = () => true,
    onRetry = null
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (!shouldRetry(error)) {
        log.debug(`Error not retryable: ${error.message}`);
        throw error;
      }

      if (attempt < maxRetries) {
        // Calculate delay with exponential backoff
        let delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

        // Add jitter (random variance of +/- 25%)
        if (jitter) {
          const jitterFactor = 0.75 + Math.random() * 0.5; // 0.75 to 1.25
          delay = Math.floor(delay * jitterFactor);
        }

        log.debug(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms - Error: ${error.message}`);

        if (onRetry) {
          onRetry(attempt + 1, error, delay);
        }

        await sleep(delay);
      }
    }
  }

  log.error(`All ${maxRetries} retry attempts failed`);
  throw lastError;
}

/**
 * Retry specifically for DOM operations with element-specific handling
 *
 * @param {Function} fn - Async function to retry that may fail due to missing DOM elements
 * @param {Object} options - Configuration options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 500)
 * @param {string} options.operationName - Name of operation for logging
 * @returns {Promise<any>} Result of successful function call
 */
async function retryDOMOperation(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 500,
    operationName = 'DOM operation'
  } = options;

  return retry(fn, {
    maxRetries,
    baseDelay,
    jitter: true,
    shouldRetry: (error) => {
      // Retry on DOM-related errors
      const retryablePatterns = [
        /element not found/i,
        /selector/i,
        /null/i,
        /undefined/i,
        /cannot read property/i,
        /timeout/i
      ];
      return retryablePatterns.some(pattern => pattern.test(error.message));
    },
    onRetry: (attempt, error, delay) => {
      log.warn(`${operationName} failed (attempt ${attempt}): ${error.message}. Retrying in ${delay}ms...`);
      // Notify background of retry
      sendToBackground('ERROR', {
        message: `Retrying ${operationName} (attempt ${attempt})`,
        error: error.message,
        isRetry: true
      }).catch(() => {}); // Ignore errors sending notification
    }
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

// Expose utilities to site-specific scripts via window object
window.PromptQueueCommon = {
  // State
  get currentSite() { return currentSite; },
  set currentSite(value) { currentSite = value; },
  get isProcessing() { return isProcessing; },
  set isProcessing(value) { isProcessing = value; },

  // DOM Utilities
  waitForElement,
  simulateInput,
  clickButton,
  observeDOM,
  isElementVisible,
  findElement,

  // Message Handling
  sendToBackground,
  sendSiteReady,
  setupMessageListener,

  // Generation Monitoring
  startGenerationMonitor,
  stopGenerationMonitor,

  // Navigation
  onNavigationCleanup,
  isNavigating,

  // Helpers
  sleep,
  retry,
  retryDOMOperation,
  log
};

log.info('Common utilities loaded');
