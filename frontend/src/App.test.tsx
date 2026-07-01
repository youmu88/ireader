import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './services/themeService';
import App from './App';

describe('App', () => {
  it('should render the bookshelf page in loading state by default', () => {
    render(
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    );
    // Initial render shows loading state before API responds
    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should render navigation links', () => {
    render(
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    );
    expect(screen.getByText('书架')).toBeDefined();
    expect(screen.getByText('设置')).toBeDefined();
  });

  it('should render app title', () => {
    render(
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    );
    expect(screen.getByText(/iReader/)).toBeDefined();
  });
});
