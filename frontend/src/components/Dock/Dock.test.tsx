import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dock, type DockTab } from './Dock';

const tabs: DockTab[] = [
  { id: '/', label: '书架', icon: 'shelf' },
  { id: '/library', label: '图书管理', icon: 'library' },
  { id: '/settings', label: '设置', icon: 'settings' },
];

function renderDock(path = '/', hidden = false, onNavigate?: (path: string) => void) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Dock tabs={tabs} currentPath={path} hidden={hidden} onNavigate={onNavigate} />
    </MemoryRouter>
  );
}

describe('Dock', () => {
  it('renders all tab labels', () => {
    renderDock();
    expect(screen.getByText('书架')).toBeDefined();
    expect(screen.getByText('图书管理')).toBeDefined();
    expect(screen.getByText('设置')).toBeDefined();
  });

  it('highlights the active tab', () => {
    renderDock('/library');
    const active = screen.getByText('图书管理');
    expect(active.closest('button')?.getAttribute('data-active')).toBe('true');
    const inactive = screen.getByText('书架');
    expect(inactive.closest('button')?.getAttribute('data-active')).toBe('false');
  });

  it('calls onNavigate when a tab is clicked', () => {
    const onNavigate = vi.fn();
    renderDock('/', false, onNavigate);
    fireEvent.click(screen.getByText('设置'));
    expect(onNavigate).toHaveBeenCalledWith('/settings');
  });

  it('hides when hidden is true', () => {
    renderDock('/', true);
    const nav = document.querySelector('[data-testid="dock"]');
    expect(nav?.className).toContain('translate-y-full');
  });

  it('is visible when hidden is false', () => {
    renderDock('/', false);
    const nav = document.querySelector('[data-testid="dock"]');
    expect(nav?.className).not.toContain('translate-y-full');
  });
});
