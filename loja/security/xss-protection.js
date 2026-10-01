/**
 * XSS Protection Module
 * Sanitizes user input and output to prevent Cross-Site Scripting attacks
 */

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHTML(text) {
  if (typeof text !== 'string') return text;
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Sanitize HTML input - removes dangerous tags and attributes
 * Use only for rich text fields that need HTML
 */
function sanitizeHTML(html) {
  if (typeof html !== 'string') return html;

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Remove script tags completely
  const scripts = tmp.querySelectorAll('script');
  scripts.forEach(script => script.remove());

  // Remove event handlers from all elements
  const allElements = tmp.querySelectorAll('*');
  allElements.forEach(el => {
    // Remove all on* attributes (onclick, onload, etc)
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    });
  });

  return tmp.innerHTML;
}

/**
 * Validate and sanitize URL to prevent javascript: protocol attacks
 */
function sanitizeURL(url) {
  if (typeof url !== 'string') return '';

  // Allow only http, https, mailto, tel protocols
  const allowedProtocols = ['http://', 'https://', 'mailto:', 'tel:', '/'];
  const lowerURL = url.toLowerCase().trim();

  if (allowedProtocols.some(protocol => lowerURL.startsWith(protocol))) {
    return url;
  }

  return '';
}

/**
 * Validate image URL
 */
function validateImageURL(url) {
  if (!url || typeof url !== 'string') return '';

  const sanitized = sanitizeURL(url);
  if (!sanitized) return '';

  // Must be image file
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
  const hasImageExt = imageExtensions.some(ext => sanitized.toLowerCase().includes(ext));

  if (!hasImageExt && !sanitized.includes('supabase') && !sanitized.includes('cdn')) {
    return '';
  }

  return sanitized;
}

/**
 * Validate email format
 */
function validateEmail(email) {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Validate phone format (Brazil)
 */
function validatePhoneBR(phone) {
  if (typeof phone !== 'string') return false;
  const phoneRegex = /^[\d\s()+-]{10,}$/;
  return phoneRegex.test(phone.trim());
}

/**
 * Sanitize user-provided text for safe display
 */
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return escapeHTML(text.trim());
}

/**
 * Validate JSON to prevent injection
 */
function validateJSON(jsonString) {
  if (typeof jsonString !== 'string') return null;
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.warn('Invalid JSON:', e);
    return null;
  }
}

/**
 * Safe console logging for debugging (removes sensitive data)
 */
function safeLog(message, data) {
  if (process.env.NODE_ENV === 'production') return;

  // Don't log sensitive fields
  const sensitiveFields = ['password', 'token', 'key', 'secret', 'apiKey'];
  let safeData = { ...data };

  sensitiveFields.forEach(field => {
    if (safeData[field]) {
      safeData[field] = '[REDACTED]';
    }
  });

  console.log(message, safeData);
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHTML,
    sanitizeHTML,
    sanitizeURL,
    validateImageURL,
    validateEmail,
    validatePhoneBR,
    sanitizeText,
    validateJSON,
    safeLog
  };
}
