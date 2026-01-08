/**
 * LLM Prompt Queue - Claude Content Script
 *
 * Handles prompt injection and submission for Claude (claude.ai)
 * Claude uses ProseMirror for its contenteditable input
 *
 * @version 1.0.0
 */

(function() {
  'use strict';

  // Get utilities from common.js
  const {
    waitForElement,
    simulateInput,
    clickButton,
    findElement,
    isElementVisible,
    sendToBackground,
    setupMessageListener,
    startGenerationMonitor,
    sleep,
    retry,
    retryDOMOperation,
    log
  } = window.PromptQueueCommon;

  // =============================================================================
  // CONSTANTS
  // =============================================================================

  const SITE_NAME = 'claude';

  /**
   * Selectors for Claude interface elements
   * Claude uses ProseMirror for rich text editing
   * IMPORTANT: Avoid matching elements inside canvas/artifact panels
   */
  const SELECTORS = {
    // Input selectors (ProseMirror contenteditable) - exclude canvas areas
    input: [
      // Main chat input - look for the composer area specifically
      'fieldset div[contenteditable="true"].ProseMirror',  // Inside fieldset (main input)
      'div[class*="composer"] div[contenteditable="true"].ProseMirror', // Composer area
      'form div[contenteditable="true"].ProseMirror',     // Inside form
      // Fallbacks but exclude canvas/artifact areas
      'div[contenteditable="true"].ProseMirror:not([class*="artifact"]):not([class*="canvas"])',
      'div.ProseMirror[contenteditable="true"]:not([class*="artifact"]):not([class*="canvas"])',
    ],

    // Send button selectors - only match main chat send button
    sendButton: [
      'fieldset button[aria-label="Send Message"]',       // Inside fieldset
      'fieldset button[aria-label="Send message"]',       // Lowercase variant
      'button[aria-label="Send Message"]:not([class*="artifact"])',
      'button[aria-label="Send message"]:not([class*="artifact"])',
      'form button[aria-label*="Send"]',                  // Inside form
    ],

    // Stop button selectors - main chat stop button
    stopButton: [
      'fieldset button[aria-label="Stop Response"]',      // Inside fieldset
      'fieldset button[aria-label="Stop response"]',
      'button[aria-label="Stop Response"]:not([class*="artifact"])',
      'button[aria-label="Stop response"]:not([class*="artifact"])',
      'button[aria-label*="Stop"]:not([class*="artifact"])',
    ],

    // Response/message containers
    responseContainer: [
      '[data-is-streaming]',                        // Streaming indicator
      'div.font-claude-message',                    // Claude message class
      'div[class*="claude"]',                       // Claude-related classes
      'div[class*="message"]',                      // Generic message class
      'div[class*="response"]',                     // Response class
    ],

    // Conversation area
    conversationArea: [
      'main',
      'div[class*="conversation"]',
      'div[class*="chat"]',
    ],

    // Typing/streaming indicators
    streamingIndicator: [
      '[data-is-streaming="true"]',                 // Data attribute
      'div[class*="typing"]',                       // Typing indicator
      'div[class*="streaming"]',                    // Streaming class
      'span[class*="cursor"]',                      // Cursor indicator
    ]
  };

  // =============================================================================
  // STATE
  // =============================================================================

  /** Track if input was successfully found */
  let inputFound = false;

  // =============================================================================
  // DOM HELPERS
  // =============================================================================

  /**
   * Get the ProseMirror input element
   * @returns {Promise<Element>} Input element
   */
  async function getInputElement() {
    return waitForElement(SELECTORS.input, { timeout: 5000 });
  }

  /**
   * Get the send button
   * @returns {Promise<Element>} Send button element
   */
  async function getSendButton() {
    return waitForElement(SELECTORS.sendButton, { timeout: 5000 });
  }

  /**
   * Find the stop button (non-throwing)
   * @returns {Element|null} Stop button if found and visible
   */
  function findStopButton() {
    return findElement(SELECTORS.stopButton, { visible: true });
  }

  /**
   * Find streaming indicator elements
   * @returns {Element|null} Streaming indicator if found
   */
  function findStreamingIndicator() {
    return findElement(SELECTORS.streamingIndicator, { visible: true });
  }

  // =============================================================================
  // GENERATION DETECTION
  // =============================================================================

  /**
   * Check if Claude is currently generating a response
   *
   * Key insight: The send button being disabled is NOT a reliable indicator
   * because Claude disables it when the input is empty (after generation completes).
   * We must rely on stop button and streaming indicators only.
   *
   * @returns {boolean} True if generating
   */
  function isGenerating() {
    // Method 1: Check for stop button (MOST RELIABLE)
    const stopButton = findStopButton();
    if (stopButton && isElementVisible(stopButton)) {
      log.debug('isGenerating: Stop button found');
      return true;
    }

    // Method 2: Check for any visible element with aria-label containing "Stop"
    const stopElements = document.querySelectorAll('button[aria-label*="Stop"]');
    for (const el of stopElements) {
      if (isElementVisible(el)) {
        log.debug('isGenerating: Stop button with aria-label found');
        return true;
      }
    }

    // Method 3: Check for streaming data attribute
    const streamingElements = document.querySelectorAll('[data-is-streaming="true"]');
    if (streamingElements.length > 0) {
      log.debug('isGenerating: Streaming attribute found');
      return true;
    }

    // Method 4: Check for streaming/typing indicators
    const streamingIndicator = findStreamingIndicator();
    if (streamingIndicator) {
      log.debug('isGenerating: Streaming indicator found');
      return true;
    }

    // Method 5: Check for loading spinner or animation (but not generic ones)
    const loadingElements = document.querySelectorAll(
      '[class*="loading"]:not([class*="loaded"]), ' +
      '[class*="spinner"], ' +
      '[class*="generating"]'
    );
    for (const el of loadingElements) {
      if (isElementVisible(el)) {
        log.debug('isGenerating: Loading indicator found');
        return true;
      }
    }

    // NOTE: We deliberately do NOT check if send button is disabled
    // because Claude disables it when input is empty (normal state after response)

    log.debug('isGenerating: Not generating');
    return false;
  }

  // =============================================================================
  // PROMPT OPERATIONS
  // =============================================================================

  /**
   * Inject a prompt into the Claude ProseMirror input
   * Uses retry logic for graceful failure handling
   *
   * ProseMirror requires special handling:
   * 1. Focus the element
   * 2. Clear existing content
   * 3. Use execCommand or set innerHTML with proper structure
   * 4. Dispatch input event
   *
   * @param {string} text - Prompt text to inject
   * @returns {Promise<void>}
   */
  async function injectPrompt(text) {
    log.info('Injecting prompt into Claude');

    return retryDOMOperation(async () => {
      const input = await getInputElement();

      if (!input) {
        throw new Error('Claude input element not found');
      }

      // Focus the input
      input.focus();
      await sleep(50);

      // Clear existing content
      input.innerHTML = '';

      // Method 1: Try document.execCommand (works well with ProseMirror)
      const execCommandSuccess = document.execCommand('insertText', false, text);

      if (!execCommandSuccess || input.textContent.trim() !== text.trim()) {
        // Method 2: Fallback to setting innerHTML with paragraph structure
        // ProseMirror expects content in paragraph tags
        log.debug('execCommand failed, using innerHTML fallback');

        // Split text by newlines and wrap each in a paragraph
        const paragraphs = text.split('\n').map(line => {
          if (line.trim() === '') {
            return '<p><br></p>';
          }
          return `<p>${line}</p>`;
        }).join('');

        input.innerHTML = paragraphs;
      }

      // Dispatch events for ProseMirror to pick up the change
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));

      // Also dispatch a generic input event
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // Dispatch composition events (ProseMirror sometimes needs these)
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: text
      }));

      // Wait for ProseMirror state to update
      await sleep(150);

      // Verify injection
      const inputText = input.textContent || '';
      if (inputText.length < Math.min(10, text.length)) {
        throw new Error('Prompt text verification failed - text may not have been injected');
      }

      log.info('Prompt injected successfully');
    }, {
      maxRetries: 3,
      baseDelay: 500,
      operationName: 'Claude prompt injection'
    });
  }

  /**
   * Submit the current prompt
   *
   * @returns {Promise<boolean>} True if submission was triggered
   */
  async function submitPrompt() {
    log.info('Submitting prompt');

    // Get send button
    const sendButton = await getSendButton();

    // Wait for button to be available (up to 2 seconds)
    let attempts = 0;
    while ((sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') && attempts < 20) {
      await sleep(100);
      attempts++;
    }

    if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
      log.warn('Send button still disabled after waiting');

      // Try alternative submission via Enter key
      const input = await getInputElement();
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));

      log.debug('Attempted Enter key submission');
      return true;
    }

    // Click the send button
    const clicked = clickButton(sendButton);

    if (clicked) {
      log.info('Prompt submitted via button click');
      return true;
    }

    // Fallback: try pressing Enter on the input
    log.debug('Button click may have failed, trying Enter key');
    const input = await getInputElement();

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));

    return true;
  }

  // =============================================================================
  // MESSAGE HANDLING
  // =============================================================================

  /**
   * Handle incoming messages from the service worker
   *
   * @param {Object} message - Message from background
   * @returns {Promise<Object>} Response object
   */
  async function handleMessage(message) {
    const { type, payload } = message;

    switch (type) {
      case 'INJECT_PROMPT': {
        log.debug('INJECT_PROMPT received, isProcessing:', window.PromptQueueCommon.isProcessing);
        if (window.PromptQueueCommon.isProcessing) {
          log.warn('Rejecting INJECT_PROMPT - already processing');
          return { error: 'Already processing a prompt' };
        }

        window.PromptQueueCommon.isProcessing = true;

        try {
          // Inject the prompt
          await injectPrompt(payload.prompt);

          // Submit it
          const submitted = await submitPrompt();

          if (submitted) {
            // Wait a moment for generation to start
            await sleep(300);

            // Notify background that generation started
            await sendToBackground('GENERATION_STARTED', {
              promptId: payload.id
            });

            // Start monitoring for completion
            startGenerationMonitor(isGenerating, {
              pollInterval: 500,
              timeout: 300000, // 5 minutes max
              observeTarget: SELECTORS.conversationArea[0]
            });

            return { submitted: true };
          } else {
            window.PromptQueueCommon.isProcessing = false;
            return { error: 'Failed to submit prompt' };
          }
        } catch (error) {
          window.PromptQueueCommon.isProcessing = false;
          log.error('Error handling INJECT_PROMPT:', error);
          throw error;
        }
      }

      case 'CHECK_STATUS': {
        return {
          isGenerating: isGenerating(),
          isProcessing: window.PromptQueueCommon.isProcessing,
          site: SITE_NAME
        };
      }

      case 'STOP_GENERATION': {
        const stopButton = findStopButton();
        if (stopButton) {
          clickButton(stopButton);
          return { stopped: true };
        }
        return { stopped: false, error: 'Stop button not found' };
      }

      case 'START_MONITORING': {
        // Start monitoring for generation completion (for manual sends)
        log.info('Starting generation monitor for manual send');
        window.PromptQueueCommon.isProcessing = true;

        startGenerationMonitor(isGenerating, {
          pollInterval: 500,
          timeout: 300000,
          observeTarget: SELECTORS.conversationArea[0]
        });

        return { monitoring: true };
      }

      default:
        return { error: `Unknown message type: ${type}` };
    }
  }

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  /**
   * Initialize the Claude content script
   */
  async function initialize() {
    log.info('Initializing Claude content script');

    // Set the current site
    window.PromptQueueCommon.currentSite = SITE_NAME;

    // Wait for the page to be ready
    try {
      await waitForElement(SELECTORS.input, { timeout: 30000 });
      inputFound = true;
      log.info('ProseMirror input found');
    } catch (error) {
      log.warn('Input not found during initialization, page may still be loading');
    }

    // Set up message listener
    setupMessageListener(handleMessage);

    // Notify background that we're ready (with retries for timing issues)
    try {
      await window.PromptQueueCommon.sendSiteReady(SITE_NAME);
      log.info('Site ready notification sent');
    } catch (error) {
      log.error('Failed to send SITE_READY:', error);
    }

    log.info('Claude content script initialized');
  }

  // Handle generation complete to reset processing state
  const originalSendToBackground = sendToBackground;
  window.PromptQueueCommon.sendToBackground = async function(type, data) {
    if (type === 'GENERATION_COMPLETE') {
      window.PromptQueueCommon.isProcessing = false;
      log.debug('Processing state reset after generation complete');
    }
    return originalSendToBackground(type, data);
  };

  // Run initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

})();
