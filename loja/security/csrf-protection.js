/**
 * CSRF Protection Module
 * Implements token-based CSRF protection for forms
 */

const CSRFProtection = (() => {
  const TOKEN_KEY = 'csrf-token';
  const STORAGE_KEY = 'csrf-token-stored';

  /**
   * Generate a random CSRF token
   */
  function generateToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Initialize CSRF token for the session
   */
  function init() {
    let token = sessionStorage.getItem(TOKEN_KEY);

    if (!token) {
      token = generateToken();
      sessionStorage.setItem(TOKEN_KEY, token);
    }

    return token;
  }

  /**
   * Get current CSRF token
   */
  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || init();
  }

  /**
   * Inject CSRF token into form as hidden input
   */
  function injectTokenToForm(formElement) {
    if (!formElement || formElement.tagName !== 'FORM') {
      console.error('Invalid form element');
      return;
    }

    // Remove existing token field if present
    const existing = formElement.querySelector(`input[name="${TOKEN_KEY}"]`);
    if (existing) {
      existing.remove();
    }

    // Create and inject new token field
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = TOKEN_KEY;
    input.value = getToken();
    formElement.appendChild(input);
  }

  /**
   * Inject CSRF token as header for fetch requests
   */
  function getHeadersWithToken(headers = {}) {
    return {
      ...headers,
      'X-CSRF-Token': getToken(),
      'Content-Type': 'application/json'
    };
  }

  /**
   * Verify CSRF token (server-side or client-side check)
   */
  function verifyToken(submittedToken) {
    const storedToken = getToken();
    return submittedToken === storedToken;
  }

  /**
   * Setup CSRF protection for all forms
   */
  function setupFormProtection() {
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
      // Skip forms that are GET requests or external
      if (form.method.toUpperCase() !== 'GET' && !isExternalForm(form)) {
        injectTokenToForm(form);
      }
    });
  }

  /**
   * Check if form is external (different origin)
   */
  function isExternalForm(form) {
    if (!form.action) return false;
    const url = new URL(form.action, window.location.origin);
    return url.origin !== window.location.origin;
  }

  /**
   * Setup CSRF protection for fetch requests
   */
  function setupFetchProtection() {
    const originalFetch = window.fetch;

    window.fetch = function(...args) {
      const [resource, config = {}] = args;

      // Only add CSRF token for non-GET, same-origin requests
      if (config.method && config.method.toUpperCase() !== 'GET') {
        const url = new URL(resource, window.location.origin);
        if (url.origin === window.location.origin) {
          config.headers = getHeadersWithToken(config.headers);
        }
      }

      return originalFetch.apply(this, [resource, config]);
    };
  }

  // Public API
  return {
    init,
    getToken,
    verifyToken,
    injectTokenToForm,
    getHeadersWithToken,
    setupFormProtection,
    setupFetchProtection
  };
})();

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    CSRFProtection.init();
    CSRFProtection.setupFormProtection();
    CSRFProtection.setupFetchProtection();
  });
} else {
  CSRFProtection.init();
  CSRFProtection.setupFormProtection();
  CSRFProtection.setupFetchProtection();
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CSRFProtection;
}
