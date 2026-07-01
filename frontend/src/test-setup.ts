import '@testing-library/jest-dom';
import '@testing-library/jest-dom';

// Polyfill IndexedDB for jsdom (used by offlineCacheService)
import 'fake-indexeddb/auto';

// Mock window.matchMedia for jsdom (used by themeService)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
