import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import BookshelfPage from '../BookshelfPage';

describe('BookshelfPage', () => {
  it('should render loading state initially', () => {
    render(
      <BrowserRouter>
        <BookshelfPage />
      </BrowserRouter>
    );
    expect(screen.getByText('加载中...')).toBeDefined();
  });
});
