import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './services/themeService';
import App from './App';

describe('App', () => {
  it('should render login page when not authenticated', () => {
    render(
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    );
    // When not authenticated, show login page
    expect(screen.getByText('登录你的账号')).toBeDefined();
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
