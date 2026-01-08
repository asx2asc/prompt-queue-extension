/**
 * LLM Prompt Queue - Gemini Content Script
 *
 * Handles prompt injection and submission for Google Gemini (gemini.google.com)
 * Gemini uses a Quill-like rich text editor
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

  const SITE_NAME = 'gemini';

  /**
   * Selectors for Gemini interface elements
   * Gemini uses a custom Quill-like editor and has Angular-based components
   */
  const SELECTORS = {
    // Input selectors (Quill-like editor)
    input: [
      'rich-textarea .ql-editor',                   // Quill editor inside rich-textarea
      '.ql-editor[contenteditable="true"]',        // Quill editor directly
      'rich-textarea div[contenteditable="true"]', // Contenteditable in rich-textarea
      'div[contenteditable="true"][aria-label*="prompt"]', // Aria-labeled input
      'div[contenteditable="true"]',                // Generic contenteditable
      'textarea[aria-label*="prompt"]',            // Fallback textarea
    ],

    // Send button selectors
    sendButton: [
      'button[aria-label="Send message"]',         // Primary aria label
      'button[aria-label*="Send"]',                // Partial match
      '.send-button',                               // Class-based
      'button[data-test-id="send-button"]',        // Test ID
      'button.mdc-icon-button[aria-label*="Send"]', // Material icon button
      'button:has(mat-icon)',                      // Button with material icon
    ],

    // Stop button selectors
    stopButton: [
      'button[aria-label="Stop generating"]',      // Primary aria label
      'button[aria-label*="Stop"]',                // Partial match
      'button[data-test-id="stop-button"]',        // Test ID
      '.stop-button',                               // Class-based
    ],

    // Response/message containers
    responseContainer: [
      'message-content',                            // Custom element
      '.model-response-text',                       // Response text class
      'model-response',                             // Custom element
      '.response-container',                        // Container class
      'div[class*="response"]',                    // Partial class match
    ],

    // Conversation area
    conversationArea: [
      'main',
      '.conversation-container',
      'div[class*="conversation"]',
      'div[class*="chat"]',
    ],

    // Loading/streaming indicators
    loadingIndicator: [
      '.loading-indicator',                         // Loading class
      '.thinking-indicator',                        // Thinking indicator
      'mat-spinner',                                // Material spinner
      'mat-progress-spinner',                       // Progress spinner
      '[class*="loading"]',                        // Partial class match
      '[class*="spinner"]',                        // Spinner class
      '[class*="typing"]',                         // Typing indicator
    ]
  };

  // =============================================================================
  // DOM HELPERS
  // =============================================================================

  /**
   * Get the input element (Quill editor or contenteditable)
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
   * Find loading indicator elements
   * @returns {Element|null} Loading indicator if found
   */
  function findLoadingIndicator() {
    return findElement(SELECTORS.loadingIndicator, { visible: true });
  }

  /**
   * Check if the Quill API is available
   * @returns {Object|null} Quill instance if available
   */
  function getQuillInstance() {
    // Try to find Quill instance on the editor element
    const editor = document.querySelector('.ql-editor');
    if (editor) {
      const container = editor.closest('.ql-container');
      if (container && container.__quill) {
        return container.__quill;
      }
    }
    return null;
  }

  // =============================================================================
  // GENERATION DETECTION
  // =============================================================================

  /**
   * Check if Gemini is currently generating a response
   *
   * Key insight: The send button being disabled is NOT a reliable indicator
   * because Gemini disables it when the input is empty (after generation completes).
   * We must rely on stop button and loading indicators only.
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

    // Method 3: Check for loading indicators
    const loadingIndicator = findLoadingIndicator();
    if (loadingIndicator) {
      log.debug('isGenerating: Loading indicator found');
      return true;
    }

    // Method 4: Check for material spinners
    const spinners = document.querySelectorAll('mat-spinner, mat-progress-spinner');
    for (const spinner of spinners) {
      if (isElementVisible(spinner)) {
        log.debug('isGenerating: Material spinner found');
        return true;
      }
    }

    // Method 5: Check for "thinking" or "generating" text/elements
    const thinkingElements = document.querySelectorAll('[class*="thinking"], [class*="generating"], [class*="loading"]');
    for (const el of thinkingElements) {
      if (isElementVisible(el)) {
        log.debug('isGenerating: Thinking/generating element found');
        return true;
      }
    }

    // NOTE: We deliberately do NOT check if send button is disabled
    // because Gemini disables it when input is empty (normal state after response)

    log.debug('isGenerating: Not generating');
    return false;
  }

  // =============================================================================
  // PROMPT OPERATIONS
  // =============================================================================

  /**
   * Inject a prompt into the Gemini input
   *
   * Gemini uses a Quill-like editor, which requires special handling:
   * 1. Try Quill API if available
   * 2. Fall back to contenteditable manipulation
   *
   * @param {string} text - Prompt text to inject
   * @returns {Promise<void>}
   */
  async function injectPrompt(text) {
    log.info('Injecting prompt into Gemini');

    const input = await getInputElement();

    // Focus the input
    input.focus();
    await sleep(50);

    // Try Quill API first
    const quill = getQuillInstance();
    if (quill) {
      log.debug('Using Quill API for injection');
      quill.setText('');
      quill.insertText(0, text);
      await sleep(100);
      log.info('Prompt injected via Quill API');
      return;
    }

    // Fallback to contenteditable manipulation
    log.debug('Quill API not available, using contenteditable fallback');

    // Clear existing content
    input.innerHTML = '';
    await sleep(50);

    // For Quill-like editor, wrap content in paragraph
    if (input.classList.contains('ql-editor')) {
      input.innerHTML = `<p>${text}</p>`;
    } else {
      // Try execCommand first (works better with some frameworks)
      input.focus();
      const execCommandSuccess = document.execCommand('insertText', false, text);

      if (!execCommandSuccess || input.textContent.trim() !== text.trim()) {
        // Direct textContent fallback
        input.textContent = text;
      }
    }

    // Dispatch multiple events to trigger framework state updates
    // InputEvent for modern frameworks
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));

    // Generic events
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Simulate typing finished - this helps Angular detect changes
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));

    // Keyboard events to simulate real typing
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));

    // Wait longer for Angular change detection
    await sleep(300);

    // Verify text was injected
    const injectedText = input.textContent || input.innerText || '';
    if (!injectedText.includes(text.substring(0, 20))) {
      log.warn('Text verification failed, retrying with alternative method');
      input.innerHTML = `<p>${text}</p>`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
    }

    log.info('Prompt injected successfully');
  }

  /**
   * Submit the current prompt
   *
   * @returns {Promise<boolean>} True if submission was triggered
   */
  async function submitPrompt() {
    log.info('Submitting prompt');

    // Helper to check if button is disabled
    const isButtonDisabled = (btn) => {
      return btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    };

    // Wait for button to be enabled (up to 3 seconds)
    // Re-query the button each time since Angular may recreate elements
    let sendButton = null;
    let attempts = 0;
    while (attempts < 30) {
      sendButton = findElement(SELECTORS.sendButton);
      if (sendButton && !isButtonDisabled(sendButton)) {
        break;
      }
      await sleep(100);
      attempts++;
    }

    // If still no enabled button, try Enter key submission
    if (!sendButton || isButtonDisabled(sendButton)) {
      log.warn('Send button still disabled after waiting, trying Enter key');

      const input = await getInputElement();

      // Try Enter key submission
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));

      await sleep(100);

      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));

      log.info('Prompt submitted via Enter key');
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
        if (window.PromptQueueCommon.isProcessing) {
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
   * Initialize the Gemini content script
   */
  async function initialize() {
    log.info('Initializing Gemini content script');

    // Set the current site
    window.PromptQueueCommon.currentSite = SITE_NAME;

    // Wait for the page to be ready
    try {
      await waitForElement(SELECTORS.input, { timeout: 30000 });
      log.info('Quill editor found');
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

    log.info('Gemini content script initialized');
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
