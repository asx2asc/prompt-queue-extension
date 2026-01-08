/**
 * LLM Prompt Queue - AI Studio Content Script
 *
 * Handles prompt injection and submission for Google AI Studio (aistudio.google.com)
 * AI Studio uses Angular with Material Design components
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

  const SITE_NAME = 'aistudio';

  /**
   * Selectors for AI Studio interface elements
   * AI Studio is an Angular app with Material Design components
   */
  const SELECTORS = {
    // Input selectors
    input: [
      'textarea[aria-label*="prompt"]',             // Aria-labeled textarea
      'textarea[aria-label*="Type something"]',     // Alternative aria label
      'textarea.prompt-input',                       // Class-based
      'mat-form-field textarea',                    // Material form field
      'textarea[placeholder*="prompt"]',            // Placeholder-based
      'textarea[placeholder*="Type"]',              // Alternative placeholder
      'div[contenteditable="true"]',                // Contenteditable fallback
      'textarea',                                    // Generic textarea
    ],

    // Send/Run button selectors
    sendButton: [
      'button[aria-label*="Run"]',                  // Run button
      'button[aria-label*="Send"]',                 // Send button
      'button.run-button',                           // Class-based
      'button[mat-raised-button][color="primary"]', // Material primary button
      'button:has(mat-icon:contains("play"))',     // Play icon button
      'button:has(mat-icon:contains("send"))',     // Send icon button
      'button[type="submit"]',                      // Submit button
    ],

    // Stop button selectors
    stopButton: [
      'button[aria-label*="Stop"]',                 // Stop aria label
      'button[aria-label*="Cancel"]',               // Cancel aria label
      'button.stop-button',                          // Class-based
      'button:has(mat-icon:contains("stop"))',     // Stop icon button
    ],

    // Response/output containers
    responseContainer: [
      'ms-text-chunk',                               // Text chunk component
      '.response-container',                         // Response container class
      '.output-container',                           // Output container
      'div[class*="response"]',                     // Partial class match
      'div[class*="output"]',                       // Output class
      'pre',                                         // Code/text output
    ],

    // Conversation/output area
    conversationArea: [
      'main',
      '.chat-container',
      '.conversation-container',
      'div[class*="output"]',
      'div[class*="response"]',
    ],

    // Loading/generating indicators - be specific to avoid false positives
    loadingIndicator: [
      'mat-spinner',                                 // Material spinner
      'mat-progress-spinner',                        // Progress spinner
      'mat-progress-bar[mode="indeterminate"]',     // Indeterminate progress bar (active)
      '.loading-indicator',                          // Loading class
    ],

    // Status/generating text
    statusIndicator: [
      '[class*="status"]',                          // Status class
      '[class*="generating"]',                      // Generating text
      'span:contains("Generating")',                // Generating span
      'div:contains("Running")',                    // Running div
    ]
  };

  // =============================================================================
  // DOM HELPERS
  // =============================================================================

  /**
   * Get the input element (textarea)
   * @returns {Promise<Element>} Input element
   */
  async function getInputElement() {
    return waitForElement(SELECTORS.input, { timeout: 5000 });
  }

  /**
   * Get the send/run button
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

  // =============================================================================
  // GENERATION DETECTION
  // =============================================================================

  /** Track last response count for change detection */
  let lastResponseCount = 0;
  let lastResponseText = '';
  let responseChangeTimestamp = 0;

  /**
   * Check if AI Studio is currently generating a response
   *
   * AI Studio detection strategy:
   * 1. Check for stop button (if visible)
   * 2. Check for material spinners
   * 3. Check for streaming/typing cursor elements
   * 4. Check if response text is still changing (content-based detection)
   *
   * @returns {boolean} True if generating
   */
  function isGenerating() {
    // Method 1: Check for stop button
    const stopButton = findStopButton();
    if (stopButton && isElementVisible(stopButton)) {
      log.debug('isGenerating: Stop button found');
      return true;
    }

    // Method 2: Check for any visible button with Stop/Cancel aria-label
    const stopElements = document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]');
    for (const el of stopElements) {
      if (isElementVisible(el)) {
        log.debug('isGenerating: Stop/Cancel button found');
        return true;
      }
    }

    // Method 3: Check for material spinners (actual spinning elements)
    const spinners = document.querySelectorAll('mat-spinner, mat-progress-spinner');
    for (const spinner of spinners) {
      if (isElementVisible(spinner)) {
        log.debug('isGenerating: Material spinner found');
        return true;
      }
    }

    // Method 4: Check for indeterminate progress bars (actively animating)
    const progressBars = document.querySelectorAll('mat-progress-bar[mode="indeterminate"]');
    for (const bar of progressBars) {
      if (isElementVisible(bar)) {
        log.debug('isGenerating: Indeterminate progress bar found');
        return true;
      }
    }

    // Method 5: Check for streaming cursor/caret elements (AI Studio specific)
    const cursorElements = document.querySelectorAll(
      '.streaming-cursor, .typing-cursor, [class*="cursor"], ' +
      '.blinking-cursor, [class*="caret"], ms-caret'
    );
    for (const cursor of cursorElements) {
      if (isElementVisible(cursor)) {
        log.debug('isGenerating: Streaming cursor found');
        return true;
      }
    }

    // Method 6: Check for ms-text-chunk elements that are still being populated
    // AI Studio uses these custom elements for streaming text
    const textChunks = document.querySelectorAll('ms-text-chunk');
    if (textChunks.length > 0) {
      const lastChunk = textChunks[textChunks.length - 1];
      // Check if the chunk has streaming-related classes or attributes
      if (lastChunk.hasAttribute('data-streaming') ||
          lastChunk.classList.contains('streaming') ||
          lastChunk.closest('[data-streaming="true"]')) {
        log.debug('isGenerating: Streaming text chunk found');
        return true;
      }
    }

    // Method 7: Content-based detection - check if response text is still changing
    // This is a fallback for when no UI indicators are present
    const responseContainers = document.querySelectorAll('ms-text-chunk, .response-container, .model-response');
    let currentText = '';
    responseContainers.forEach(container => {
      currentText += container.textContent || '';
    });

    const now = Date.now();
    if (currentText !== lastResponseText && currentText.length > 0) {
      // Text is changing - update tracking
      lastResponseText = currentText;
      responseChangeTimestamp = now;
      log.debug('isGenerating: Response text is changing');
      return true;
    }

    // If text changed very recently (within 2 seconds), still consider generating
    if (responseChangeTimestamp > 0 && (now - responseChangeTimestamp) < 2000) {
      log.debug('isGenerating: Response changed recently');
      return true;
    }

    log.debug('isGenerating: Not generating');
    return false;
  }

  /**
   * Reset the response tracking state (call before sending new prompt)
   */
  function resetResponseTracking() {
    lastResponseText = '';
    responseChangeTimestamp = 0;
  }


  // =============================================================================
  // PROMPT OPERATIONS
  // =============================================================================

  /**
   * Inject a prompt into the AI Studio textarea
   *
   * AI Studio uses Angular, which requires proper event dispatching
   * to trigger change detection
   *
   * @param {string} text - Prompt text to inject
   * @returns {Promise<void>}
   */
  async function injectPrompt(text) {
    log.info('Injecting prompt into AI Studio');

    // Reset response tracking before injecting new prompt
    resetResponseTracking();

    const input = await getInputElement();

    // Focus the input
    input.focus();
    await sleep(50);

    // Check if it's a textarea or contenteditable
    if (input.tagName === 'TEXTAREA') {
      // Use native value setter for Angular compatibility
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, text);
      } else {
        input.value = text;
      }

      // Dispatch events for Angular
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // Angular-specific events
      input.dispatchEvent(new Event('ngModelChange', { bubbles: true }));

      // Trigger zone.js change detection
      const ngZoneEvent = new CustomEvent('input', {
        bubbles: true,
        cancelable: true,
        detail: { value: text }
      });
      input.dispatchEvent(ngZoneEvent);

    } else {
      // Contenteditable fallback
      input.innerHTML = '';
      const execCommandSuccess = document.execCommand('insertText', false, text);

      if (!execCommandSuccess) {
        input.textContent = text;
      }

      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
    }

    // Wait for Angular to process the change
    await sleep(150);

    log.info('Prompt injected successfully');
  }

  /**
   * Submit the current prompt (Run)
   *
   * @returns {Promise<boolean>} True if submission was triggered
   */
  async function submitPrompt() {
    log.info('Submitting prompt (Run)');

    // Get send/run button
    const sendButton = await getSendButton();

    // Wait for button to be available (up to 2 seconds)
    let attempts = 0;
    while ((sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') && attempts < 20) {
      await sleep(100);
      attempts++;
    }

    if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
      log.warn('Run button still disabled after waiting');

      // Try keyboard shortcut (Ctrl/Cmd + Enter is common for AI Studio)
      const input = await getInputElement();

      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        ctrlKey: true,
        metaKey: true, // For Mac
        bubbles: true,
        cancelable: true
      }));

      log.debug('Attempted Ctrl+Enter submission');
      return true;
    }

    // Click the run button
    const clicked = clickButton(sendButton);

    if (clicked) {
      log.info('Prompt submitted via Run button click');
      return true;
    }

    // Fallback: try keyboard shortcut
    log.debug('Button click may have failed, trying Ctrl+Enter');
    const input = await getInputElement();

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      ctrlKey: true,
      metaKey: true,
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
            // Wait longer for AI Studio to start generating
            // AI Studio can take 1-2 seconds before showing any response
            await sleep(1500);

            // Notify background that generation started
            await sendToBackground('GENERATION_STARTED', {
              promptId: payload.id
            });

            // Start monitoring for completion with longer poll interval
            // Content-based detection needs time between checks to see changes
            startGenerationMonitor(isGenerating, {
              pollInterval: 1000, // Check every 1 second for content changes
              timeout: 300000,    // 5 minutes max
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

        // Reset tracking to detect new response
        resetResponseTracking();

        startGenerationMonitor(isGenerating, {
          pollInterval: 1000, // Longer interval for content-based detection
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
   * Initialize the AI Studio content script
   */
  async function initialize() {
    log.info('Initializing AI Studio content script');

    // Set the current site
    window.PromptQueueCommon.currentSite = SITE_NAME;

    // Wait for the page to be ready
    try {
      await waitForElement(SELECTORS.input, { timeout: 30000 });
      log.info('Input textarea found');
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

    log.info('AI Studio content script initialized');
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
