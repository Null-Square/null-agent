/* @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotFoundPage from './NotFoundPage';

describe('NotFoundPage', () => {
  it('renders a 404 message and return link', () => {
    render(
      <MemoryRouter initialEntries={['/missing-page']}>
        <NotFoundPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /page not found/i })).toBeTruthy();
    // The requested path is the only fact the page has, and half of these are
    // typos — seeing the address tells you which half you are in.
    expect(screen.getByText('/missing-page')).toBeTruthy();
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toBeTruthy();
  });
});
