/**
 * Load environment variables from .env file (development only)
 * In production, use actual environment variables from deployment platform
 */

// Check if running in browser or Node
const isBrowser = typeof window !== 'undefined';

if (!isBrowser && typeof process !== 'undefined') {
  // Node.js environment
  try {
    require('dotenv').config();
  } catch (e) {
    console.warn('dotenv not installed, using system environment variables');
  }
}

// Export configuration
const config = {
  supabase: {
    url: process.env.VITE_SUPABASE_URL || window?.SUPABASE_CONFIG?.url,
    key: process.env.VITE_SUPABASE_ANON_KEY || window?.SUPABASE_CONFIG?.publishableKey,
  },
  api: {
    url: process.env.VITE_API_URL || 'https://api.katalogohub.com',
  },
  environment: process.env.VITE_ENVIRONMENT || 'development',
};

// Validate required vars
if (!config.supabase.url) {
  throw new Error('VITE_SUPABASE_URL not configured. Copy .env.example to .env and fill in your Supabase URL.');
}
if (!config.supabase.key) {
  throw new Error('VITE_SUPABASE_ANON_KEY not configured. Copy .env.example to .env and fill in your Supabase key.');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = config;
}
