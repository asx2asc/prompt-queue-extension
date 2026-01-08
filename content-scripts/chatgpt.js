/**
 * LLM Prompt Queue - ChatGPT Content Script
 *
 * Handles prompt injection and submission for ChatGPT
 * Supports both chat.openai.com and chatgpt.com
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

  const SITE_NAME = 'chatgpt';

  /**
   * Selectors for ChatGPT interface elements
   * Updated January 2025 - ChatGPT uses contenteditable ProseMirror-like editor
   * IMPORTANT: Avoid matching elements inside canvas panels
   */
  const SELECTORS = {
    // Textarea/input selectors - prioritize main chat input, exclude canvas
    textarea: [
      '#prompt-textarea',                           // Primary textarea ID (still used)
      'div#prompt-textarea',                        // It's actually a div now
      '[id="prompt-textarea"]',                     // Generic ID selector
      'div[contenteditable="true"][id="prompt-textarea"]', // Contenteditable version
      // Exclude canvas areas for fallback selectors
      'form textarea[placeholder*="Message"]:not([class*="canvas"])',
      'form div[contenteditable="true"]:not([class*="canvas"])',
    ],

    // Send button selectors - MUST exclude stop button AND canvas areas
    sendButton: [
      'button[data-testid="send-button"]:not([aria-label*="Stop"])',  // Test ID but not stop
      'form button[aria-label="Send prompt"]',      // Inside form
      'form button[aria-label="Send message"]',     // Inside form
      '#composer-submit-button:not([data-testid="stop-button"])',  // ID but not stop
    ],

    // Stop/cancel generation button - main chat only
    stopButton: [
      'button[data-testid="stop-button"]',          // Test ID
      'form button[aria-label="Stop generating"]',  // Inside form
      'form button[aria-label="Stop streaming"]',   // Inside form
      'form button[aria-label="Stop"]',             // Inside form
    ],

    // Response/message containers
    responseContainer: [
      'div[data-message-author-role="assistant"]',  // Assistant messages
      '[data-message-author-role="assistant"]',     // Any element with this
      'div.agent-turn',                             // Agent turn container
    ],

    // Main conversation area
    conversationArea: [
      'main',
      'div[role="presentation"]',
    ]
  };

  // =============================================================================
  // STATE
  // =============================================================================

  /** Track the last response element for change detection */
  let lastResponseElement = null;

  // =============================================================================
  // DOM HELPERS
  // =============================================================================

  /**
   * Get the input element (textarea or contenteditable)
   * @returns {Promise<Element>} Input element
   */
  async function getInputElement() {
    return waitForElement(SELECTORS.textarea, { timeout: 5000 });
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
   * Find the latest response container
   * @returns {Element|null} Latest response element
   */
  function findLatestResponse() {
    const responses = document.querySelectorAll(SELECTORS.responseContainer[0]);
    return responses.length > 0 ? responses[responses.length - 1] : null;
  }

  // =============================================================================
  // GENERATION DETECTION
  // =============================================================================

  /**
   * Check if ChatGPT is currently generating a response
   *
   * @returns {boolean} True if generating
   */
  function isGenerating() {
    // Method 1: Check for stop button (most reliable indicator)
    const stopButton = findStopButton();
    if (stopButton && isElementVisible(stopButton)) {
      log.debug('isGenerating: Stop button visible');
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

    // Method 3: Check for streaming/thinking indicators in the page
    // ChatGPT shows a pulsing dot or "ChatGPT is typing" indicator
    const thinkingIndicators = document.querySelectorAll(
      '[class*="thinking"], [class*="typing"], [class*="streaming"], ' +
      '[data-testid*="streaming"], [data-testid*="thinking"]'
    );
    for (const el of thinkingIndicators) {
      if (isElementVisible(el)) {
        log.debug('isGenerating: Thinking/streaming indicator found');
        return true;
      }
    }

    // Method 4: Check if the latest response has streaming class or is being updated
    const latestResponse = findLatestResponse();
    if (latestResponse) {
      // Check for result-streaming class
      if (latestResponse.classList.contains('result-streaming') ||
          latestResponse.querySelector('.result-streaming')) {
        log.debug('isGenerating: result-streaming class found');
        return true;
      }

      // Check for agent-turn with streaming
      const agentTurn = latestResponse.closest('.agent-turn');
      if (agentTurn && agentTurn.querySelector('[class*="streaming"]')) {
        log.debug('isGenerating: agent-turn streaming found');
        return true;
      }
    }

    // NOTE: We deliberately do NOT check if the send button is disabled
    // because ChatGPT disables it when the input is empty (normal state after response)
    // This was causing false positives where generation was detected as still in progress

    log.debug('isGenerating: Not generating');
    return false;
  }

  // =============================================================================
  // PROMPT OPERATIONS
  // =============================================================================

  /**
   * Inject a prompt into the ChatGPT input field
   * Uses retry logic for graceful failure handling
   *
   * @param {string} text - Prompt text to inject
   * @returns {Promise<void>}
   */
  async function injectPrompt(text) {
    log.info('Injecting prompt into ChatGPT');

    return retryDOMOperation(async () => {
      const input = await getInputElement();

      if (!input) {
        throw new Error('ChatGPT input element not found');
      }

      // Focus the input
      input.focus();

      // Small delay to ensure focus is registered
      await sleep(50);

      // Use simulateInput which handles both textarea and contenteditable
      simulateInput(input, text);

      // Additional event for ChatGPT's React state
      // ChatGPT sometimes needs a specific event to enable the send button
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

      // Wait a moment for React state to update
      await sleep(100);

      // Verify the text was injected
      const inputText = input.value || input.textContent || '';
      if (!inputText.includes(text.substring(0, 20))) {
        throw new Error('Prompt text verification failed - text may not have been injected');
      }

      log.info('Prompt injected successfully');
    }, {
      maxRetries: 3,
      baseDelay: 500,
      operationName: 'ChatGPT prompt injection'
    });
  }

  /**
   * Check if a button is the send button (not stop button)
   * ChatGPT uses the same button element but changes its attributes
   */
  function isSendButton(button) {
    if (!button) return false;
    const ariaLabel = button.getAttribute('aria-label') || '';
    const testId = button.getAttribute('data-testid') || '';
    // It's a send button if it's NOT a stop button
    const isStop = ariaLabel.toLowerCase().includes('stop') || testId.includes('stop');
    return !isStop && !button.disabled;
  }

  /**
   * Submit the current prompt
   * Uses retry logic for graceful failure handling
   *
   * @returns {Promise<boolean>} True if submission was triggered
   */
  async function submitPrompt() {
    log.info('Submitting prompt');

    return retryDOMOperation(async () => {
      // Wait for the send button to appear and be in "send" mode (not stop mode)
      // ChatGPT's button changes between send/stop dynamically
      let sendButton = null;
      let attempts = 0;

      while (attempts < 30) {  // Wait up to 3 seconds
        // Look for send button specifically (not stop button)
        const button = findElement(SELECTORS.sendButton);

        if (button && isSendButton(button)) {
          sendButton = button;
          break;
        }

        await sleep(100);
        attempts++;
      }

      // If no send button found, try Enter key
      if (!sendButton) {
        log.debug('Send button not found or in stop mode, trying Enter key');
        const input = await getInputElement();

        if (input) {
          // Make sure input has focus
          input.focus();
          await sleep(50);

          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          }));

          await sleep(200);
          log.info('Prompt submitted via Enter key');
          lastResponseElement = findLatestResponse();
          return true;
        }

        throw new Error('Send button not available and Enter key fallback failed');
      }

      // Click the send button
      const clicked = clickButton(sendButton);

      if (clicked) {
        log.info('Prompt submitted via send button');

        // Small delay then start monitoring for generation
        await sleep(200);

        // Store the current response element for change detection
        lastResponseElement = findLatestResponse();

        return true;
      }

      throw new Error('Failed to click send button');
    }, {
      maxRetries: 3,
      baseDelay: 500,
      operationName: 'ChatGPT prompt submission'
    });
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
            // Notify background that generation started
            await sendToBackground('GENERATION_STARTED', {
              promptId: payload.id
            });

            // Wait a moment for ChatGPT to start generating
            // This prevents false "complete" detection before generation starts
            await sleep(1500);

            // Now verify generation is happening or has completed
            const generating = isGenerating();
            log.info('After submit, isGenerating:', generating);

            // Start monitoring for completion
            startGenerationMonitor(isGenerating, {
              pollInterval: 1000,  // Check every 1 second
              timeout: 300000,     // 5 minutes max
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
          pollInterval: 1000,
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
   * Initialize the ChatGPT content script
   */
  async function initialize() {
    log.info('Initializing ChatGPT content script');

    // Set the current site
    window.PromptQueueCommon.currentSite = SITE_NAME;

    // Wait for the page to be ready
    await waitForElement(SELECTORS.textarea, { timeout: 30000 })
      .catch(() => {
        log.warn('Textarea not found during initialization, page may still be loading');
      });

    // Set up message listener
    setupMessageListener(handleMessage);

    // Notify background that we're ready (with retries for timing issues)
    try {
      await window.PromptQueueCommon.sendSiteReady(SITE_NAME);
      log.info('Site ready notification sent');
    } catch (error) {
      log.error('Failed to send SITE_READY:', error);
    }

    // Listen for generation completion to reset processing state
    const originalStartGenerationMonitor = window.PromptQueueCommon.startGenerationMonitor;
    // The monitor will call sendToBackground('GENERATION_COMPLETE') which resets state in background
    // We also need to reset local processing state when that happens

    // Set up a listener for when we send GENERATION_COMPLETE
    const originalSendToBackground = window.PromptQueueCommon.sendToBackground;
    // This is handled in common.js - just need to reset isProcessing flag

    log.info('ChatGPT content script initialized');
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
