import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

import { LoadingSpinner } from '../../src/components/common/LoadingSpinner';
import { i18n } from '../../src/i18n';

afterEach(() => cleanup());

describe('LoadingSpinner', () => {
  it('shows the default loading message when none is given', () => {
    render(<LoadingSpinner />);
    expect(screen.getByText(i18n.t('common.loading'))).toBeInTheDocument();
  });

  it('shows a custom message when provided', () => {
    render(<LoadingSpinner message="Uploading your photo…" />);
    expect(screen.getByText('Uploading your photo…')).toBeInTheDocument();
  });

  it('renders inline (not fixed/fullscreen) by default', () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector('.fixed')).not.toBeInTheDocument();
  });

  it('covers the screen when fullscreen is requested', () => {
    const { container } = render(<LoadingSpinner fullscreen />);
    expect(container.querySelector('.fixed.inset-0')).toBeInTheDocument();
  });
});
